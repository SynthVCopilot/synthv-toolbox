# Changelog / 更新日志

## 2026-08-06 — User-friendly FFmpeg workflow / 用户友好的 FFmpeg 工作流

### 中文

#### 新增“音频准备”主页面

- 在主导航中加入独立的“音频准备”入口，不改变原有对话和 SynthV 实时音符编辑入口。
- 支持选择一个本地音频/视频文件或拖放单个文件，并在开始任务前调用 `ffprobe` 显示：
  时长、容器/编码、采样率和声道数。
- 提供“为 SynthV 准备音频”流程，生成新的 PCM WAV；默认保持原采样率和声道、使用
  24-bit PCM，并可显式选择采样率、单/双声道、采样格式、起始位置和保留时长。
- 提供“检查 / 平衡响度”流程：先执行只读 EBU R128 测量，再允许用户确认后生成新文件。
- 默认响度目标为通用试听预设 `-16 LUFS / -1.5 dBTP / 11 LRA`，界面明确说明它不是
  SynthV 强制标准；标准化完成后自动复测输出，显示输入/输出对比。

#### 用户确认与文件安全

- PCM WAV 准备、响度标准化、FFmpeg 安装和更新均在写入前显示输入、参数和计划输出位置，
  并要求用户在 Desktop 中确认。
- 所有音频操作生成新文件到 `~/.SynthVcopilot/output/ffmpeg`，不覆盖源文件。
- 输出名包含时间、毫秒和随机短后缀，避免快速重试时发生同名冲突。
- “另存为”显式拒绝选择输入源路径，维护“源文件不修改”的产品承诺。
- 不自动导入 SynthV、不自动运行 CVRS、不删除输出，也不开放批处理或任意 FFmpeg 命令。

#### 结果预览与交接

- 处理完成后可在页面内分别试听原始音频与处理结果。
- 提供“打开文件位置”“复制路径”和“另存为”，让用户决定如何交给 SynthV 或其他工具。
- 对话页增加固定的“处理音频”跳转，Agent 不再直接执行音频写入。

#### FFmpeg 组件维护

- 将原来的静态组件占位列表改为可用的 FFmpeg 维护卡片。
- 显示当前来源（Pi Desktop 私有安装、系统 PATH 或用户显式目录）、已用版本、可用版本和
  可执行文件目录。
- 支持用户确认后的安装、更新和卸载；系统 FFmpeg 与显式配置目录保持只读，不会被卸载。
- 其他尚未实现的模型组件明确显示为“计划中”，不会执行占位下载或无效安装。

#### Native 服务和任务生命周期

- 新增完整 C# DTO、四种 FFmpeg 请求模型及六项原生 C ABI P/Invoke 绑定。
- 新增 `SafeHandle`，确保每个 native `PiJob` 恰好销毁一次。
- 新增全局 `FfmpegService`：所有 native 调用离开 UI 线程，单任务互斥，250 ms 状态轮询，
  结构化错误、进度报告和安全取消。
- 增加预登记取消状态，覆盖“UI 已显示任务但 native handle 尚未登记”的短窗口。
- 取消调用同步绑定当时的任务，避免旧取消请求延迟后错误命中新任务。
- 应用关闭时取消当前任务并释放 FFmpeg 服务与 Agent 服务。

#### 跨页面体验

- 主窗口增加全局任务条和取消按钮；切换页面后仍可看到任务并取消。
- 音频准备和组件页面启用导航缓存，返回页面后保留选择、进度、试听和处理结果。
- 全局任务条使用任务 token，旧任务的延迟完成不会关闭或改写新任务状态。

#### 架构和冒烟测试

- `pi-desktop` 和 `PiAgentSmoke` 根据 Platform/RID 显式选择 Rust target：
  x64 对应 `x86_64-pc-windows-msvc`，ARM64 对应 `aarch64-pc-windows-msvc`。
- 从 `target/<triple>/release/pi_agent.dll` 复制对应架构 DLL；缺少预期 DLL 时构建失败关闭，
  防止 ARM64 包误带 x64 产物。
- 冒烟测试覆盖组件状态 JSON、job 轮询、SafeHandle 释放，以及真实 FFmpeg 的探测、PCM WAV
  准备、响度分析和响度标准化；测试输出会被清理。

#### Agent 与 SynthV 边界

- Desktop 子模块更新到包含安全 FFmpeg C ABI 的 `pi-agent` 基线，并同步 Agent 只读权限补丁。
- Agent 只保留 `ffmpeg_probe` 和 `ffmpeg_loudness_analyze`；音频写入只通过 Desktop 确认流程。
- 未修改 `synthv-agent-bridge`、IPC v3、六个 `sv_*` 工具或 `add_notes`；用户继续在打开的
  SynthV 钢琴卷帘中看到 Agent 批量插入音符。

#### 验证状态

- 真实 C ABI 冒烟：探测、准备、响度分析、标准化全部通过。
- Rust：57 项测试通过、2 项按设计忽略；Clippy `-D warnings` 通过。
- SynthV Bridge：240 项自动化检查通过，Bridge 工作树保持无改动。
- Desktop 非 XAML C# 源编译、XAML XML 与事件绑定检查通过。
- 本机缺少 Visual Studio C++ Build Tools、MSVC linker 与 Windows SDK，因此完整 WinUI XAML
  构建和 ARM64 native 构建仍需在具备正式 Windows 构建环境的节点补跑。

### English

#### New first-class Audio Preparation page

- Added an independent Audio Preparation destination to the main navigation without changing
  the existing chat entry or live SynthV note-editing workflow.
- Supports selecting one local audio/video file or dropping a single file, then probes it before
  processing to show duration, container/codec, sample rate, and channel count.
- Added a “Prepare audio for SynthV” flow that creates a new PCM WAV. Defaults preserve the source
  sample rate and channels, use 24-bit PCM, and allow explicit sample rate, mono/stereo, sample
  format, start position, and duration choices.
- Added a “Check / balance loudness” flow that performs read-only EBU R128 analysis before any
  write-capable action becomes available.
- Uses a general listening preset of `-16 LUFS / -1.5 dBTP / 11 LRA`, clearly labels it as not a
  mandatory SynthV standard, and automatically re-analyzes normalized output for before/after
  comparison.

#### User confirmation and file safety

- PCM WAV preparation, loudness normalization, FFmpeg install, and FFmpeg update all show the
  input, parameters, and planned destination before asking the user to confirm.
- Audio jobs create new files under `~/.SynthVcopilot/output/ffmpeg` and never overwrite the input.
- Output names include time, milliseconds, and a short random suffix to avoid rapid-retry name
  collisions.
- Save As explicitly refuses the original input path, preserving the source-file immutability
  promise.
- The workflow does not auto-import into SynthV, auto-run CVRS, delete output, offer batch mode,
  or expose arbitrary FFmpeg command lines.

#### Result preview and hand-off

- Provides separate in-page playback for the original file and processed result.
- Adds Open location, Copy path, and Save As actions so the user decides how to hand the result to
  SynthV or another application.
- Adds a persistent “Process audio” shortcut to Chat while keeping audio writes out of Agent tools.

#### FFmpeg component maintenance

- Replaced the inert component placeholder list with an operational FFmpeg maintenance card.
- Shows the active source (Pi Desktop managed install, system `PATH`, or explicit user directory),
  installed version, available version, and executable directory.
- Supports confirmed install, update, and managed uninstall. System and explicitly configured
  FFmpeg installations remain read-only and are never removed.
- Labels unimplemented model components as planned and performs no placeholder download or no-op
  installation.

#### Native service and job lifecycle

- Added complete C# DTOs, four FFmpeg request models, and six native C ABI P/Invoke bindings.
- Added a `SafeHandle` that destroys each native `PiJob` exactly once.
- Added a process-wide `FfmpegService`: native calls run off the UI thread, only one job can own the
  executor, status is polled every 250 ms, and structured errors, progress, and cancellation are
  exposed to the UI.
- Added pre-registration cancellation state for the short interval where the UI has started a task
  but the native handle is not yet published.
- Cancellation binds synchronously to the job active at click time so a delayed old cancellation
  cannot terminate a newer job.
- Window shutdown cancels active work and disposes both the FFmpeg and Agent services.

#### Cross-page experience

- Added a global task InfoBar and Cancel action so work remains visible and cancellable after
  navigation.
- Enabled required navigation caching for Audio Preparation and Components, preserving selections,
  progress, playback, and results when the user returns.
- Protects the global task bar with per-operation tokens so late completion from an old task cannot
  hide or rewrite a newer task.

#### Architecture and smoke coverage

- `pi-desktop` and `PiAgentSmoke` explicitly map Platform/RID to Rust targets:
  x64 uses `x86_64-pc-windows-msvc`; ARM64 uses `aarch64-pc-windows-msvc`.
- Copies the native DLL from `target/<triple>/release/pi_agent.dll` and fails closed if the expected
  artifact is missing, preventing an ARM64 package from accidentally carrying an x64 DLL.
- Expanded smoke coverage for component status JSON, job polling, SafeHandle disposal, and all four
  real FFmpeg operations: probe, PCM WAV preparation, loudness analysis, and normalization. Test
  artifacts are removed afterward.

#### Agent and SynthV boundaries

- Updated the Desktop submodule to the secure FFmpeg C ABI baseline and synchronized the Agent
  read-only permission patch.
- The Agent retains only `ffmpeg_probe` and `ffmpeg_loudness_analyze`; audio writes run only through
  the confirmed Desktop workflow.
- Did not modify `synthv-agent-bridge`, IPC v3, the six `sv_*` tools, or `add_notes`; users continue
  to see Agent-created note batches appear in the open SynthV piano roll.

#### Validation status

- Real C ABI smoke passed probe, prepare, loudness analysis, and normalization.
- Rust validation passed 57 tests with 2 intentionally ignored; Clippy passed with `-D warnings`.
- SynthV Bridge passed 240 automated checks and remained unchanged.
- Desktop non-XAML C# source compilation, XAML XML parsing, and event-handler checks passed.
- This machine lacks Visual Studio C++ Build Tools, the MSVC linker, and the Windows SDK, so the
  complete WinUI XAML build and ARM64 native build still need to run on a fully provisioned Windows
  build node.
