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
    [JsonPropertyName("display_name")] public string DisplayName { get; set; } = "";
    [JsonPropertyName("description")] public string Description { get; set; } = "";
    [JsonPropertyName("audience")] public string Audience { get; set; } = "";
}
