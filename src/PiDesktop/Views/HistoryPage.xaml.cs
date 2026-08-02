using Microsoft.UI.Xaml.Controls;

namespace PiDesktop.Views;

public sealed partial class HistoryPage : Page
{
    public HistoryPage()
    {
        InitializeComponent();
        Loaded += async (_, _) =>
        {
            var items = await App.Agent.Host.History.ListAsync();
            ConversationsList.ItemsSource = items;
        };
    }
}
