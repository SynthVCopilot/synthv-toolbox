using Microsoft.UI.Xaml.Controls;

namespace PiDesktop.Views;

public sealed partial class ComponentsPage : Page
{
    public ComponentsPage()
    {
        InitializeComponent();
        // 组件目录来自 pi-agent (Rust)：ffmpeg / whisper / 音高 / 人声分离 / 乐器 / 曲风 / 拍点 / Sound→MIDI
        ComponentsList.ItemsSource = App.Agent.Components();
    }
}
