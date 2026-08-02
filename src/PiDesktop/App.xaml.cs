using Microsoft.UI.Xaml;
using PiDesktop.Services;

namespace PiDesktop;

/// <summary>应用入口。持有进程内的 <see cref="DesktopAgentService"/>（P/Invoke pi_agent.dll，Rust）。</summary>
public partial class App : Application
{
    private Window? _window;

    /// <summary>全局 agent 服务：桌面壳与 pi-agent 的唯一进程内通道。</summary>
    public static DesktopAgentService Agent { get; } = new();

    public App() => InitializeComponent();

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        _window = new MainWindow();
        _window.Activate();
    }
}
