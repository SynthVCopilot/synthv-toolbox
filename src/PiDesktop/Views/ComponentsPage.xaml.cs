using Microsoft.UI.Xaml.Controls;
using PiDesktop.Models;
using PiDesktop.Services;

namespace PiDesktop.Views;

public sealed partial class ComponentsPage : Page
{
    private ComponentView? _ffmpeg;
    private Guid? _globalJobToken;
    private bool _busy;
    private bool _loaded;

    public ComponentsPage()
    {
        InitializeComponent();
        PlannedComponentsList.ItemsSource = App.Agent.Components()
            .Where(component => !string.Equals(component.Id, "ffmpeg", StringComparison.OrdinalIgnoreCase))
            .ToList();
    }

    private async void Page_Loaded(object sender, Microsoft.UI.Xaml.RoutedEventArgs e)
    {
        if (_loaded)
            return;
        _loaded = true;
        await RefreshAsync();
    }

    private async void RefreshButton_Click(object sender, Microsoft.UI.Xaml.RoutedEventArgs e) => await RefreshAsync();

    private async Task RefreshAsync()
    {
        try
        {
            var components = await App.Ffmpeg.RefreshStatusAsync();
            _ffmpeg = components.FirstOrDefault(component =>
                string.Equals(component.Spec.Id, "ffmpeg", StringComparison.OrdinalIgnoreCase));
            if (_ffmpeg is null)
            {
                FfmpegStatusText.Text = "当前运行时没有 FFmpeg 组件。请确认 Desktop 与 pi-agent 版本一致。";
                FfmpegDetailsText.Text = "状态不可用";
            }
            else
            {
                var status = _ffmpeg.Status;
                FfmpegStatusText.Text = DescribeStatus(status);
                FfmpegDetailsText.Text = BuildDetails(status);
                if (string.Equals(status.State, "failed", StringComparison.Ordinal) && !string.IsNullOrWhiteSpace(status.Error))
                    ShowInfo(InfoBarSeverity.Error, "FFmpeg 检查失败", status.Error);
            }
            UpdateButtons();
        }
        catch (Exception ex)
        {
            FfmpegStatusText.Text = "无法读取组件状态。";
            FfmpegDetailsText.Text = ex.Message;
            ShowInfo(InfoBarSeverity.Error, "读取组件状态失败", ex.Message);
            UpdateButtons();
        }
    }

    private async void InstallButton_Click(object sender, Microsoft.UI.Xaml.RoutedEventArgs e) =>
        await RunActionAsync("install", "安装", progress => App.Ffmpeg.InstallAsync(progress: progress));

    private async void UpdateButton_Click(object sender, Microsoft.UI.Xaml.RoutedEventArgs e) =>
        await RunActionAsync("update", "更新", progress => App.Ffmpeg.UpdateAsync(progress: progress));

    private async void UninstallButton_Click(object sender, Microsoft.UI.Xaml.RoutedEventArgs e) =>
        await RunActionAsync("uninstall", "卸载", progress => App.Ffmpeg.UninstallAsync(progress: progress));

    private async Task RunActionAsync(
        string action,
        string verb,
        Func<IProgress<JobStatus>, Task<JobStatus>> start)
    {
        if (_busy)
            return;
        if (App.Ffmpeg.IsBusy)
        {
            ShowInfo(InfoBarSeverity.Warning, "已有任务正在运行", "请等待音频处理或组件任务完成后再试。");
            return;
        }

        var content = action switch
        {
            "install" => "将下载并校验 Pi Desktop 的私有 FFmpeg 副本。不会修改系统 PATH。",
            "update" => "将更新 Pi Desktop 的私有 FFmpeg 副本。系统安装不会被修改。",
            _ => "只会移除 Pi Desktop 管理的私有 FFmpeg 副本。系统 FFmpeg、源音频和输出文件不会被删除。",
        };
        if (!await ConfirmAsync($"{verb} FFmpeg？", content, verb))
            return;

        _busy = true;
        ActionProgress.Visibility = Microsoft.UI.Xaml.Visibility.Visible;
        ActionProgress.IsIndeterminate = true;
        ActionStatusText.Visibility = Microsoft.UI.Xaml.Visibility.Visible;
        ActionStatusText.Text = $"正在{verb}…";
        CancelButton.Visibility = Microsoft.UI.Xaml.Visibility.Visible;
        BeginGlobalJob($"正在{verb} FFmpeg…");
        UpdateButtons();

        try
        {
            var progress = new Progress<JobStatus>(UpdateProgress);
            await start(progress);
            ShowInfo(
                InfoBarSeverity.Success,
                $"FFmpeg 已{verb}",
                action == "uninstall" ? "私有副本已移除。" : "本地组件现在可以使用。");
        }
        catch (FfmpegJobException ex)
        {
            if (string.Equals(ex.Status.State, "cancelled", StringComparison.Ordinal))
                ShowInfo(InfoBarSeverity.Informational, $"已取消{verb}", "组件状态没有被错误标记为成功。");
            else
                ShowInfo(InfoBarSeverity.Error, $"{verb}失败（{ex.Error?.Code ?? "unknown"}）", ex.Message);
        }
        catch (Exception ex)
        {
            ShowInfo(InfoBarSeverity.Error, $"{verb}失败", ex.Message);
        }
        finally
        {
            _busy = false;
            EndGlobalJob();
            ActionProgress.Visibility = Microsoft.UI.Xaml.Visibility.Collapsed;
            ActionStatusText.Visibility = Microsoft.UI.Xaml.Visibility.Collapsed;
            CancelButton.Visibility = Microsoft.UI.Xaml.Visibility.Collapsed;
            await RefreshAsync();
        }
    }

    private void UpdateProgress(JobStatus status)
    {
        ActionProgress.IsIndeterminate = status.Progress is null;
        if (status.Progress is { } progress)
            ActionProgress.Value = Math.Clamp(progress, 0, 1) * 100;
        ActionStatusText.Text = DescribePhase(status.Phase);
        UpdateGlobalJob(ActionStatusText.Text);
    }

    private async void CancelButton_Click(object sender, Microsoft.UI.Xaml.RoutedEventArgs e)
    {
        var requested = await App.Ffmpeg.CancelCurrent();
        ShowInfo(
            requested ? InfoBarSeverity.Informational : InfoBarSeverity.Warning,
            requested ? "已请求取消" : "没有可取消的任务",
            requested ? "正在等待当前安全步骤结束。" : "任务可能已经结束。");
    }

    private void OpenAudioPreparationButton_Click(object sender, Microsoft.UI.Xaml.RoutedEventArgs e) =>
        MainWindow.Instance?.NavigateTo("audio");

    private void UpdateButtons()
    {
        var status = _ffmpeg?.Status;
        var enabled = !_busy && !App.Ffmpeg.IsBusy;
        InstallButton.Visibility = status?.CanInstall == true
            ? Microsoft.UI.Xaml.Visibility.Visible
            : Microsoft.UI.Xaml.Visibility.Collapsed;
        UpdateButton.Visibility = status?.CanUpdate == true
            ? Microsoft.UI.Xaml.Visibility.Visible
            : Microsoft.UI.Xaml.Visibility.Collapsed;
        UninstallButton.Visibility = status?.CanUninstall == true
            ? Microsoft.UI.Xaml.Visibility.Visible
            : Microsoft.UI.Xaml.Visibility.Collapsed;
        InstallButton.IsEnabled = enabled;
        UpdateButton.IsEnabled = enabled;
        UninstallButton.IsEnabled = enabled;
    }

    private async Task<bool> ConfirmAsync(string title, string content, string primaryText)
    {
        var dialog = new ContentDialog
        {
            XamlRoot = XamlRoot,
            Title = title,
            Content = new TextBlock { Text = content, TextWrapping = Microsoft.UI.Xaml.TextWrapping.Wrap },
            PrimaryButtonText = primaryText,
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Close,
        };
        return await dialog.ShowAsync() == ContentDialogResult.Primary;
    }

    private void ShowInfo(InfoBarSeverity severity, string title, string message)
    {
        ComponentInfoBar.Severity = severity;
        ComponentInfoBar.Title = title;
        ComponentInfoBar.Message = message;
        ComponentInfoBar.IsOpen = true;
    }

    private void BeginGlobalJob(string message)
    {
        _globalJobToken = MainWindow.Instance?.BeginGlobalJob(message);
    }

    private void UpdateGlobalJob(string message)
    {
        if (_globalJobToken is { } token)
            MainWindow.Instance?.UpdateGlobalJob(token, message);
    }

    private void EndGlobalJob()
    {
        if (_globalJobToken is { } token)
            MainWindow.Instance?.EndGlobalJob(token);
        _globalJobToken = null;
    }

    private static string DescribeStatus(ComponentStatus status) => status.State switch
    {
        "ready" when status.Source == "managed" => $"Pi Desktop 私有 FFmpeg 已就绪（{status.InstalledVersion ?? "版本未知"}）。",
        "ready" when status.Source == "system" => $"正在使用系统 FFmpeg（{status.InstalledVersion ?? "版本未知"}）；Pi Desktop 不会卸载它。",
        "ready" when status.Source == "explicit" => $"正在使用配置目录中的 FFmpeg（{status.InstalledVersion ?? "版本未知"}）。",
        "checking" => "FFmpeg 正被另一个本地任务使用；任务结束后请刷新状态。",
        "downloading" => "正在下载 FFmpeg…",
        "verifying" => "正在校验 FFmpeg…",
        "installing" => "正在安装 FFmpeg…",
        "updating" => "正在更新 FFmpeg…",
        "uninstalling" => "正在卸载私有 FFmpeg…",
        "failed" => "FFmpeg 当前不可用。",
        _ => "尚未找到可用的 FFmpeg。可以安装 Pi Desktop 的私有副本。",
    };

    private static string BuildDetails(ComponentStatus status) =>
        $"来源：{DescribeSource(status.Source)}\n"
        + $"已用版本：{status.InstalledVersion ?? "—"}\n"
        + $"可用版本：{status.AvailableVersion ?? "—"}\n"
        + $"可执行文件目录：{status.ExecutableDir ?? "—"}"
        + (string.IsNullOrWhiteSpace(status.Error) ? string.Empty : $"\n错误：{status.Error}");

    private static string DescribeSource(string source) => source switch
    {
        "managed" => "Pi Desktop 私有安装",
        "system" => "系统 PATH",
        "explicit" => "用户配置目录",
        _ => "未找到",
    };

    private static string DescribePhase(string? phase) => phase switch
    {
        "queued" => "任务已排队…",
        "download" or "downloading" => "正在下载…",
        "verify" or "verifying" => "正在校验…",
        "install" or "installing" => "正在安装…",
        "update" or "updating" => "正在更新…",
        "uninstall" or "uninstalling" => "正在卸载…",
        "complete" => "已完成。",
        "cancelled" => "已取消。",
        "failed" => "任务失败。",
        _ => "正在处理…",
    };
}
