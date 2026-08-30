# SynthV 片段 A/B 捕获

## 目标

片段 A/B 检查用于替代调声迭代中的重复完整渲染。用户选择短时间范围后，Toolbox 自动定位、播放、停止并恢复 SynthV 播放头，同时捕获该次播放的音频。基线 A 可以保留不动；每次修改后只捕获候选 B，再做快速对齐比较。

这条路径不会启动 `pi-audio`、PANNs 或模型推理。它只执行短时本机捕获、单声道 WAV 裁切和确定性指标计算，因此适合作为连续片段优化与 Copilot 复检的默认方式。

## 实现边界

- 当前捕获后端为 Windows WASAPI Application Loopback，目标是所选 SynthV standalone PID 及其子进程；不录制系统混音，也不捕获 DAW 中的 SynthV 插件。
- 需要 Windows 10 build 20348 或更高版本。其他平台会返回明确的 capability 不可用状态；A/B WAV 比较逻辑本身仍是跨平台的。
- Bridge 的公共 MCP 表面仍保持 `sv_status`、`sv_describe`、`sv_query`、`sv_command`、`sv_ui`、`sv_review` 六个工具。片段捕获由 Toolbox/Copilot 的本地工具层调用既有 `sv_ui` playback 动作完成，不给 Bridge 增加第七个工具。
- 单次目标片段最长 30 秒，前后保护区各最多 2 秒。捕获开始前 SynthV 必须处于 stopped 状态，避免中断用户正在进行的试听。
- 输出写入 `~/.SynthVcopilot/output/ab-captures/`。最终片段是 48 kHz 单声道 PCM16 WAV，并带有 JSON 元数据、SHA-256、边界不确定度与快速电平指标。

## 捕获时序

1. 枚举并确认 SynthV standalone PID；多个实例并存时必须明确选择。
2. 读取 Bridge Session、播放状态和原播放头。正在播放时直接拒绝操作。
3. 将播放头移到 `起点 - 前置保护区`，先启动进程回环并等待捕获器就绪，再让 Bridge 播放。
4. 轮询实际播放状态，达到 `终点 + 后置保护区` 后停止播放和捕获。
5. 恢复原播放头，检查捕获中断和 Bridge Session 是否变化。
6. 根据播放命令往返时间估计真实起播边界，裁出用户请求的精确范围，原始保护区文件随即删除。

任何捕获数据中断、提前停止、超时、进程消失或 Session 切换都会让本次结果失败，避免用不可信的片段产生 A/B 结论。

## 快速比较

比较器接受 PCM16 或 IEEE float32 RIFF/WAVE，先下混为单声道，再在用户给定范围内搜索回环延迟。对齐后输出：

- 波形相关性、差分 RMS 和综合相似度；
- 响度、峰值、削波比例和高频变化；
- 自动对齐偏移、有效重叠时长和变化分级。

比较只返回结构化指标和本地文件路径，不把音频字节嵌入 Copilot 消息，也不上传音频。

## 使用方式

在“工具箱 → 片段 A/B 检查”中：

1. 启动并连接 SynthV Bridge，让 SynthV 停止播放。
2. 选择 standalone 实例，填写起点和终点，捕获 A 基线。
3. 在 SynthV 中修改目标片段，捕获 B 候选。
4. 运行“对齐并比较 A/B”。后续迭代可以继续保留 A，只替换 B。

Copilot 模式也会获得本地 `capture_synthv_clip` 和 `compare_audio_clips` 工具；其他 Bridge/MCP 调用保持原路由不变。

## 验证

自动化测试覆盖参数上限、WAV 读写、完全一致片段比较和已知延迟恢复。Windows 构建会同时编译原生回环后端。真实设备联调仍需要在 Windows 10/11 上运行 Synthesizer V Studio 2 Pro standalone，并确认所用音频驱动能够正常播放。
