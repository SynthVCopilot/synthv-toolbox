using Microsoft.UI.Xaml.Controls;

namespace PiDesktop.Views;

public sealed partial class ComponentsPage : Page
{
    public ComponentsPage()
    {
        InitializeComponent();
        ComponentsList.ItemsSource = App.Agent.Host.Components; // ffmpeg / whisper / 音高模型 / Sound→MIDI
    }
}
