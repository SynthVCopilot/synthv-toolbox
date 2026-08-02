using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using PiDesktop.Services;

namespace PiDesktop.Views;

public sealed partial class AgentConfigPage : Page
{
    public AgentConfigPage()
    {
        InitializeComponent();
        BridgeDirBox.Text = App.Agent.BridgeRepoDir ?? "";
        BridgeStatus.Text =
            $"provider: {App.Agent.ProviderLabel} · core v{App.Agent.Version} · 配置: {DesktopAgentService.ConfigPath}";
    }

    private async void TestBridge_Click(object sender, RoutedEventArgs e)
    {
        var dir = BridgeDirBox.Text?.Trim();
        if (string.IsNullOrEmpty(dir)) { BridgeStatus.Text = "请先填 synthv-agent-bridge 仓库路径"; return; }
        BridgeStatus.Text = "连接中…（拉起 node dist/src/cli.js 并调用 sv_status）";
        var result = await App.Agent.ConnectBridgeAsync(dir);
        BridgeStatus.Text = result.Length > 1200 ? result[..1200] + "…" : result;
    }
}
