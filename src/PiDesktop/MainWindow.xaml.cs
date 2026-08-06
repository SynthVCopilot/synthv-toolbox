using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using PiDesktop.Views;

namespace PiDesktop;

public sealed partial class MainWindow : Window
{
    public static MainWindow? Instance { get; private set; }
    private Guid? _globalJobToken;

    public MainWindow()
    {
        InitializeComponent();
        Instance = this;
        ContentFrame.Navigate(typeof(ChatPage));
        Nav.SelectedItem = Nav.MenuItems[0];
    }

    public void NavigateTo(string tag)
    {
        var item = Nav.MenuItems
            .OfType<NavigationViewItem>()
            .FirstOrDefault(candidate => string.Equals(candidate.Tag as string, tag, StringComparison.Ordinal));

        if (item is null)
            return;

        if (ReferenceEquals(Nav.SelectedItem, item))
            ContentFrame.Navigate(PageFor(tag));
        else
            Nav.SelectedItem = item;
    }

    public Guid BeginGlobalJob(string message)
    {
        var token = Guid.NewGuid();
        _globalJobToken = token;
        GlobalJobBar.Message = message;
        GlobalJobBar.IsOpen = true;
        GlobalCancelButton.IsEnabled = true;
        return token;
    }

    public void UpdateGlobalJob(Guid token, string message)
    {
        if (_globalJobToken == token)
            GlobalJobBar.Message = message;
    }

    public void EndGlobalJob(Guid token)
    {
        if (_globalJobToken != token)
            return;
        _globalJobToken = null;
        GlobalJobBar.IsOpen = false;
    }

    private async void GlobalCancelButton_Click(object sender, RoutedEventArgs e)
    {
        var token = _globalJobToken;
        if (token is null)
            return;

        GlobalCancelButton.IsEnabled = false;
        var requested = await App.Ffmpeg.CancelCurrent();
        if (_globalJobToken == token)
        {
            GlobalJobBar.Message = requested
                ? "已请求取消；正在等待当前安全步骤结束。"
                : "任务可能已经结束。";
            GlobalCancelButton.IsEnabled = true;
        }
    }

    private void Nav_SelectionChanged(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
    {
        var tag = (args.SelectedItem as NavigationViewItem)?.Tag as string;
        ContentFrame.Navigate(PageFor(tag));
    }

    private static Type PageFor(string? tag) => tag switch
    {
        "chat" => typeof(ChatPage),
        "audio" => typeof(AudioPreparationPage),
        "history" => typeof(HistoryPage),
        "config" => typeof(AgentConfigPage),
        "components" => typeof(ComponentsPage),
        _ => typeof(ChatPage),
    };
}
