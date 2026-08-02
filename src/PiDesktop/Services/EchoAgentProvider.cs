using PiAgent.Core.Agent;

namespace PiDesktop.Services;

/// <summary>
/// 占位模型后端：不接真模型，直接回显最后一条用户消息。
/// 让 UI 在没有 API key 时也能跑通「输入→历史→显示」链路。
/// 真正的 AnthropicAgentProvider（原生 C# agent 循环直连 Claude）在 pi-agent 侧后续填充。
/// </summary>
public sealed class EchoAgentProvider : IAgentProvider
{
    public string Id => "echo";

    public Task<AgentStep> StepAsync(
        IReadOnlyList<ChatMessage> conversation,
        IReadOnlyList<ToolDefinition> tools,
        CancellationToken ct = default)
    {
        var lastUser = conversation.LastOrDefault(m => m.Role == ChatRole.User);
        var text = lastUser is null
            ? "（占位后端）你好，我是 Pi Agent 的占位回显后端。配置真实模型后端后即可对话。"
            : $"（占位后端）收到：{lastUser.Content}";
        return Task.FromResult(new AgentStep(text, Array.Empty<ToolCall>()));
    }
}
