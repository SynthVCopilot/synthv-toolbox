using System.Text.Json;
using PiDesktop.Models;

namespace PiDesktop.Services;

/// <summary>
/// 桌面壳与 pi-agent (Rust) 之间的**进程内**桥。持有原生 agent/bridge 句柄，
/// 对 UI 暴露「跑一轮对话」「连接桥」「列组件」。全部 P/Invoke 直调，无额外 IPC。
/// 配置读自 %LOCALAPPDATA%\PiAgent\config.json（机器本地，不入库）。
/// </summary>
public sealed class DesktopAgentService : IDisposable
{
    private readonly IntPtr _agent;
    private IntPtr _bridge; // 0 = 未连接
    private readonly List<ChatMessage> _current = new();
    private readonly object _sendLock = new();

    /// <summary>配置文件路径（统一数据根 ~/.SynthVcopilot）。</summary>
    public static string ConfigPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".SynthVcopilot", "config.json");

    /// <summary>当前 provider 标签（anthropic/echo），用于 UI 展示。</summary>
    public string ProviderLabel { get; }

    /// <summary>配置里的 synthv-agent-bridge 仓库路径（可为 null）。</summary>
    public string? BridgeRepoDir { get; }

    public DesktopAgentService()
    {
        string? configJson = null;
        if (File.Exists(ConfigPath))
        {
            try { configJson = File.ReadAllText(ConfigPath); } catch (IOException) { }
        }

        if (configJson is not null)
        {
            var check = NativeMethods.TakeString(NativeMethods.pi_config_check(configJson));
            if (check.Contains("\"ok\":true"))
            {
                _agent = NativeMethods.pi_agent_create_json(configJson);
                try
                {
                    using var doc = JsonDocument.Parse(configJson);
                    BridgeRepoDir = doc.RootElement.TryGetProperty("bridge_repo_dir", out var d) ? d.GetString() : null;
                }
                catch (JsonException) { }
            }
        }
        if (_agent == IntPtr.Zero)
        {
            _agent = NativeMethods.pi_agent_create(); // 无配置/配置坏 → echo 兜底
            ProviderLabel = "echo（未配置，编辑 " + ConfigPath + "）";
        }
        else
        {
            ProviderLabel = "anthropic（来自 config.json）";
        }
    }

    /// <summary>pi-agent 原生库版本。</summary>
    public string Version => NativeMethods.TakeString(NativeMethods.pi_agent_version());

    /// <summary>当前会话消息（只读视图）。</summary>
    public IReadOnlyList<ChatMessage> CurrentMessages => _current;

    /// <summary>桥是否已连接。</summary>
    public bool BridgeConnected => _bridge != IntPtr.Zero;

    /// <summary>跑一轮对话；桥已连接时把六个 sv_* 工具交给模型。</summary>
    public Task<IReadOnlyList<ChatMessage>> SendAsync(string input) => Task.Run(() =>
    {
        string json;
        lock (_sendLock) // 原生句柄单线程使用
        {
            json = NativeMethods.TakeString(
                NativeMethods.pi_agent_send_with_bridge(_agent, _bridge, input));
        }
        var shown = new List<ChatMessage>();
        if (json.TrimStart().StartsWith('['))
        {
            var added = JsonSerializer.Deserialize<List<ChatMessage>>(json) ?? new();
            foreach (var m in added)
                if (m.Role is "user" or "assistant" && m.Content.Length > 0)
                    shown.Add(m);
        }
        else
        {
            shown.Add(new ChatMessage { Role = "assistant", Content = $"（错误）{json}" });
        }
        _current.AddRange(shown);
        return (IReadOnlyList<ChatMessage>)shown;
    });

    /// <summary>连接 synthv-agent-bridge 并调一次 sv_status；返回状态文本。</summary>
    public Task<string> ConnectBridgeAsync(string bridgeRepoDir) => Task.Run(() =>
    {
        lock (_sendLock)
        {
            if (_bridge != IntPtr.Zero)
            {
                NativeMethods.pi_bridge_destroy(_bridge);
                _bridge = IntPtr.Zero;
            }
            var handle = NativeMethods.pi_bridge_connect(bridgeRepoDir);
            if (handle == IntPtr.Zero)
                return "连接失败：无法拉起 node dist/src/cli.js（检查路径与 npm run build）";
            _bridge = handle;
            return NativeMethods.TakeString(NativeMethods.pi_bridge_call(_bridge, "sv_status", "{}"));
        }
    });

    /// <summary>内置组件目录。</summary>
    public IReadOnlyList<ComponentSpec> Components()
    {
        var json = NativeMethods.TakeString(NativeMethods.pi_components_json());
        try { return JsonSerializer.Deserialize<List<ComponentSpec>>(json) ?? new(); }
        catch (JsonException) { return Array.Empty<ComponentSpec>(); }
    }

    public void Dispose()
    {
        if (_bridge != IntPtr.Zero) NativeMethods.pi_bridge_destroy(_bridge);
        if (_agent != IntPtr.Zero) NativeMethods.pi_agent_destroy(_agent);
    }
}
