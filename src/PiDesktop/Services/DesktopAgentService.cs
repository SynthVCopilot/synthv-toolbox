using PiAgent.Core;
using PiAgent.Core.Agent;

namespace PiDesktop.Services;

/// <summary>
/// 桌面壳与 pi-agent 之间的**进程内**桥。持有单个 <see cref="PiAgentHost"/>，
/// 对 UI 暴露「跑一轮对话」「读历史」「管组件」等操作。全部是方法调用+事件，无 IPC。
/// </summary>
public sealed class DesktopAgentService
{
    private readonly PiAgentHost _host;
    private readonly List<ChatMessage> _current = new();

    public DesktopAgentService()
    {
        var options = new PiAgentOptions
        {
            // 由「配置 Agent」页面填入 synthv-agent-bridge 仓库路径后启用桥。
            SynthVBridgeRepoDir = null,
            ProviderId = "echo",
        };
        _host = new PiAgentHost(options, new EchoAgentProvider());
    }

    /// <summary>当前会话消息（只读视图）。</summary>
    public IReadOnlyList<ChatMessage> CurrentMessages => _current;

    /// <summary>跑一轮对话，返回本轮新增消息。工具执行器暂用空实现（未连桥时）。</summary>
    public async Task<IReadOnlyList<ChatMessage>> SendAsync(string userInput, CancellationToken ct = default)
    {
        var loop = _host.CreateLoop(new NoToolsExecutor());
        return await loop.RunTurnAsync(_current, userInput, ct).ConfigureAwait(false);
    }

    /// <summary>访问历史存储，供「历史」页面渲染。</summary>
    public PiAgentHost Host => _host;

    private sealed class NoToolsExecutor : IToolExecutor
    {
        public IReadOnlyList<ToolDefinition> Tools => Array.Empty<ToolDefinition>();
        public Task<ToolResult> ExecuteAsync(ToolCall call, CancellationToken ct = default)
            => Task.FromResult(new ToolResult(call.Id, "{\"error\":\"未连接工具\"}", IsError: true));
    }
}
