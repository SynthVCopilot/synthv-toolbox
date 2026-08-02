using System.Collections.ObjectModel;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Windows.System;
using PiAgent.Core.Agent;

namespace PiDesktop.Views;

public sealed partial class ChatPage : Page
{
    private readonly ObservableCollection<MessageVm> _messages = new();

    public ChatPage()
    {
        InitializeComponent();
        MessagesList.ItemsSource = _messages;
        foreach (var m in App.Agent.CurrentMessages)
            _messages.Add(MessageVm.From(m));
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
            foreach (var m in added)
                if (m.Role is ChatRole.User or ChatRole.Assistant)
                    _messages.Add(MessageVm.From(m));
        }
        finally { SendButton.IsEnabled = true; }
    }

    private sealed record MessageVm(string Role, string Content)
    {
        public static MessageVm From(ChatMessage m) => new(m.Role.ToString(), m.Content);
    }
}
