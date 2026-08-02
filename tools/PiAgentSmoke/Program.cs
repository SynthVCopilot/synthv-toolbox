using System.Runtime.InteropServices;
using System.Text.Json;

// pi_agent.dll 冒烟测试：version → create → send ×2 → components → destroy。
// 任一步失败即非零退出。

var failures = 0;

string Take(nint p)
{
    if (p == 0) return "";
    try { return Marshal.PtrToStringUTF8(p) ?? ""; }
    finally { Native.pi_string_free(p); }
}

void Check(string name, bool ok, string detail = "")
{
    Console.WriteLine($"[{(ok ? "PASS" : "FAIL")}] {name}{(detail.Length > 0 ? " — " + detail : "")}");
    if (!ok) failures++;
}

// 1. 版本
var version = Take(Native.pi_agent_version());
Check("pi_agent_version", version.Length > 0, $"version={version}");

// 2. 句柄
var handle = Native.pi_agent_create();
Check("pi_agent_create", handle != 0);

// 3. 一轮对话（echo 后端）
var json1 = Take(Native.pi_agent_send(handle, "你好，Pi！"));
Check("pi_agent_send #1 returns JSON array", json1.TrimStart().StartsWith('['), json1);
try
{
    using var doc = JsonDocument.Parse(json1);
    var arr = doc.RootElement;
    Check("send #1: 2 messages (user+assistant)", arr.GetArrayLength() == 2, $"len={arr.GetArrayLength()}");
    Check("send #1: roles", arr[0].GetProperty("role").GetString() == "user"
                         && arr[1].GetProperty("role").GetString() == "assistant");
    Check("send #1: echo content", (arr[1].GetProperty("content").GetString() ?? "").Contains("你好，Pi！"));
}
catch (Exception e) { Check("send #1: parse", false, e.Message); }

// 4. 第二轮（验证会话在句柄里累积、UTF-8 编组稳定）
var json2 = Take(Native.pi_agent_send(handle, "second turn / 中文·emoji 🎵"));
Check("pi_agent_send #2", json2.Contains("🎵") && json2.TrimStart().StartsWith('['));

// 5. 组件目录
var components = Take(Native.pi_components_json());
try
{
    using var doc = JsonDocument.Parse(components);
    var ids = doc.RootElement.EnumerateArray()
        .Select(c => c.GetProperty("id").GetString()).ToArray();
    string[] expected = ["ffmpeg", "whisper-local", "game-pitch", "vocal-separation",
                         "instrument-id", "genre-id", "tempo-beat", "sound-to-midi"];
    Check("pi_components_json: 8 components", ids.Length == 8, string.Join(",", ids!));
    Check("pi_components_json: expected ids", expected.All(ids.Contains!));
}
catch (Exception e) { Check("components: parse", false, e.Message); }

// 6. 销毁 + 空句柄安全性
Native.pi_agent_destroy(handle);
var errJson = Take(Native.pi_agent_send(0, "should error"));
Check("null-handle send returns error JSON", errJson.Contains("error"), errJson);

Console.WriteLine(failures == 0 ? "\nALL PASS" : $"\n{failures} FAILURE(S)");
return failures == 0 ? 0 : 1;

internal static partial class Native
{
    private const string Dll = "pi_agent";

    [LibraryImport(Dll)] internal static partial nint pi_agent_version();
    [LibraryImport(Dll)] internal static partial nint pi_agent_create();
    [LibraryImport(Dll)] internal static partial void pi_agent_destroy(nint handle);
    [LibraryImport(Dll, StringMarshalling = StringMarshalling.Utf8)]
    internal static partial nint pi_agent_send(nint handle, string inputUtf8);
    [LibraryImport(Dll)] internal static partial nint pi_components_json();
    [LibraryImport(Dll)] internal static partial void pi_string_free(nint s);
}
