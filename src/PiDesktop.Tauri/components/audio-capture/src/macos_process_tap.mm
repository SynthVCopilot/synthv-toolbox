#import <Foundation/Foundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreAudio/AudioHardware.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <mutex>
#include <string>
#include <vector>

namespace {

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
    uint32_t sample_rate = 0;
    uint32_t channels = 0;
    uint32_t discontinuities = 0;
    uint64_t frames_written = 0;
    int32_t error = 0;
};

void emit_error(const char* stage, int32_t code, const std::string& message) {
    std::printf("{\"event\":\"error\",\"stage\":\"%s\",\"code\":%d,\"message\":\"%s\"}\n", stage, code, message.c_str());
    std::fflush(stdout);
}

WavHeader header_for(const Capture& capture, uint32_t data_size) {
    WavHeader header;
    header.channels = static_cast<uint16_t>(capture.channels);
    header.sample_rate = capture.sample_rate;
    header.block_align = static_cast<uint16_t>(header.channels * sizeof(int16_t));
    header.bytes_per_second = header.sample_rate * header.block_align;
    header.data_size = data_size;
    header.size = 36 + data_size;
    return header;
}

void finalize_file(Capture* capture) {
    if (!capture->file) return;
    const uint64_t data_bytes = capture->frames_written * capture->channels * sizeof(int16_t);
    const WavHeader header = header_for(*capture, static_cast<uint32_t>(std::min<uint64_t>(data_bytes, UINT32_MAX)));
    std::fseek(capture->file, 0, SEEK_SET);
    std::fwrite(&header, sizeof(header), 1, capture->file);
    std::fclose(capture->file);
    capture->file = nullptr;
}

void destroy(Capture* capture) {
    capture->stopped.store(true);
    if (capture->aggregate != kAudioObjectUnknown && capture->io_proc != nullptr) {
        AudioDeviceStop(capture->aggregate, capture->io_proc);
        AudioDeviceDestroyIOProcID(capture->aggregate, capture->io_proc);
        capture->io_proc = nullptr;
    }
    {
        std::lock_guard<std::mutex> guard(capture->mutex);
        finalize_file(capture);
    }
    if (capture->aggregate != kAudioObjectUnknown) {
        AudioHardwareDestroyAggregateDevice(capture->aggregate);
        capture->aggregate = kAudioObjectUnknown;
    }
    if (capture->tap != kAudioObjectUnknown) {
        if (@available(macOS 14.2, *)) AudioHardwareDestroyProcessTap(capture->tap);
        capture->tap = kAudioObjectUnknown;
    }
}

OSStatus capture_io(AudioObjectID, const AudioTimeStamp*, const AudioBufferList* input, const AudioTimeStamp*, AudioBufferList*, const AudioTimeStamp*, void* client) {
    auto* capture = static_cast<Capture*>(client);
    if (!capture || capture->stopped.load(std::memory_order_relaxed) || !input) return noErr;
    std::lock_guard<std::mutex> guard(capture->mutex);
    if (capture->stopped.load(std::memory_order_relaxed) || !capture->file) return noErr;
    const bool planar = (capture->format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0;
    const uint32_t channels = capture->channels;
    const uint32_t frames = input->mNumberBuffers == 0 ? 0 : input->mBuffers[0].mDataByteSize / std::max<uint32_t>(capture->format.mBytesPerFrame, 1);
    if (frames == 0) return noErr;
    std::vector<int16_t> pcm(static_cast<size_t>(frames) * channels);
    for (uint32_t frame = 0; frame < frames; ++frame) {
        for (uint32_t channel = 0; channel < channels; ++channel) {
            const uint32_t buffer_index = planar ? channel : 0;
            if (buffer_index >= input->mNumberBuffers || !input->mBuffers[buffer_index].mData) { capture->discontinuities++; return noErr; }
            const auto* base = static_cast<const uint8_t*>(input->mBuffers[buffer_index].mData);
            const size_t offset = static_cast<size_t>(frame) * (planar ? 1 : channels) + (planar ? 0 : channel);
            float value = 0.0f;
            if (capture->format.mBitsPerChannel == 32 && (capture->format.mFormatFlags & kAudioFormatFlagIsFloat)) {
                value = reinterpret_cast<const float*>(base)[offset];
            } else if (capture->format.mBitsPerChannel == 16) {
                value = reinterpret_cast<const int16_t*>(base)[offset] / 32768.0f;
            } else {
                capture->discontinuities++;
                return noErr;
            }
            value = std::max(-1.0f, std::min(1.0f, value));
            pcm[static_cast<size_t>(frame) * channels + channel] = static_cast<int16_t>(value * 32767.0f);
        }
    }
    if (std::fwrite(pcm.data(), sizeof(int16_t), pcm.size(), capture->file) != pcm.size()) {
        capture->error = -1;
        capture->stopped.store(true);
        return noErr;
    }
    capture->frames_written += frames;
    return noErr;
}

std::string status_message(const char* stage, OSStatus status) {
    char code[5] = {0, 0, 0, 0, 0};
    uint32_t raw = static_cast<uint32_t>(status);
    for (int i = 3; i >= 0; --i) {
        const char byte = static_cast<char>(raw & 0xff);
        code[i] = byte >= 32 && byte < 127 && byte != '"' && byte != '\\' ? byte : '?';
        raw >>= 8;
    }
    return std::string(stage) + " failed (OSStatus '" + code + "'). Make sure the target process is running and System Audio Recording is allowed for this app.";
}

Capture* start_capture(pid_t pid, const char* output_path) API_AVAILABLE(macos(14.2)) {
    auto* capture = new Capture();
    AudioObjectPropertyAddress process_address = {kAudioHardwarePropertyTranslatePIDToProcessObject, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    AudioObjectID process = kAudioObjectUnknown;
    UInt32 size = sizeof(process);
    OSStatus status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &process_address, sizeof(pid), &pid, &size, &process);
    if (status != noErr || process == kAudioObjectUnknown) {
        emit_error("start", status, "The target PID is not a Core Audio client; select a running process that outputs audio.");
        delete capture;
        return nullptr;
    }
    @autoreleasepool {
        CATapDescription* description = [[CATapDescription alloc] initStereoMixdownOfProcesses:@[@(process)]];
        description.name = @"Toneshuttle Process Tap";
        description.privateTap = YES;
        description.muteBehavior = CATapUnmuted;
        status = AudioHardwareCreateProcessTap(description, &capture->tap);
    }
    if (status != noErr) { emit_error("start", status, status_message("Creating the process tap", status)); destroy(capture); delete capture; return nullptr; }

    AudioObjectPropertyAddress uid_address = {kAudioTapPropertyUID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    CFStringRef tap_uid = nullptr;
    size = sizeof(tap_uid);
    status = AudioObjectGetPropertyData(capture->tap, &uid_address, 0, nullptr, &size, &tap_uid);
    if (status != noErr || !tap_uid) { emit_error("start", status, status_message("Reading the process tap UID", status)); destroy(capture); delete capture; return nullptr; }
    NSString* uid = (__bridge_transfer NSString*)tap_uid;
    NSDictionary* tap_entry = @{@kAudioSubTapUIDKey: uid};
    NSDictionary* aggregate_description = @{
        @kAudioAggregateDeviceNameKey: @"Toneshuttle Private Capture",
        @kAudioAggregateDeviceUIDKey: [NSUUID UUID].UUIDString,
        @kAudioAggregateDeviceIsPrivateKey: @YES,
        @kAudioAggregateDeviceTapListKey: @[tap_entry],
        @kAudioAggregateDeviceTapAutoStartKey: @NO,
    };
    status = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)aggregate_description, &capture->aggregate);
    if (status != noErr) { emit_error("start", status, status_message("Creating the private aggregate device", status)); destroy(capture); delete capture; return nullptr; }

    AudioObjectPropertyAddress format_address = {kAudioDevicePropertyStreamFormat, kAudioDevicePropertyScopeInput, kAudioObjectPropertyElementMain};
    size = sizeof(capture->format);
    status = AudioObjectGetPropertyData(capture->aggregate, &format_address, 0, nullptr, &size, &capture->format);
    if (status != noErr || capture->format.mSampleRate <= 0 || capture->format.mChannelsPerFrame == 0) {
        emit_error("start", status, status_message("Reading the tap stream format", status));
        destroy(capture); delete capture; return nullptr;
    }
    capture->sample_rate = static_cast<uint32_t>(capture->format.mSampleRate);
    capture->channels = capture->format.mChannelsPerFrame;

    capture->file = std::fopen(output_path, "wbx");
    if (!capture->file) { emit_error("start", errno, "Unable to create the capture WAV file."); destroy(capture); delete capture; return nullptr; }
    const WavHeader placeholder = header_for(*capture, 0);
    std::fwrite(&placeholder, sizeof(placeholder), 1, capture->file);

    status = AudioDeviceCreateIOProcID(capture->aggregate, capture_io, capture, &capture->io_proc);
    if (status == noErr) status = AudioDeviceStart(capture->aggregate, capture->io_proc);
    if (status != noErr) { emit_error("start", status, status_message("Starting the process tap", status)); destroy(capture); delete capture; return nullptr; }
    return capture;
}

}  // namespace

int main(int argc, char** argv) {
    pid_t pid = 0;
    const char* output_path = nullptr;
    for (int index = 1; index + 1 < argc; index += 2) {
        if (std::strcmp(argv[index], "--pid") == 0) pid = static_cast<pid_t>(std::strtol(argv[index + 1], nullptr, 10));
        else if (std::strcmp(argv[index], "--output") == 0) output_path = argv[index + 1];
    }
    if (pid <= 0 || output_path == nullptr) {
        emit_error("arguments", -50, "Usage: audio-capture --pid <pid> --output <new.wav>");
        return 2;
    }
    if (@available(macOS 14.2, *)) {
        Capture* capture = start_capture(pid, output_path);
        if (!capture) return 1;
        std::printf("{\"event\":\"ready\",\"sampleRate\":%u,\"channels\":%u,\"bitsPerSample\":16}\n", capture->sample_rate, capture->channels);
        std::fflush(stdout);

        std::string line;
        std::getline(std::cin, line);

        destroy(capture);
        const int32_t error = capture->error;
        const uint32_t sample_rate = capture->sample_rate, channels = capture->channels, discontinuities = capture->discontinuities;
        const uint64_t frames = capture->frames_written;
        delete capture;
        if (error != 0) { emit_error("capture", error, "Writing the capture WAV failed."); return 1; }
        if (frames == 0) { emit_error("capture", 0, "The process tap returned no audio frames; allow System Audio Recording for this app and make sure the process plays audio."); return 1; }
        std::printf("{\"event\":\"finished\",\"sampleRate\":%u,\"channels\":%u,\"bitsPerSample\":16,\"frames\":%llu,\"discontinuities\":%u}\n", sample_rate, channels, static_cast<unsigned long long>(frames), discontinuities);
        std::fflush(stdout);
        return 0;
    }
    emit_error("start", 0, "Core Audio process taps need macOS 14.2 or later.");
    return 1;
}
