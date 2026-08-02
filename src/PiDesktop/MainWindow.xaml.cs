using Microsoft.UI.Xaml.Controls;
using PiDesktop.Views;

namespace PiDesktop;

public sealed partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
        ContentFrame.Navigate(typeof(ChatPage));
        Nav.SelectedItem = Nav.MenuItems[0];
    }

    private void Nav_SelectionChanged(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
    {
        var tag = (args.SelectedItem as NavigationViewItem)?.Tag as string;
        var page = tag switch
        {
            "chat" => typeof(ChatPage),
            "history" => typeof(HistoryPage),
            "config" => typeof(AgentConfigPage),
            "components" => typeof(ComponentsPage),
            _ => typeof(ChatPage),
        };
        ContentFrame.Navigate(page);
    }
}
