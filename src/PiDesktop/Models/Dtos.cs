using System.Text.Json;
using System.Text.Json.Serialization;

namespace PiDesktop.Models;

/// <summary>对话消息 DTO：对应 pi-agent (Rust) 序列化出的 ChatMessage。</summary>
public sealed class ChatMessage
{
    [JsonPropertyName("role")] public string Role { get; set; } = "";
    [JsonPropertyName("content")] public string Content { get; set; } = "";
}

/// <summary>组件 DTO：对应 pi-agent (Rust) 的 ComponentSpec。</summary>
public sealed class ComponentSpec
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("kind")] public string Kind { get; set; } = "";
    [JsonPropertyName("display_name")] public string DisplayName { get; set; } = "";
    [JsonPropertyName("description")] public string Description { get; set; } = "";
    [JsonPropertyName("version")] public string Version { get; set; } = "";
    [JsonPropertyName("audience")] public string Audience { get; set; } = "";
    [JsonPropertyName("download_url")] public string DownloadUrl { get; set; } = "";
    [JsonPropertyName("sha256")] public string? Sha256 { get; set; }
    [JsonPropertyName("executable_relative_path")] public string? ExecutableRelativePath { get; set; }
}

/// <summary>Runtime state paired with a component catalog entry.</summary>
public sealed class ComponentView
{
    [JsonPropertyName("spec")] public ComponentSpec Spec { get; set; } = new();
    [JsonPropertyName("status")] public ComponentStatus Status { get; set; } = new();
}

/// <summary>Exact pi-agent component status JSON shape.</summary>
public sealed class ComponentStatus
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("state")] public string State { get; set; } = "not-installed";
    [JsonPropertyName("source")] public string Source { get; set; } = "unavailable";
    [JsonPropertyName("installed_version")] public string? InstalledVersion { get; set; }
    [JsonPropertyName("available_version")] public string? AvailableVersion { get; set; }
    [JsonPropertyName("executable_dir")] public string? ExecutableDir { get; set; }
    [JsonPropertyName("can_install")] public bool CanInstall { get; set; }
    [JsonPropertyName("can_update")] public bool CanUpdate { get; set; }
    [JsonPropertyName("can_uninstall")] public bool CanUninstall { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
}

/// <summary>Stable machine-readable failure emitted by a native background job.</summary>
public sealed class JobError
{
    [JsonPropertyName("code")] public string Code { get; set; } = "";
    [JsonPropertyName("message")] public string Message { get; set; } = "";
    [JsonPropertyName("details")] public string? Details { get; set; }
}

/// <summary>Pollable lifecycle or FFmpeg job state.</summary>
public sealed class JobStatus
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("state")] public string State { get; set; } = "queued";
    [JsonPropertyName("phase")] public string? Phase { get; set; }
    [JsonPropertyName("progress")] public float? Progress { get; set; }
    [JsonPropertyName("result")] public JsonElement? Result { get; set; }
    [JsonPropertyName("error")] public JobError? Error { get; set; }

    [JsonIgnore] public bool IsTerminal => State is "succeeded" or "failed" or "cancelled";
}

/// <summary>Result payload shared by all finite FFmpeg operations.</summary>
public sealed class FfmpegOperationResult
{
    [JsonPropertyName("output_path")] public string? OutputPath { get; set; }
    [JsonPropertyName("probe")] public FfmpegProbeResult? Probe { get; set; }
    [JsonPropertyName("loudness")] public LoudnessAnalysisResult? Loudness { get; set; }
}

/// <summary>Normalized facts for the selected input audio stream.</summary>
public sealed class FfmpegProbeResult
{
    [JsonPropertyName("container")] public string? Container { get; set; }
    [JsonPropertyName("codec")] public string? Codec { get; set; }
    [JsonPropertyName("duration_seconds")] public double? DurationSeconds { get; set; }
    [JsonPropertyName("sample_rate")] public uint? SampleRate { get; set; }
    [JsonPropertyName("channels")] public byte? Channels { get; set; }
    [JsonPropertyName("bit_depth")] public ushort? BitDepth { get; set; }
    [JsonPropertyName("bit_rate")] public ulong? BitRate { get; set; }
}

/// <summary>EBU R128 measurement values from FFmpeg.</summary>
public sealed class LoudnessAnalysisResult
{
    [JsonPropertyName("integrated_lufs")] public double? IntegratedLufs { get; set; }
    [JsonPropertyName("true_peak_db")] public double? TruePeakDb { get; set; }
    [JsonPropertyName("loudness_range")] public double? LoudnessRange { get; set; }
    [JsonPropertyName("threshold")] public double? Threshold { get; set; }
}

/// <summary>Base request JSON for a finite pi-agent FFmpeg operation.</summary>
public abstract class FfmpegRequest
{
    [JsonPropertyName("operation")] public abstract string Operation { get; }
    [JsonPropertyName("input")] public string Input { get; set; } = "";
}

public sealed class ProbeRequest : FfmpegRequest
{
    public override string Operation => "probe";
}

public sealed class PrepareRequest : FfmpegRequest
{
    public override string Operation => "prepare";
    [JsonPropertyName("output_name")] public string OutputName { get; set; } = "";
    [JsonPropertyName("sample_rate")] public uint? SampleRate { get; set; }
    [JsonPropertyName("channels")] public byte? Channels { get; set; }
    [JsonPropertyName("sample_format")] public string? SampleFormat { get; set; }
    [JsonPropertyName("start_seconds")] public double? StartSeconds { get; set; }
    [JsonPropertyName("duration_seconds")] public double? DurationSeconds { get; set; }
}

public sealed class LoudnessAnalyzeRequest : FfmpegRequest
{
    public override string Operation => "loudness_analyze";
}

public sealed class LoudnessNormalizeRequest : FfmpegRequest
{
    public override string Operation => "loudness_normalize";
    [JsonPropertyName("output_name")] public string OutputName { get; set; } = "";
    [JsonPropertyName("target_lufs")] public double TargetLufs { get; set; }
    [JsonPropertyName("max_true_peak_db")] public double MaxTruePeakDb { get; set; }
    [JsonPropertyName("target_lra")] public double TargetLra { get; set; }
}
