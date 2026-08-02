using Microsoft.UI.Xaml.Controls;

namespace PiDesktop.Views;

public sealed partial class HistoryPage : Page
{
    public HistoryPage()
    {
        InitializeComponent();
        // 历史存储在 pi-agent (Rust) 侧；等 FFI 暴露 list/get 后接上。当前留空列表占位。
    }
}
