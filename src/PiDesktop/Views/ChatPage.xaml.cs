using System.Collections.ObjectModel;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Windows.System;
using PiDesktop.Models;

namespace PiDesktop.Views;

public sealed partial class ChatPage : Page
{
    private readonly ObservableCollection<ChatMessage> _messages = new();

    public ChatPage()
    {
        InitializeComponent();
        MessagesList.ItemsSource = _messages;
        foreach (var m in App.Agent.CurrentMessages)
            _messages.Add(m);
    }

    private async void SendButton_Click(object sender, Microsoft.UI.Xaml.RoutedEventArgs e) => await SendAsync();

    private async void InputBox_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        var ctrl = Microsoft.UI.Input.InputKeyboardSource
            .GetKeyStateForCurrentThread(VirtualKey.Control).HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
        if (e.Key == VirtualKey.Enter && ctrl) { e.Handled = true; await SendAsync(); }
    }

    private async Task SendAsync()
    {
        var text = InputBox.Text?.Trim();
        if (string.IsNullOrEmpty(text)) return;
        InputBox.Text = string.Empty;
        SendButton.IsEnabled = false;
        try
        {
            var added = await App.Agent.SendAsync(text);
            foreach (var m in added) _messages.Add(m);
        }
        finally { SendButton.IsEnabled = true; }
    }
}
