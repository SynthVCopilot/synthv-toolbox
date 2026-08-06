using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

// Non-GUI ABI smoke test. It deliberately never installs or updates FFmpeg.
var failures = 0;

string Take(nint p)
{
    if (p == 0) return "";
    try { return Marshal.PtrToStringUTF8(p) ?? ""; }
    finally { Native.pi_string_free(p); }
}

void Check(string name, bool ok, string detail = "")
{
    Console.WriteLine($"[{(ok ? "PASS" : "FAIL")}] {name}{(detail.Length > 0 ? " - " + detail : "")}");
    if (!ok) failures++;
}

JsonElement Status(SafePiJobHandle job)
{
    using var document = JsonDocument.Parse(Take(Native.pi_job_status_json(job.DangerousGetHandle())));
    return document.RootElement.Clone();
}

JsonElement PollToTerminal(SafePiJobHandle job)
{
    for (var attempt = 0; attempt != 100; attempt++)
    {
        var status = Status(job);
        var state = status.GetProperty("state").GetString();
        if (state is "succeeded" or "failed" or "cancelled") return status;
        Thread.Sleep(100);
    }
    throw new TimeoutException("FFmpeg job did not reach a terminal state within 10 seconds.");
}

var version = Take(Native.pi_agent_version());
Check("pi_agent_version", version.Length > 0, $"version={version}");

var handle = Native.pi_agent_create();
Check("pi_agent_create", handle != 0);
if (handle != 0)
{
    var json = Take(Native.pi_agent_send(handle, "smoke test"));
    Check("pi_agent_send returns JSON", json.TrimStart().StartsWith('['), json);
    Native.pi_agent_destroy(handle);
}

// The legacy catalog remains available, while the status endpoint supplies the
// dynamic FFmpeg source and capability fields used by Desktop.
var components = Take(Native.pi_components_json());
try
{
    using var document = JsonDocument.Parse(components);
    Check("pi_components_json is an array", document.RootElement.ValueKind == JsonValueKind.Array);
    Check("pi_components_json includes ffmpeg", document.RootElement.EnumerateArray()
        .Any(component => component.GetProperty("id").GetString() == "ffmpeg"));
}
catch (Exception error) { Check("pi_components_json parse", false, error.Message); }

var ffmpegIsSystemReady = false;
try
{
    using var document = JsonDocument.Parse(Take(Native.pi_components_status_json()));
    var ffmpeg = document.RootElement.EnumerateArray().Single(component =>
        component.GetProperty("spec").GetProperty("id").GetString() == "ffmpeg");
    var status = ffmpeg.GetProperty("status");
    var source = status.GetProperty("source").GetString();
    var state = status.GetProperty("state").GetString();
    Check("FFmpeg status shape", source is "explicit" or "managed" or "system" or "unavailable"
        && state is not null && status.TryGetProperty("can_install", out _), $"source={source}; state={state}");
    ffmpegIsSystemReady = source == "system" && state == "ready";
}
catch (Exception error) { Check("pi_components_status_json parse", false, error.Message); }

if (!ffmpegIsSystemReady)
{
    Console.WriteLine("[SKIP] FFmpeg probe: no healthy system FFmpeg pair was resolved; status parsing still passed.");
}
else
{
    var input = Path.Combine(Path.GetTempPath(), $"pi-agent-smoke-{Guid.NewGuid():N}.wav");
    var createdOutputs = new List<string>();
    try
    {
        using var ffmpeg = Process.Start(new ProcessStartInfo("ffmpeg", $"-hide_banner -loglevel error -f lavfi -i sine=frequency=440:duration=1 -y \"{input}\"")
        { UseShellExecute = false });
        ffmpeg!.WaitForExit();
        Check("create probe fixture", ffmpeg.ExitCode == 0 && File.Exists(input));

        JsonElement RunOperation(string label, object request)
        {
            using var job = new SafePiJobHandle(Native.pi_ffmpeg_job_start(JsonSerializer.Serialize(request)));
            Check($"{label} starts", !job.IsInvalid);
            if (job.IsInvalid) return default;
            var terminal = PollToTerminal(job);
            Check($"{label} succeeds", terminal.GetProperty("state").GetString() == "succeeded", terminal.ToString());
            return terminal;
        }

        var probe = RunOperation("FFmpeg probe", new { operation = "probe", input });
        var probeResult = probe.GetProperty("result").GetProperty("probe");
        Check("FFmpeg probe returns audio facts",
            probeResult.GetProperty("sample_rate").GetUInt32() > 0
            && probeResult.GetProperty("channels").GetByte() > 0);

        var preparedName = $"pi-agent-smoke-{Guid.NewGuid():N}-prepared.wav";
        var prepared = RunOperation("FFmpeg prepare", new
        {
            operation = "prepare",
            input,
            output_name = preparedName,
            sample_rate = 44_100,
            channels = 1,
            sample_format = "s24",
        });
        var preparedPath = prepared.GetProperty("result").GetProperty("output_path").GetString() ?? "";
        if (preparedPath.Length > 0) createdOutputs.Add(preparedPath);
        Check("FFmpeg prepare creates contained WAV", preparedPath.EndsWith(preparedName, StringComparison.OrdinalIgnoreCase)
            && File.Exists(preparedPath), preparedPath);

        var analysis = RunOperation("FFmpeg loudness analysis", new { operation = "loudness_analyze", input });
        var loudness = analysis.GetProperty("result").GetProperty("loudness");
        Check("FFmpeg loudness analysis returns finite metrics",
            double.IsFinite(loudness.GetProperty("integrated_lufs").GetDouble())
            && double.IsFinite(loudness.GetProperty("true_peak_db").GetDouble()));

        var normalizedName = $"pi-agent-smoke-{Guid.NewGuid():N}-normalized.wav";
        var normalized = RunOperation("FFmpeg loudness normalization", new
        {
            operation = "loudness_normalize",
            input,
            output_name = normalizedName,
            target_lufs = -16.0,
            max_true_peak_db = -1.5,
            target_lra = 11.0,
        });
        var normalizedPath = normalized.GetProperty("result").GetProperty("output_path").GetString() ?? "";
        if (normalizedPath.Length > 0) createdOutputs.Add(normalizedPath);
        Check("FFmpeg loudness normalization creates contained WAV",
            normalizedPath.EndsWith(normalizedName, StringComparison.OrdinalIgnoreCase)
            && File.Exists(normalizedPath), normalizedPath);
    }
    catch (Exception error) { Check("FFmpeg C-ABI operation sequence", false, error.Message); }
    finally
    {
        if (File.Exists(input)) File.Delete(input);
        foreach (var output in createdOutputs)
            if (File.Exists(output)) File.Delete(output);
    }
}

var nullHandleResult = Take(Native.pi_agent_send(0, "should error"));
Check("null-handle send returns error JSON", nullHandleResult.Contains("error"), nullHandleResult);

Console.WriteLine(failures == 0 ? "\nALL PASS" : $"\n{failures} FAILURE(S)");
return failures == 0 ? 0 : 1;

internal sealed class SafePiJobHandle : SafeHandle
{
    public SafePiJobHandle(nint handle) : base(0, ownsHandle: true) => SetHandle(handle);
    public override bool IsInvalid => handle == 0;
    protected override bool ReleaseHandle()
    {
        Native.pi_job_destroy(handle);
        return true;
    }
}

internal static partial class Native
{
    private const string Dll = "pi_agent";
    [LibraryImport(Dll)] internal static partial nint pi_agent_version();
    [LibraryImport(Dll)] internal static partial nint pi_agent_create();
    [LibraryImport(Dll)] internal static partial void pi_agent_destroy(nint handle);
    [LibraryImport(Dll, StringMarshalling = StringMarshalling.Utf8)] internal static partial nint pi_agent_send(nint handle, string inputUtf8);
    [LibraryImport(Dll)] internal static partial nint pi_components_json();
    [LibraryImport(Dll)] internal static partial nint pi_components_status_json();
    [LibraryImport(Dll, StringMarshalling = StringMarshalling.Utf8)] internal static partial nint pi_ffmpeg_job_start(string requestJson);
    [LibraryImport(Dll)] internal static partial nint pi_job_status_json(nint job);
    [LibraryImport(Dll)] internal static partial void pi_job_destroy(nint job);
    [LibraryImport(Dll)] internal static partial void pi_string_free(nint s);
}
