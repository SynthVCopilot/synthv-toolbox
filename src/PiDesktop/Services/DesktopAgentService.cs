using System.Text.Json;
using PiDesktop.Models;

namespace PiDesktop.Services;

/// <summary>
/// 桌面壳与 pi-agent (Rust) 之间的**进程内**桥。持有一个原生 agent 句柄，
/// 对 UI 暴露「跑一轮对话」「列组件」等操作。全部是 P/Invoke 直调，无 IPC/子进程。
/// </summary>
public sealed class DesktopAgentService : IDisposable
{
    private readonly IntPtr _handle = NativeMethods.pi_agent_create();
    private readonly List<ChatMessage> _current = new();

    /// <summary>pi-agent 原生库版本。</summary>
    public string Version => NativeMethods.TakeString(NativeMethods.pi_agent_version());

    /// <summary>当前会话消息（只读视图）。</summary>
    public IReadOnlyList<ChatMessage> CurrentMessages => _current;

    /// <summary>跑一轮对话，返回本轮要展示的新增消息（user/assistant）。</summary>
    public Task<IReadOnlyList<ChatMessage>> SendAsync(string input) => Task.Run(() =>
    {
        var json = NativeMethods.TakeString(NativeMethods.pi_agent_send(_handle, input));
        var shown = new List<ChatMessage>();
        if (json.TrimStart().StartsWith('['))
        {
            var added = JsonSerializer.Deserialize<List<ChatMessage>>(json) ?? new();
            foreach (var m in added)
                if (m.Role is "user" or "assistant")
                    shown.Add(m);
        }
        else
        {
            shown.Add(new ChatMessage { Role = "assistant", Content = $"（错误）{json}" });
        }
        _current.AddRange(shown);
        return (IReadOnlyList<ChatMessage>)shown;
    });

    /// <summary>内置组件目录（ffmpeg/whisper/音高/人声分离/乐器/曲风/拍点/Sound→MIDI）。</summary>
    public IReadOnlyList<ComponentSpec> Components()
    {
        var json = NativeMethods.TakeString(NativeMethods.pi_components_json());
        try { return JsonSerializer.Deserialize<List<ComponentSpec>>(json) ?? new(); }
        catch (JsonException) { return Array.Empty<ComponentSpec>(); }
    }

    public void Dispose()
    {
        if (_handle != IntPtr.Zero) NativeMethods.pi_agent_destroy(_handle);
    }
}
