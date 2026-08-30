#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <roapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <propidl.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <new>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

constexpr uint32_t kSampleRate = 48000;
constexpr uint16_t kChannels = 2;
constexpr uint16_t kBitsPerSample = 16;
constexpr DWORD kActivationTimeoutMs = 10000;

#pragma pack(push, 1)
struct WavHeader {
    char riff[4];
    uint32_t riff_size;
    char wave[4];
    char fmt[4];
    uint32_t fmt_size;
    uint16_t format_tag;
    uint16_t channels;
    uint32_t sample_rate;
    uint32_t avg_bytes_per_sec;
    uint16_t block_align;
    uint16_t bits_per_sample;
    char data[4];
    uint32_t data_size;
};
#pragma pack(pop)

struct CaptureStats {
    int32_t hresult;
    uint32_t sample_rate;
    uint32_t channels;
    uint32_t bits_per_sample;
    uint32_t discontinuities;
    uint64_t frames_written;
    uint64_t first_qpc_100ns;
    uint64_t last_qpc_100ns;
};

class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
public:
    explicit ActivationHandler(HANDLE completed) : completed_(completed) {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** value) override {
        if (value == nullptr) return E_POINTER;
        *value = nullptr;
        if (iid == __uuidof(IUnknown) || iid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
            *value = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
        } else if (iid == __uuidof(IAgileObject)) {
            *value = static_cast<IAgileObject*>(this);
        } else {
            return E_NOINTERFACE;
        }
        AddRef();
        return S_OK;
    }

    ULONG STDMETHODCALLTYPE AddRef() override { return ++references_; }

    ULONG STDMETHODCALLTYPE Release() override {
        const ULONG remaining = --references_;
        if (remaining == 0) delete this;
        return remaining;
    }

    HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
        HRESULT activation_result = E_UNEXPECTED;
        ComPtr<IUnknown> activated;
        result_ = operation->GetActivateResult(&activation_result, &activated);
        if (SUCCEEDED(result_)) result_ = activation_result;
        if (SUCCEEDED(result_)) result_ = activated.As(&audio_client_);
        SetEvent(completed_);
        return S_OK;
    }

    HRESULT result() const { return result_; }
    ComPtr<IAudioClient> audio_client() const { return audio_client_; }

private:
    std::atomic<ULONG> references_{1};
    HANDLE completed_ = nullptr;
    HRESULT result_ = E_PENDING;
    ComPtr<IAudioClient> audio_client_;
};

HRESULT write_all(HANDLE file, const void* data, DWORD size) {
    const auto* bytes = static_cast<const uint8_t*>(data);
    DWORD written_total = 0;
    while (written_total < size) {
        DWORD written = 0;
        if (!WriteFile(file, bytes + written_total, size - written_total, &written, nullptr)) {
            return HRESULT_FROM_WIN32(GetLastError());
        }
        if (written == 0) return E_FAIL;
        written_total += written;
    }
    return S_OK;
}

HRESULT write_header(HANDLE file, uint32_t data_size) {
    WavHeader header{
        {'R', 'I', 'F', 'F'},
        static_cast<uint32_t>(sizeof(WavHeader) - 8 + data_size),
        {'W', 'A', 'V', 'E'},
        {'f', 'm', 't', ' '},
        16,
        WAVE_FORMAT_PCM,
        kChannels,
        kSampleRate,
        kSampleRate * kChannels * (kBitsPerSample / 8),
        static_cast<uint16_t>(kChannels * (kBitsPerSample / 8)),
        kBitsPerSample,
        {'d', 'a', 't', 'a'},
        data_size,
    };
    LARGE_INTEGER origin{};
    if (!SetFilePointerEx(file, origin, nullptr, FILE_BEGIN)) {
        return HRESULT_FROM_WIN32(GetLastError());
    }
    return write_all(file, &header, sizeof(header));
}

HRESULT drain_packets(
    IAudioCaptureClient* capture,
    HANDLE file,
    const WAVEFORMATEX& format,
    CaptureStats* stats,
    uint32_t* data_size
) {
    UINT32 packet_frames = 0;
    HRESULT hr = capture->GetNextPacketSize(&packet_frames);
    while (SUCCEEDED(hr) && packet_frames > 0) {
        BYTE* data = nullptr;
        DWORD flags = 0;
        UINT64 device_position = 0;
        UINT64 qpc_position = 0;
        hr = capture->GetBuffer(
            &data,
            &packet_frames,
            &flags,
            &device_position,
            &qpc_position
        );
        if (FAILED(hr)) return hr;

        const uint64_t byte_count_64 = static_cast<uint64_t>(packet_frames) * format.nBlockAlign;
        if (byte_count_64 > MAXDWORD || static_cast<uint64_t>(*data_size) + byte_count_64 > MAXDWORD) {
            capture->ReleaseBuffer(packet_frames);
            return HRESULT_FROM_WIN32(ERROR_FILE_TOO_LARGE);
        }
        const DWORD byte_count = static_cast<DWORD>(byte_count_64);
        if ((flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0) {
            stats->discontinuities += 1;
        }
        if (stats->frames_written == 0) stats->first_qpc_100ns = qpc_position;
        stats->last_qpc_100ns = qpc_position;

        HRESULT write_result = S_OK;
        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || data == nullptr) {
            std::vector<uint8_t> silence(byte_count, 0);
            write_result = write_all(file, silence.data(), byte_count);
        } else {
            write_result = write_all(file, data, byte_count);
        }
        capture->ReleaseBuffer(packet_frames);
        if (FAILED(write_result)) return write_result;

        *data_size += byte_count;
        stats->frames_written += packet_frames;
        hr = capture->GetNextPacketSize(&packet_frames);
    }
    return hr;
}

void signal_failure(HANDLE failure_event, CaptureStats* stats, HRESULT hr) {
    stats->hresult = hr;
    SetEvent(failure_event);
}

}  // namespace

extern "C" int32_t synthv_capture_process_loopback(
    uint32_t process_id,
    const wchar_t* output_path,
    HANDLE ready_event,
    HANDLE failure_event,
    HANDLE stop_event,
    CaptureStats* stats
) {
    if (process_id == 0 || output_path == nullptr || ready_event == nullptr ||
        failure_event == nullptr || stop_event == nullptr || stats == nullptr) {
        return E_INVALIDARG;
    }
    *stats = {};
    stats->hresult = E_PENDING;
    stats->sample_rate = kSampleRate;
    stats->channels = kChannels;
    stats->bits_per_sample = kBitsPerSample;

    const HRESULT initialize_result = RoInitialize(RO_INIT_MULTITHREADED);
    const bool uninitialize = SUCCEEDED(initialize_result);
    if (FAILED(initialize_result) && initialize_result != RPC_E_CHANGED_MODE) {
        signal_failure(failure_event, stats, initialize_result);
        return initialize_result;
    }

    HANDLE activation_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    HANDLE sample_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (activation_event == nullptr || sample_event == nullptr) {
        const HRESULT hr = HRESULT_FROM_WIN32(GetLastError());
        if (activation_event != nullptr) CloseHandle(activation_event);
        if (sample_event != nullptr) CloseHandle(sample_event);
        if (uninitialize) RoUninitialize();
        signal_failure(failure_event, stats, hr);
        return hr;
    }

    auto* handler = new (std::nothrow) ActivationHandler(activation_event);
    if (handler == nullptr) {
        CloseHandle(activation_event);
        CloseHandle(sample_event);
        if (uninitialize) RoUninitialize();
        signal_failure(failure_event, stats, E_OUTOFMEMORY);
        return E_OUTOFMEMORY;
    }

    AUDIOCLIENT_ACTIVATION_PARAMS activation_params{};
    activation_params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    activation_params.ProcessLoopbackParams.TargetProcessId = process_id;
    activation_params.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT activate_variant{};
    activate_variant.vt = VT_BLOB;
    activate_variant.blob.cbSize = sizeof(activation_params);
    activate_variant.blob.pBlobData = reinterpret_cast<BYTE*>(&activation_params);

    ComPtr<IActivateAudioInterfaceAsyncOperation> activation_operation;
    HRESULT hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient),
        &activate_variant,
        handler,
        &activation_operation
    );
    if (SUCCEEDED(hr)) {
        const DWORD wait = WaitForSingleObject(activation_event, kActivationTimeoutMs);
        hr = wait == WAIT_OBJECT_0
            ? handler->result()
            : wait == WAIT_TIMEOUT ? HRESULT_FROM_WIN32(ERROR_TIMEOUT) : HRESULT_FROM_WIN32(GetLastError());
    }

    ComPtr<IAudioClient> audio_client;
    if (SUCCEEDED(hr)) audio_client = handler->audio_client();
    handler->Release();
    CloseHandle(activation_event);

    HANDLE file = INVALID_HANDLE_VALUE;
    ComPtr<IAudioCaptureClient> capture_client;
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = kChannels;
    format.nSamplesPerSec = kSampleRate;
    format.wBitsPerSample = kBitsPerSample;
    format.nBlockAlign = kChannels * (kBitsPerSample / 8);
    format.nAvgBytesPerSec = kSampleRate * format.nBlockAlign;

    if (SUCCEEDED(hr)) {
        hr = audio_client->Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            0,
            0,
            &format,
            nullptr
        );
    }
    if (SUCCEEDED(hr)) hr = audio_client->GetService(IID_PPV_ARGS(&capture_client));
    if (SUCCEEDED(hr)) hr = audio_client->SetEventHandle(sample_event);
    if (SUCCEEDED(hr)) {
        file = CreateFileW(
            output_path,
            GENERIC_WRITE,
            0,
            nullptr,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            nullptr
        );
        if (file == INVALID_HANDLE_VALUE) hr = HRESULT_FROM_WIN32(GetLastError());
    }
    if (SUCCEEDED(hr)) hr = write_header(file, 0);
    if (SUCCEEDED(hr)) hr = audio_client->Start();

    uint32_t data_size = 0;
    if (FAILED(hr)) {
        if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
        CloseHandle(sample_event);
        if (uninitialize) RoUninitialize();
        signal_failure(failure_event, stats, hr);
        return hr;
    }

    SetEvent(ready_event);
    HANDLE wait_handles[] = {stop_event, sample_event};
    bool stopping = false;
    while (!stopping) {
        const DWORD wait = WaitForMultipleObjects(2, wait_handles, FALSE, 1000);
        if (wait == WAIT_OBJECT_0) {
            stopping = true;
        } else if (wait == WAIT_OBJECT_0 + 1 || wait == WAIT_TIMEOUT) {
            hr = drain_packets(capture_client.Get(), file, format, stats, &data_size);
            if (FAILED(hr)) stopping = true;
        } else {
            hr = HRESULT_FROM_WIN32(GetLastError());
            stopping = true;
        }
    }

    const HRESULT stop_result = audio_client->Stop();
    if (SUCCEEDED(hr) && FAILED(stop_result)) hr = stop_result;
    const HRESULT drain_result = drain_packets(capture_client.Get(), file, format, stats, &data_size);
    if (SUCCEEDED(hr) && FAILED(drain_result)) hr = drain_result;
    const HRESULT header_result = write_header(file, data_size);
    if (SUCCEEDED(hr) && FAILED(header_result)) hr = header_result;
    if (!FlushFileBuffers(file) && SUCCEEDED(hr)) hr = HRESULT_FROM_WIN32(GetLastError());
    CloseHandle(file);
    CloseHandle(sample_event);
    if (uninitialize) RoUninitialize();

    stats->hresult = hr;
    return hr;
}
