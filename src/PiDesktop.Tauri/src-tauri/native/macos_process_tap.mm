#import <Foundation/Foundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreAudio/AudioHardware.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

struct SynthVProcessTapStats {
    int32_t hresult;
    uint32_t sample_rate;
    uint32_t channels;
    uint32_t bits_per_sample;
    uint32_t discontinuities;
    uint64_t frames_written;
    uint64_t first_qpc_100ns;
    uint64_t last_qpc_100ns;
};

struct WavHeader {
    char riff[4] = {'R', 'I', 'F', 'F'};
    uint32_t size = 36;
    char wave[4] = {'W', 'A', 'V', 'E'};
    char fmt[4] = {'f', 'm', 't', ' '};
    uint32_t fmt_size = 16;
    uint16_t format = 1;
    uint16_t channels = 2;
    uint32_t sample_rate = 48000;
    uint32_t bytes_per_second = 192000;
    uint16_t block_align = 4;
    uint16_t bits_per_sample = 16;
    char data[4] = {'d', 'a', 't', 'a'};
    uint32_t data_size = 0;
};

static_assert(sizeof(WavHeader) == 44, "PCM WAV header must be 44 bytes");

struct Capture {
    std::mutex mutex;
    std::atomic<bool> stopped{false};
    FILE* file = nullptr;
    AudioObjectID tap = kAudioObjectUnknown;
    AudioObjectID aggregate = kAudioObjectUnknown;
    AudioDeviceIOProcID io_proc = nullptr;
    AudioStreamBasicDescription format{};
    SynthVProcessTapStats* stats = nullptr;
    int32_t error = 0;
};

static void write_error(char* output, size_t capacity, const std::string& message) {
    if (output == nullptr || capacity == 0) return;
    std::snprintf(output, capacity, "%s", message.c_str());
}

static std::string status_message(const char* stage, OSStatus status) {
    char code[5] = {0, 0, 0, 0, 0};
    uint32_t raw = static_cast<uint32_t>(status);
    for (int i = 3; i >= 0; --i) { code[i] = static_cast<char>(raw & 0xff); raw >>= 8; }
    char text[192];
    std::snprintf(text, sizeof(text), "%s 失败（OSStatus %d / '%s'）。请确认 macOS 14.2+、目标 PID 仍在运行，并在系统设置中允许此应用录制系统音频。", stage, status, code);
    return text;
}

static void finalize_file(Capture* capture) {
    if (!capture->file) return;
    uint64_t data_bytes = capture->stats->frames_written * capture->stats->channels * sizeof(int16_t);
    WavHeader header;
    header.channels = static_cast<uint16_t>(capture->stats->channels);
    header.sample_rate = capture->stats->sample_rate;
    header.block_align = static_cast<uint16_t>(header.channels * sizeof(int16_t));
    header.bytes_per_second = header.sample_rate * header.block_align;
    header.data_size = static_cast<uint32_t>(std::min<uint64_t>(data_bytes, UINT32_MAX));
    header.size = 36 + header.data_size;
    std::fseek(capture->file, 0, SEEK_SET);
    std::fwrite(&header, sizeof(header), 1, capture->file);
    std::fclose(capture->file);
    capture->file = nullptr;
}

static void stop_and_destroy_io(Capture* capture) {
    if (capture->aggregate != kAudioObjectUnknown && capture->io_proc != nullptr) {
        AudioDeviceStop(capture->aggregate, capture->io_proc);
        AudioDeviceDestroyIOProcID(capture->aggregate, capture->io_proc);
        capture->io_proc = nullptr;
    }
}

static void destroy_container_resources(Capture* capture) {
    if (capture->aggregate != kAudioObjectUnknown) {
        AudioHardwareDestroyAggregateDevice(capture->aggregate);
        capture->aggregate = kAudioObjectUnknown;
    }
    if (capture->tap != kAudioObjectUnknown) {
        if (@available(macOS 14.2, *)) {
            AudioHardwareDestroyProcessTap(capture->tap);
        }
        capture->tap = kAudioObjectUnknown;
    }
}

static void cleanup_after_start_failure(Capture* capture) {
    capture->stopped.store(true);
    stop_and_destroy_io(capture);
    {
        std::lock_guard<std::mutex> guard(capture->mutex);
        finalize_file(capture);
    }
    destroy_container_resources(capture);
}

static int finish_capture(Capture* capture) {
    capture->stopped.store(true);
    stop_and_destroy_io(capture);
    int result;
    {
        std::lock_guard<std::mutex> guard(capture->mutex);
        finalize_file(capture);
        result = capture->error;
    }
    destroy_container_resources(capture);
    return result;
}

static OSStatus capture_io(AudioObjectID, const AudioTimeStamp*, const AudioBufferList* input, const AudioTimeStamp*, AudioBufferList*, const AudioTimeStamp*, void* client) {
    auto* capture = static_cast<Capture*>(client);
    if (!capture || capture->stopped.load(std::memory_order_relaxed) || !input) return noErr;
    std::lock_guard<std::mutex> guard(capture->mutex);
    if (capture->stopped.load(std::memory_order_relaxed) || !capture->file) return noErr;
    const uint32_t channels = capture->stats->channels;
    const uint32_t frames = input->mNumberBuffers == 0 ? 0 : input->mBuffers[0].mDataByteSize / std::max<uint32_t>(capture->format.mBytesPerFrame, 1);
    if (frames == 0) return noErr;
    std::vector<int16_t> pcm(static_cast<size_t>(frames) * channels);
    for (uint32_t frame = 0; frame < frames; ++frame) {
        for (uint32_t channel = 0; channel < channels; ++channel) {
            uint32_t buffer_index = capture->format.mFormatFlags & kAudioFormatFlagIsNonInterleaved ? channel : 0;
            if (buffer_index >= input->mNumberBuffers || !input->mBuffers[buffer_index].mData) { capture->stats->discontinuities++; return noErr; }
            const auto* base = static_cast<const uint8_t*>(input->mBuffers[buffer_index].mData);
            const uint32_t source_channel = capture->format.mFormatFlags & kAudioFormatFlagIsNonInterleaved ? 0 : channel;
            float value = 0.0f;
            if (capture->format.mBitsPerChannel == 32 && (capture->format.mFormatFlags & kAudioFormatFlagIsFloat)) {
                value = reinterpret_cast<const float*>(base)[frame * (capture->format.mFormatFlags & kAudioFormatFlagIsNonInterleaved ? 1 : channels) + source_channel];
            } else if (capture->format.mBitsPerChannel == 16) {
                value = reinterpret_cast<const int16_t*>(base)[frame * (capture->format.mFormatFlags & kAudioFormatFlagIsNonInterleaved ? 1 : channels) + source_channel] / 32768.0f;
            } else { capture->stats->discontinuities++; return noErr; }
            value = std::max(-1.0f, std::min(1.0f, value));
            pcm[static_cast<size_t>(frame) * channels + channel] = static_cast<int16_t>(value * 32767.0f);
        }
    }
    if (std::fwrite(pcm.data(), sizeof(int16_t), pcm.size(), capture->file) != pcm.size()) {
        capture->error = -1;
        capture->stats->hresult = -1;
        capture->stopped.store(true);
        return noErr;
    }
    capture->stats->frames_written += frames;
    return noErr;
}

extern "C" void* synthv_macos_process_tap_start(uint32_t process_id, const char* output_path, SynthVProcessTapStats* stats, char* error, size_t error_capacity) {
    if (@available(macOS 14.2, *)) {
        if (!output_path || !stats) { write_error(error, error_capacity, "macOS Process Tap 参数无效。"); return nullptr; }
        *stats = {};
        auto* capture = new Capture();
        capture->stats = stats;
        AudioObjectPropertyAddress process_address = { kAudioHardwarePropertyTranslatePIDToProcessObject, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
        pid_t pid = static_cast<pid_t>(process_id);
        AudioObjectID process = kAudioObjectUnknown;
        UInt32 size = sizeof(process);
        OSStatus status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &process_address, sizeof(pid), &pid, &size, &process);
        if (status != noErr || process == kAudioObjectUnknown) { write_error(error, error_capacity, "目标 PID 不是当前 Core Audio 客户端；请确认已选择正在运行并输出音频的 SynthV 进程。"); delete capture; return nullptr; }
        @autoreleasepool {
            CATapDescription* description = [[CATapDescription alloc] initStereoMixdownOfProcesses:@[@(process)]];
            description.name = @"SynthV Toolbox Process Tap";
            description.privateTap = YES;
            description.muteBehavior = CATapUnmuted;
            status = AudioHardwareCreateProcessTap(description, &capture->tap);
        }
        if (status != noErr) { write_error(error, error_capacity, status_message("创建 Core Audio Process Tap", status)); delete capture; return nullptr; }
        AudioObjectPropertyAddress uid_address = { kAudioTapPropertyUID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
        CFStringRef tap_uid = nullptr;
        size = sizeof(tap_uid);
        status = AudioObjectGetPropertyData(capture->tap, &uid_address, 0, nullptr, &size, &tap_uid);
        if (status != noErr || !tap_uid) { write_error(error, error_capacity, status_message("读取 Process Tap UID", status)); cleanup_after_start_failure(capture); delete capture; return nullptr; }
        NSString* uid = (__bridge_transfer NSString*)tap_uid;
        NSString* aggregate_uid = [NSUUID UUID].UUIDString;
        NSDictionary* tap_entry = @{ @kAudioSubTapUIDKey: uid };
        NSDictionary* aggregate_description = @{ @kAudioAggregateDeviceNameKey: @"SynthV Toolbox Private Capture", @kAudioAggregateDeviceUIDKey: aggregate_uid, @kAudioAggregateDeviceIsPrivateKey: @YES, @kAudioAggregateDeviceTapListKey: @[tap_entry], @kAudioAggregateDeviceTapAutoStartKey: @NO };
        status = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)aggregate_description, &capture->aggregate);
        if (status != noErr) { write_error(error, error_capacity, status_message("创建 Process Tap aggregate device", status)); cleanup_after_start_failure(capture); delete capture; return nullptr; }
        AudioObjectPropertyAddress format_address = { kAudioDevicePropertyStreamFormat, kAudioDevicePropertyScopeInput, kAudioObjectPropertyElementMain };
        size = sizeof(capture->format);
        status = AudioObjectGetPropertyData(capture->aggregate, &format_address, 0, nullptr, &size, &capture->format);
        if (status != noErr || capture->format.mSampleRate <= 0 || capture->format.mChannelsPerFrame == 0) { write_error(error, error_capacity, status_message("读取 Process Tap 音频格式", status)); cleanup_after_start_failure(capture); delete capture; return nullptr; }
        capture->stats->sample_rate = static_cast<uint32_t>(capture->format.mSampleRate);
        capture->stats->channels = capture->format.mChannelsPerFrame;
        capture->stats->bits_per_sample = 16;
        capture->file = std::fopen(output_path, "wb+");
        if (!capture->file) { write_error(error, error_capacity, "无法创建 Process Tap WAV 输出文件。"); cleanup_after_start_failure(capture); delete capture; return nullptr; }
        WavHeader placeholder;
        placeholder.channels = static_cast<uint16_t>(capture->stats->channels);
        placeholder.sample_rate = capture->stats->sample_rate;
        placeholder.block_align = static_cast<uint16_t>(placeholder.channels * sizeof(int16_t));
        placeholder.bytes_per_second = placeholder.sample_rate * placeholder.block_align;
        std::fwrite(&placeholder, sizeof(placeholder), 1, capture->file);
        status = AudioDeviceCreateIOProcID(capture->aggregate, capture_io, capture, &capture->io_proc);
        if (status == noErr) status = AudioDeviceStart(capture->aggregate, capture->io_proc);
        if (status != noErr) { capture->stats->hresult = status; write_error(error, error_capacity, status_message("启动 Process Tap", status)); cleanup_after_start_failure(capture); delete capture; return nullptr; }
        return capture;
    }
    write_error(error, error_capacity, "macOS Core Audio Process Tap 需要 macOS 14.2 或更高版本。");
    return nullptr;
}

extern "C" int synthv_macos_process_tap_stop(void* opaque) {
    auto* capture = static_cast<Capture*>(opaque);
    if (!capture) return 0;
    capture->stopped.store(true);
    if (capture->aggregate != kAudioObjectUnknown && capture->io_proc != nullptr) return AudioDeviceStop(capture->aggregate, capture->io_proc);
    return 0;
}

extern "C" int synthv_macos_process_tap_finish(void* opaque) {
    auto* capture = static_cast<Capture*>(opaque);
    if (!capture) return 0;
    int result = finish_capture(capture);
    delete capture;
    return result;
}
