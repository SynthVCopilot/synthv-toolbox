using System.Text.Json;
using System.Text.Json.Serialization;
using PiDesktop.Models;

namespace PiDesktop.Services;

/// <summary>
/// Process-wide, single-active-job access to pi-agent's component and FFmpeg job C ABI.
/// Native calls and polling run away from the WinUI thread; callers receive only
/// DTO snapshots through tasks and <see cref="IProgress{T}"/>.
/// </summary>
public sealed class FfmpegService : IDisposable
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(250);
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly object _jobLock = new();
    private PiJobHandle? _currentJob;
    private int _isBusy;
    private bool _cancelRequested;
    private volatile bool _disposed;

    /// <summary>True while one lifecycle or audio job owns the native executor.</summary>
    public bool IsBusy => Volatile.Read(ref _isBusy) != 0;

    /// <summary>Gets the latest state for every component without modifying it.</summary>
    public Task<IReadOnlyList<ComponentView>> RefreshStatusAsync(CancellationToken cancellationToken = default) =>
        Task.Run(() =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            ThrowIfDisposed();
            var json = NativeMethods.TakeString(NativeMethods.pi_components_status_json());
            IReadOnlyList<ComponentView> components =
                JsonSerializer.Deserialize<List<ComponentView>>(json, JsonOptions) ?? new List<ComponentView>();
            return components;
        }, cancellationToken);

    public Task<JobStatus> InstallAsync(string componentId = "ffmpeg", IProgress<JobStatus>? progress = null,
        CancellationToken cancellationToken = default) =>
        StartComponentActionAsync(componentId, "install", progress, cancellationToken);

    public Task<JobStatus> UpdateAsync(string componentId = "ffmpeg", IProgress<JobStatus>? progress = null,
        CancellationToken cancellationToken = default) =>
        StartComponentActionAsync(componentId, "update", progress, cancellationToken);

    public Task<JobStatus> UninstallAsync(string componentId = "ffmpeg", IProgress<JobStatus>? progress = null,
        CancellationToken cancellationToken = default) =>
        StartComponentActionAsync(componentId, "uninstall", progress, cancellationToken);

    public Task<FfmpegOperationResult> ProbeAsync(ProbeRequest request, IProgress<JobStatus>? progress = null,
        CancellationToken cancellationToken = default) => StartFfmpegAsync(request, progress, cancellationToken);

    public Task<FfmpegOperationResult> PrepareAsync(PrepareRequest request, IProgress<JobStatus>? progress = null,
        CancellationToken cancellationToken = default) => StartFfmpegAsync(request, progress, cancellationToken);

    public Task<FfmpegOperationResult> AnalyzeAsync(LoudnessAnalyzeRequest request, IProgress<JobStatus>? progress = null,
        CancellationToken cancellationToken = default) => StartFfmpegAsync(request, progress, cancellationToken);

    public Task<FfmpegOperationResult> NormalizeAsync(LoudnessNormalizeRequest request, IProgress<JobStatus>? progress = null,
        CancellationToken cancellationToken = default) => StartFfmpegAsync(request, progress, cancellationToken);

    /// <summary>Requests cancellation of the active native job. The final status still arrives through its task.</summary>
    public Task<bool> CancelCurrent() => Task.FromResult(CancelCurrentCore());

    private bool CancelCurrentCore()
    {
        PiJobHandle? job;
        lock (_jobLock)
        {
            if (_isBusy == 0)
                return false;
            job = _currentJob;
            if (job is null)
            {
                _cancelRequested = true;
                return true;
            }
        }
        if (job.IsInvalid || job.IsClosed) return false;

        var addedRef = false;
        try
        {
            try
            {
                job.DangerousAddRef(ref addedRef);
            }
            catch (ObjectDisposedException)
            {
                return false;
            }
            if (job.IsInvalid || job.IsClosed) return false;
            NativeMethods.pi_job_cancel(job.DangerousGetHandle());
            return true;
        }
        finally
        {
            if (addedRef) job.DangerousRelease();
        }
    }

    private Task<JobStatus> StartComponentActionAsync(string componentId, string action,
        IProgress<JobStatus>? progress, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(componentId);
        return RunExclusiveAsync(
            () => NativeMethods.pi_component_action_start(componentId, action), progress, cancellationToken);
    }

    private async Task<FfmpegOperationResult> StartFfmpegAsync(FfmpegRequest request,
        IProgress<JobStatus>? progress, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.Input);
        var requestJson = JsonSerializer.Serialize(request, request.GetType(), JsonOptions);
        var status = await RunExclusiveAsync(
            () => NativeMethods.pi_ffmpeg_job_start(requestJson), progress, cancellationToken).ConfigureAwait(false);
        if (status.Result is not { } result)
            return new FfmpegOperationResult();
        return result.Deserialize<FfmpegOperationResult>(JsonOptions) ?? new FfmpegOperationResult();
    }

    private Task<JobStatus> RunExclusiveAsync(Func<IntPtr> start, IProgress<JobStatus>? progress,
        CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        lock (_jobLock)
        {
            ThrowIfDisposed();
            if (_isBusy != 0)
                return Task.FromException<JobStatus>(new InvalidOperationException(
                    "Another FFmpeg or component job is already running."));
            _cancelRequested = false;
            Volatile.Write(ref _isBusy, 1);
        }

        return Task.Run(async () =>
        {
            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                ThrowIfDisposed();
                var raw = start();
                if (raw == IntPtr.Zero)
                    throw new InvalidOperationException("pi-agent could not start the requested background job.");

                using var job = new PiJobHandle(raw);
                bool cancelForDispose;
                lock (_jobLock)
                {
                    _currentJob = job;
                    cancelForDispose = _disposed || _cancelRequested;
                }
                if (cancelForDispose)
                    NativeMethods.pi_job_cancel(job.DangerousGetHandle());
                using var registration = cancellationToken.Register(static state =>
                    _ = ((FfmpegService)state!).CancelCurrent(), this);

                while (true)
                {
                    var json = NativeMethods.TakeString(NativeMethods.pi_job_status_json(job.DangerousGetHandle()));
                    var status = JsonSerializer.Deserialize<JobStatus>(json, JsonOptions)
                        ?? throw new InvalidOperationException("pi-agent returned an empty job status.");
                    progress?.Report(status);

                    if (status.IsTerminal)
                    {
                        if (status.State != "succeeded")
                        {
                            if (status.State == "cancelled" && cancellationToken.IsCancellationRequested)
                                throw new OperationCanceledException(cancellationToken);
                            throw new FfmpegJobException(status);
                        }
                        return status;
                    }
                    await Task.Delay(PollInterval, CancellationToken.None).ConfigureAwait(false);
                }
            }
            finally
            {
                lock (_jobLock)
                {
                    _currentJob = null;
                    _cancelRequested = false;
                    Volatile.Write(ref _isBusy, 0);
                }
            }
        }, CancellationToken.None);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _ = CancelCurrent();
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
    }
}

/// <summary>A failed or user-cancelled native job with its original structured status.</summary>
public sealed class FfmpegJobException : Exception
{
    public FfmpegJobException(JobStatus status)
        : base(status.Error?.Message ?? $"FFmpeg job ended with state '{status.State}'.") => Status = status;

    public JobStatus Status { get; }
    public JobError? Error => Status.Error;
}
