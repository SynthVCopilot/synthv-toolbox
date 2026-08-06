using System.Diagnostics;
using System.Globalization;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using PiDesktop.Models;
using PiDesktop.Services;
using Windows.ApplicationModel.DataTransfer;
using Windows.Media.Core;
using Windows.Storage;
using Windows.Storage.Pickers;

namespace PiDesktop.Views;

public sealed partial class AudioPreparationPage : Page
{
    private ComponentView? _ffmpeg;
    private StorageFile? _inputFile;
    private FfmpegProbeResult? _probe;
    private LoudnessAnalysisResult? _inputLoudness;
    private LoudnessAnalysisResult? _outputLoudness;
    private string? _outputPath;
    private string _setupAction = "install";
    private Guid? _globalJobToken;
    private bool _operationRunning;
    private bool _loaded;

    public AudioPreparationPage() => InitializeComponent();

    private bool IsFfmpegReady => string.Equals(_ffmpeg?.Status.State, "ready", StringComparison.Ordinal);

    private async void Page_Loaded(object sender, RoutedEventArgs e)
    {
        if (_loaded)
            return;

        _loaded = true;
        UpdatePrepareSummary();
        await RefreshComponentStatusAsync();
    }

    private async Task RefreshComponentStatusAsync()
    {
        try
        {
            var components = await App.Ffmpeg.RefreshStatusAsync();
            _ffmpeg = components.FirstOrDefault(component =>
                string.Equals(component.Spec.Id, "ffmpeg", StringComparison.OrdinalIgnoreCase));

            if (_ffmpeg is null)
            {
                ComponentStatusText.Text = "当前运行时没有提供 FFmpeg 组件。";
                ComponentDetailsText.Text = "请确认 pi-agent 与 Desktop 来自同一版本。";
                InstallButton.Visibility = Visibility.Collapsed;
                UpdateTaskAvailability();
                return;
            }

            var status = _ffmpeg.Status;
            ComponentStatusText.Text = DescribeComponentStatus(status);
            ComponentDetailsText.Text = BuildComponentDetails(status);

            _setupAction = status.CanUpdate ? "update" : "install";
            InstallButton.Content = _setupAction == "update" ? "更新本地组件" : "安装本地组件";
            InstallButton.Visibility = status.CanInstall || status.CanUpdate
                ? Visibility.Visible
                : Visibility.Collapsed;
            InstallButton.IsEnabled = !_operationRunning;

            if (string.Equals(status.State, "failed", StringComparison.Ordinal) && !string.IsNullOrWhiteSpace(status.Error))
                ShowInfo(InfoBarSeverity.Error, "FFmpeg 组件不可用", status.Error);

            UpdateTaskAvailability();
            if (IsFfmpegReady && _inputFile is not null && _probe is null && !_operationRunning)
                await ProbeInputAsync();
        }
        catch (Exception ex)
        {
            ComponentStatusText.Text = "无法读取 FFmpeg 状态。";
            ComponentDetailsText.Text = ex.Message;
            InstallButton.Visibility = Visibility.Collapsed;
            UpdateTaskAvailability();
        }
    }

    private async void InstallButton_Click(object sender, RoutedEventArgs e)
    {
        if (_operationRunning)
            return;
        if (App.Ffmpeg.IsBusy)
        {
            ShowInfo(InfoBarSeverity.Warning, "已有任务正在运行", "请回到启动该任务的页面等待或取消，然后再试。");
            return;
        }

        var verb = _setupAction == "update" ? "更新" : "安装";
        var confirmed = await ConfirmAsync(
            $"{verb} FFmpeg 组件？",
            _setupAction == "update"
                ? "Pi Desktop 将更新自己的私有 FFmpeg 副本。系统 PATH 和系统安装不会被修改。"
                : "Pi Desktop 将下载并安装一个经过校验的私有 FFmpeg 副本。文件保存在当前用户目录中，不会修改系统 PATH。",
            verb);
        if (!confirmed)
            return;

        _operationRunning = true;
        SetInteractiveState();
        SetupProgress.Visibility = Visibility.Visible;
        SetupProgress.IsIndeterminate = true;
        SetupCancelButton.Visibility = Visibility.Visible;
        ComponentStatusText.Text = $"正在{verb}…";
        BeginGlobalJob($"正在{verb} FFmpeg…");

        var progress = new Progress<JobStatus>(UpdateSetupProgress);
        try
        {
            if (_setupAction == "update")
                await App.Ffmpeg.UpdateAsync(progress: progress);
            else
                await App.Ffmpeg.InstallAsync(progress: progress);

            ShowInfo(InfoBarSeverity.Success, $"FFmpeg 已{verb}", "现在可以在本机检测和处理音频。源文件不会被修改。");
        }
        catch (FfmpegJobException ex)
        {
            ShowJobFailure(ex, $"{verb} FFmpeg");
        }
        catch (Exception ex)
        {
            ShowInfo(InfoBarSeverity.Error, $"无法{verb} FFmpeg", ex.Message);
        }
        finally
        {
            _operationRunning = false;
            EndGlobalJob();
            SetupProgress.Visibility = Visibility.Collapsed;
            SetupCancelButton.Visibility = Visibility.Collapsed;
            SetInteractiveState();
            await RefreshComponentStatusAsync();
        }
    }

    private async void RefreshComponentButton_Click(object sender, RoutedEventArgs e)
    {
        if (!_operationRunning)
            await RefreshComponentStatusAsync();
    }

    private async void ChooseFileButton_Click(object sender, RoutedEventArgs e)
    {
        if (_operationRunning)
            return;

        var picker = new FileOpenPicker
        {
            ViewMode = PickerViewMode.List,
            SuggestedStartLocation = PickerLocationId.MusicLibrary,
        };
        picker.FileTypeFilter.Add("*");
        InitializePicker(picker);

        var file = await picker.PickSingleFileAsync();
        if (file is not null)
            await SelectInputAsync(file);
    }

    private void InputCard_DragOver(object sender, DragEventArgs e)
    {
        if (_operationRunning || !e.DataView.Contains(StandardDataFormats.StorageItems))
            return;

        e.AcceptedOperation = DataPackageOperation.Copy;
        e.DragUIOverride.Caption = "使用此文件";
        e.DragUIOverride.IsCaptionVisible = true;
    }

    private async void InputCard_Drop(object sender, DragEventArgs e)
    {
        if (_operationRunning || !e.DataView.Contains(StandardDataFormats.StorageItems))
            return;

        var items = await e.DataView.GetStorageItemsAsync();
        var files = items.OfType<StorageFile>().ToList();
        if (files.Count != 1)
        {
            ShowInfo(InfoBarSeverity.Warning, "请选择一个文件", "当前版本一次只处理一个本地文件。");
            return;
        }

        await SelectInputAsync(files[0]);
    }

    private async Task SelectInputAsync(StorageFile file)
    {
        if (string.IsNullOrWhiteSpace(file.Path))
        {
            ShowInfo(InfoBarSeverity.Warning, "无法使用此文件", "请选择具有本地绝对路径的文件。");
            return;
        }

        _inputFile = file;
        _probe = null;
        _inputLoudness = null;
        _outputLoudness = null;
        _outputPath = null;

        SelectedFileText.Text = file.Path;
        AnalyzeAgainButton.Visibility = Visibility.Visible;
        ProbeDetailsGrid.Visibility = Visibility.Collapsed;
        LoudnessResultCard.Visibility = Visibility.Collapsed;
        NormalizeButton.IsEnabled = false;
        ResultCard.Visibility = Visibility.Collapsed;
        OriginalPlayer.Source = MediaSource.CreateFromStorageFile(file);
        ResultPlayer.Source = null;
        UpdateTaskAvailability();

        if (!IsFfmpegReady)
        {
            ShowInfo(InfoBarSeverity.Informational, "先启用 FFmpeg", "文件已选择。组件就绪后会自动检测格式。");
            return;
        }

        await ProbeInputAsync();
    }

    private async void AnalyzeAgainButton_Click(object sender, RoutedEventArgs e) => await ProbeInputAsync();

    private async Task ProbeInputAsync()
    {
        if (_inputFile is null || !IsFfmpegReady || _operationRunning)
            return;

        var result = await RunAudioJobAsync(
            "正在检测音频格式…",
            progress => App.Ffmpeg.ProbeAsync(new ProbeRequest { Input = _inputFile.Path }, progress));
        if (result?.Probe is null)
        {
            _probe = null;
            UpdateTaskAvailability();
            return;
        }

        _probe = result.Probe;
        DurationText.Text = FormatDuration(_probe.DurationSeconds);
        FormatText.Text = JoinKnown(_probe.Container, _probe.Codec);
        SampleRateText.Text = _probe.SampleRate is { } rate ? $"{rate:N0} Hz" : "未知";
        ChannelsText.Text = DescribeChannels(_probe.Channels);
        ProbeDetailsGrid.Visibility = Visibility.Visible;
        UpdatePrepareSummary();
        UpdateTaskAvailability();
        ShowInfo(InfoBarSeverity.Success, "音频检测完成", "可以选择准备音频，或先检查响度。");
    }

    private void TaskSelector_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (PreparePanel is null || LoudnessPanel is null)
            return;

        var loudness = TaskSelector.SelectedIndex == 1;
        PreparePanel.Visibility = loudness ? Visibility.Collapsed : Visibility.Visible;
        LoudnessPanel.Visibility = loudness ? Visibility.Visible : Visibility.Collapsed;
        UpdatePrepareSummary();
    }

    private void PrepareSettings_Changed(object sender, SelectionChangedEventArgs e) => UpdatePrepareSummary();

    private void PrepareNumber_ValueChanged(NumberBox sender, NumberBoxValueChangedEventArgs args) => UpdatePrepareSummary();

    private void UpdatePrepareSummary()
    {
        if (PrepareSummaryText is null || SampleRateBox is null || ChannelsBox is null || SampleFormatBox is null)
            return;

        var sampleRate = SelectedTag(SampleRateBox) == "keep"
            ? _probe?.SampleRate is { } rate ? $"保持 {rate:N0} Hz" : "保持原采样率"
            : $"转换为 {SelectedTag(SampleRateBox)} Hz";
        var channels = SelectedTag(ChannelsBox) switch
        {
            "1" => "单声道",
            "2" => "立体声",
            _ => "保持原声道",
        };
        var format = SelectedTag(SampleFormatBox) switch
        {
            "s16" => "16-bit PCM",
            "f32" => "32-bit float PCM",
            _ => "24-bit PCM",
        };
        var trim = OptionalValue(StartSecondsBox) is null && OptionalValue(DurationSecondsBox) is null
            ? "不裁剪"
            : $"从 {OptionalValue(StartSecondsBox) ?? 0:0.###} 秒开始"
              + (OptionalValue(DurationSecondsBox) is { } duration ? $"，保留 {duration:0.###} 秒" : "");

        PrepareSummaryText.Text = $"计划：{sampleRate}，{channels}，{format}，{trim}。将生成新的 WAV，源文件保持不变。";
    }

    private async void PrepareButton_Click(object sender, RoutedEventArgs e)
    {
        if (!CanProcessInput())
            return;

        var outputName = BuildOutputName("synthv");
        var request = new PrepareRequest
        {
            Input = _inputFile!.Path,
            OutputName = outputName,
            SampleRate = ParseOptionalUInt(SelectedTag(SampleRateBox)),
            Channels = ParseOptionalByte(SelectedTag(ChannelsBox)),
            SampleFormat = SelectedTag(SampleFormatBox),
            StartSeconds = OptionalValue(StartSecondsBox),
            DurationSeconds = OptionalValue(DurationSecondsBox),
        };

        var plannedPath = Path.Combine(OutputDirectory, outputName);
        var confirmed = await ConfirmAsync(
            "生成 SynthV 用音频？",
            $"输入：{request.Input}\n\n{PrepareSummaryText.Text}\n\n输出：{plannedPath}\n\n这一步不会导入 SynthV，也不会修改当前工程。",
            "生成新文件");
        if (!confirmed)
            return;

        var result = await RunAudioJobAsync(
            "正在生成 PCM WAV…",
            progress => App.Ffmpeg.PrepareAsync(request, progress));
        if (string.IsNullOrWhiteSpace(result?.OutputPath))
            return;

        _outputPath = result.OutputPath;
        await ShowResultAsync("已生成供 SynthV 使用的 PCM WAV。源文件和当前 SynthV 工程均未修改。");
    }

    private async void AnalyzeLoudnessButton_Click(object sender, RoutedEventArgs e)
    {
        if (!CanProcessInput())
            return;

        var result = await RunAudioJobAsync(
            "正在测量响度（只读）…",
            progress => App.Ffmpeg.AnalyzeAsync(
                new LoudnessAnalyzeRequest { Input = _inputFile!.Path }, progress));
        if (result?.Loudness is null)
            return;

        _inputLoudness = result.Loudness;
        _outputLoudness = null;
        UpdateLoudnessCard();
        NormalizeButton.IsEnabled = !_operationRunning;
        ShowInfo(InfoBarSeverity.Success, "响度检查完成", "测量过程没有修改文件。你可以查看参数后再决定是否生成平衡响度的新文件。");
    }

    private async void NormalizeButton_Click(object sender, RoutedEventArgs e)
    {
        if (!CanProcessInput() || _inputLoudness is null)
            return;

        if (!TryReadTargets(out var targetLufs, out var truePeak, out var targetLra))
            return;

        var outputName = BuildOutputName("normalized");
        var plannedPath = Path.Combine(OutputDirectory, outputName);
        var confirmed = await ConfirmAsync(
            "生成平衡响度的新文件？",
            $"输入：{_inputFile!.Path}\n\n目标：{targetLufs:0.0} LUFS，真峰值不高于 {truePeak:0.0} dBTP，LRA {targetLra:0.0}。"
            + $"\n这是通用试听预设，不是 SynthV 强制标准。\n\n输出：{plannedPath}\n\n源文件不会被覆盖。",
            "平衡响度");
        if (!confirmed)
            return;

        var request = new LoudnessNormalizeRequest
        {
            Input = _inputFile.Path,
            OutputName = outputName,
            TargetLufs = targetLufs,
            MaxTruePeakDb = truePeak,
            TargetLra = targetLra,
        };
        var result = await RunAudioJobAsync(
            "正在平衡响度…",
            progress => App.Ffmpeg.NormalizeAsync(request, progress));
        if (string.IsNullOrWhiteSpace(result?.OutputPath))
            return;

        _outputPath = result.OutputPath;
        var after = await RunAudioJobAsync(
            "正在复测输出响度…",
            progress => App.Ffmpeg.AnalyzeAsync(
                new LoudnessAnalyzeRequest { Input = _outputPath }, progress));
        _outputLoudness = after?.Loudness;
        UpdateLoudnessCard();

        var summary = _outputLoudness is null
            ? "已生成平衡响度的新文件；输出复测未完成，但文件仍可试听或另存。"
            : $"已生成并复测：综合响度 {FormatMetric(_inputLoudness.IntegratedLufs)} → {FormatMetric(_outputLoudness.IntegratedLufs)} LUFS。";
        await ShowResultAsync(summary);
    }

    private async Task<FfmpegOperationResult?> RunAudioJobAsync(
        string initialStatus,
        Func<IProgress<JobStatus>, Task<FfmpegOperationResult>> start)
    {
        if (_operationRunning)
            return null;
        if (App.Ffmpeg.IsBusy)
        {
            ShowInfo(InfoBarSeverity.Warning, "已有任务正在运行", "请回到启动该任务的页面等待或取消，然后再试。");
            return null;
        }

        _operationRunning = true;
        SetInteractiveState();
        ProgressCard.Visibility = Visibility.Visible;
        JobStatusText.Text = initialStatus;
        JobProgress.IsIndeterminate = true;
        BeginGlobalJob(initialStatus);
        var progress = new Progress<JobStatus>(UpdateAudioProgress);

        try
        {
            return await start(progress);
        }
        catch (FfmpegJobException ex)
        {
            ShowJobFailure(ex, "处理音频");
            return null;
        }
        catch (Exception ex)
        {
            ShowInfo(InfoBarSeverity.Error, "无法处理音频", ex.Message);
            return null;
        }
        finally
        {
            _operationRunning = false;
            EndGlobalJob();
            ProgressCard.Visibility = Visibility.Collapsed;
            SetInteractiveState();
        }
    }

    private void UpdateAudioProgress(JobStatus status)
    {
        JobProgress.IsIndeterminate = status.Progress is null;
        if (status.Progress is { } progress)
            JobProgress.Value = Math.Clamp(progress, 0, 1) * 100;
        JobStatusText.Text = DescribePhase(status.Phase);
        UpdateGlobalJob(JobStatusText.Text);
    }

    private void UpdateSetupProgress(JobStatus status)
    {
        SetupProgress.IsIndeterminate = status.Progress is null;
        if (status.Progress is { } progress)
            SetupProgress.Value = Math.Clamp(progress, 0, 1) * 100;
        ComponentStatusText.Text = DescribePhase(status.Phase);
        UpdateGlobalJob(ComponentStatusText.Text);
    }

    private async void CancelJob_Click(object sender, RoutedEventArgs e)
    {
        var requested = await App.Ffmpeg.CancelCurrent();
        ShowInfo(
            requested ? InfoBarSeverity.Informational : InfoBarSeverity.Warning,
            requested ? "已请求取消" : "没有可取消的任务",
            requested ? "正在等待当前安全步骤结束。" : "任务可能已经结束，请稍后查看状态。");
    }

    private void UpdateLoudnessCard()
    {
        if (_inputLoudness is null)
        {
            LoudnessResultCard.Visibility = Visibility.Collapsed;
            return;
        }

        LoudnessResultCard.Visibility = Visibility.Visible;
        LoudnessSummaryText.Text = _outputLoudness is null ? "输入文件测量值" : "输入与输出复测对比";
        var before = FormatLoudness("输入", _inputLoudness);
        LoudnessNumbersText.Text = _outputLoudness is null
            ? before
            : before + "\n" + FormatLoudness("输出", _outputLoudness);
    }

    private async Task ShowResultAsync(string summary)
    {
        if (string.IsNullOrWhiteSpace(_outputPath))
            return;

        ResultSummaryText.Text = summary + $"\n{_outputPath}";
        ResultCard.Visibility = Visibility.Visible;
        try
        {
            var outputFile = await StorageFile.GetFileFromPathAsync(_outputPath);
            ResultPlayer.Source = MediaSource.CreateFromStorageFile(outputFile);
            if (_inputFile is not null)
                OriginalPlayer.Source = MediaSource.CreateFromStorageFile(_inputFile);
        }
        catch (Exception ex)
        {
            ShowInfo(InfoBarSeverity.Warning, "文件已生成，但无法加载内置试听", ex.Message);
        }
    }

    private void OpenLocationButton_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(_outputPath))
            return;

        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = "explorer.exe",
                Arguments = $"/select,\"{_outputPath}\"",
                UseShellExecute = true,
            });
        }
        catch (Exception ex)
        {
            ShowInfo(InfoBarSeverity.Error, "无法打开文件位置", ex.Message);
        }
    }

    private void CopyPathButton_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(_outputPath))
            return;

        var package = new DataPackage();
        package.SetText(_outputPath);
        Clipboard.SetContent(package);
        ShowInfo(InfoBarSeverity.Success, "已复制路径", _outputPath);
    }

    private async void SaveAsButton_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(_outputPath) || !File.Exists(_outputPath))
            return;

        var picker = new FileSavePicker
        {
            SuggestedStartLocation = PickerLocationId.MusicLibrary,
            SuggestedFileName = Path.GetFileNameWithoutExtension(_outputPath),
        };
        picker.FileTypeChoices.Add("WAV 音频", new List<string> { ".wav" });
        InitializePicker(picker);
        var destination = await picker.PickSaveFileAsync();
        if (destination is null)
            return;

        try
        {
            var sourcePath = Path.GetFullPath(_outputPath);
            var destinationPath = Path.GetFullPath(destination.Path);
            if (_inputFile is not null
                && string.Equals(Path.GetFullPath(_inputFile.Path), destinationPath, StringComparison.OrdinalIgnoreCase))
            {
                ShowInfo(InfoBarSeverity.Warning, "不能覆盖源文件", "请选择其他文件名或目录；源音频必须保持不变。");
                return;
            }
            if (!string.Equals(sourcePath, destinationPath, StringComparison.OrdinalIgnoreCase))
                await Task.Run(() => File.Copy(sourcePath, destinationPath, overwrite: true));
            ShowInfo(InfoBarSeverity.Success, "已另存文件", destinationPath);
        }
        catch (Exception ex)
        {
            ShowInfo(InfoBarSeverity.Error, "另存失败", ex.Message);
        }
    }

    private bool CanProcessInput()
    {
        if (!IsFfmpegReady)
        {
            ShowInfo(InfoBarSeverity.Warning, "FFmpeg 尚未就绪", "请先安装或配置本地 FFmpeg。 ");
            return false;
        }
        if (_inputFile is null || _probe is null)
        {
            ShowInfo(InfoBarSeverity.Warning, "请先选择有效音频", "检测成功后才能开始处理。");
            return false;
        }
        if (App.Ffmpeg.IsBusy && !_operationRunning)
        {
            ShowInfo(InfoBarSeverity.Warning, "已有任务正在运行", "请回到启动该任务的页面等待或取消，然后再试。");
            return false;
        }
        return !_operationRunning;
    }

    private bool TryReadTargets(out double targetLufs, out double truePeak, out double targetLra)
    {
        targetLufs = TargetLufsBox.Value;
        truePeak = TruePeakBox.Value;
        targetLra = TargetLraBox.Value;
        if (double.IsFinite(targetLufs) && double.IsFinite(truePeak) && double.IsFinite(targetLra))
            return true;

        ShowInfo(InfoBarSeverity.Warning, "请填写完整的响度目标", "三个目标值都必须是有效数字。");
        return false;
    }

    private void SetInteractiveState()
    {
        ChooseFileButton.IsEnabled = !_operationRunning;
        AnalyzeAgainButton.IsEnabled = !_operationRunning;
        TaskCard.IsEnabled = !_operationRunning && IsFfmpegReady && _probe is not null;
        InstallButton.IsEnabled = !_operationRunning;
        RefreshComponentButton.IsEnabled = !_operationRunning;
        NormalizeButton.IsEnabled = !_operationRunning && _inputLoudness is not null;
    }

    private void UpdateTaskAvailability() => SetInteractiveState();

    private async Task<bool> ConfirmAsync(string title, string message, string primaryText)
    {
        var dialog = new ContentDialog
        {
            XamlRoot = XamlRoot,
            Title = title,
            Content = new ScrollViewer
            {
                MaxHeight = 420,
                Content = new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true },
            },
            PrimaryButtonText = primaryText,
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Close,
        };
        return await dialog.ShowAsync() == ContentDialogResult.Primary;
    }

    private void ShowJobFailure(FfmpegJobException exception, string action)
    {
        if (string.Equals(exception.Status.State, "cancelled", StringComparison.Ordinal))
        {
            ShowInfo(InfoBarSeverity.Informational, $"已取消{action}", "没有覆盖源文件。");
            return;
        }

        var code = exception.Error?.Code;
        var detail = exception.Error?.Details;
        var message = string.IsNullOrWhiteSpace(detail) ? exception.Message : $"{exception.Message}\n{detail}";
        ShowInfo(InfoBarSeverity.Error, string.IsNullOrWhiteSpace(code) ? $"{action}失败" : $"{action}失败（{code}）", message);
    }

    private void ShowInfo(InfoBarSeverity severity, string title, string message)
    {
        PageInfoBar.Severity = severity;
        PageInfoBar.Title = title;
        PageInfoBar.Message = message;
        PageInfoBar.IsOpen = true;
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

    private static string DescribeComponentStatus(ComponentStatus status) => status.State switch
    {
        "ready" when status.Source == "managed" => $"私有 FFmpeg 已就绪（{status.InstalledVersion ?? "版本未知"}）。",
        "ready" when status.Source == "system" => $"已检测到系统 FFmpeg（{status.InstalledVersion ?? "版本未知"}）。",
        "ready" when status.Source == "explicit" => $"配置的 FFmpeg 已就绪（{status.InstalledVersion ?? "版本未知"}）。",
        "checking" => "FFmpeg 正被另一个本地任务使用；任务结束后请刷新状态。",
        "downloading" => "正在下载 FFmpeg…",
        "verifying" => "正在校验 FFmpeg…",
        "installing" => "正在安装 FFmpeg…",
        "updating" => "正在更新 FFmpeg…",
        "failed" => "FFmpeg 检查失败。",
        _ => "尚未安装可用的 FFmpeg。",
    };

    private static string BuildComponentDetails(ComponentStatus status) =>
        $"来源：{DescribeSource(status.Source)}\n"
        + $"已用版本：{status.InstalledVersion ?? "—"}\n"
        + $"可用版本：{status.AvailableVersion ?? "—"}\n"
        + $"目录：{status.ExecutableDir ?? "—"}"
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
        "resolving" => "正在定位本地组件…",
        "download" or "downloading" => "正在下载…",
        "verify" or "verifying" => "正在校验…",
        "install" or "installing" => "正在安装…",
        "processing" => "正在处理音频…",
        "complete" => "已完成。",
        "cancelled" => "已取消。",
        "failed" => "处理失败。",
        _ => "正在处理…",
    };

    private static string FormatLoudness(string label, LoudnessAnalysisResult value) =>
        $"{label}：I {FormatMetric(value.IntegratedLufs)} LUFS　TP {FormatMetric(value.TruePeakDb)} dBTP　LRA {FormatMetric(value.LoudnessRange)} LU";

    private static string FormatMetric(double? value) => value is { } number ? number.ToString("0.0", CultureInfo.CurrentCulture) : "—";

    private static string FormatDuration(double? seconds)
    {
        if (seconds is null || !double.IsFinite(seconds.Value) || seconds < 0)
            return "未知";
        var duration = TimeSpan.FromSeconds(seconds.Value);
        return duration.TotalHours >= 1 ? duration.ToString(@"h\:mm\:ss\.fff") : duration.ToString(@"m\:ss\.fff");
    }

    private static string DescribeChannels(byte? channels) => channels switch
    {
        1 => "1（单声道）",
        2 => "2（立体声）",
        { } count => count.ToString(CultureInfo.CurrentCulture),
        null => "未知",
    };

    private static string JoinKnown(params string?[] values)
    {
        var known = values.Where(value => !string.IsNullOrWhiteSpace(value)).ToArray();
        return known.Length == 0 ? "未知" : string.Join(" / ", known);
    }

    private static string SelectedTag(ComboBox box) => (box.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "keep";

    private static uint? ParseOptionalUInt(string value) =>
        value == "keep" ? null : uint.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) ? parsed : null;

    private static byte? ParseOptionalByte(string value) =>
        value == "keep" ? null : byte.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) ? parsed : null;

    private static double? OptionalValue(NumberBox box) => double.IsNaN(box.Value) ? null : box.Value;

    private string BuildOutputName(string purpose)
    {
        var stem = Path.GetFileNameWithoutExtension(_inputFile?.Name ?? "audio");
        var invalid = Path.GetInvalidFileNameChars().ToHashSet();
        stem = new string(stem.Select(character => invalid.Contains(character) ? '_' : character).ToArray()).Trim(' ', '.');
        if (string.IsNullOrWhiteSpace(stem))
            stem = "audio";
        if (stem.Length > 64)
            stem = stem[..64].TrimEnd(' ', '.');
        var nonce = Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture)[..6];
        return $"{stem}_{purpose}_{DateTime.Now:yyyyMMdd_HHmmss_fff}_{nonce}.wav";
    }

    private static string OutputDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".SynthVcopilot", "output", "ffmpeg");

    private static void InitializePicker(object picker)
    {
        var window = MainWindow.Instance ?? throw new InvalidOperationException("The main window is not available.");
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
        WinRT.Interop.InitializeWithWindow.Initialize(picker, hwnd);
    }
}
