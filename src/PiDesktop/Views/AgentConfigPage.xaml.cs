using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace PiDesktop.Views;

public sealed partial class AgentConfigPage : Page
{
    public AgentConfigPage() => InitializeComponent();

    private async void TestBridge_Click(object sender, RoutedEventArgs e)
    {
        BridgeStatus.Text = "占位：待 pi-agent (Rust) 的 mcp 桥经 FFI 暴露后，这里将拉起 node dist/src/cli.js 并调用 sv_status。";
        await Task.CompletedTask;
    }
}
