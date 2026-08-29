# pi-audio — 音频探针组件

Pi Agent 的耳朵之一。两个子命令,全部输出紧凑 JSON,供 agent(或人工)消费。

## probe — 特征指纹 + 判别

```bash
python pi_audio.py probe song.flac --panns --notes
```

输出:BPM(含倍速歧义提示)、调性猜测、打击比、六段能量弧、亮度趋势;
`--notes` 加 basic-pitch 音符统计(密度/音域/八度直方图/长音数);
`--panns` 加 AudioSet 判别:乐器构成、genre 倾向排序、**有词/无词判别**。

### 三层风格识别设计(为什么不直接出 genre 标签)

```
PANNs 乐器构成(可靠) + 特征指纹(BPM/打击比/密度/音区/能量弧)
        ↓ 结构化事实(本工具的职责边界)
      上层 LLM 命名风格(懂中V语境,如「钢琴系抒情中V曲」)
```

实测结论(12 对中V样本):AudioSet genre 概率普遍 0.01-0.06 仅可相对排序,
且对 VOCALOID 音色有"儿歌"偏置——**本工具刻意只出事实,风格命名留给 LLM**。
这与 synthv-agent-bridge 的职责划分同构:确定性执行层出数据,语义判断归 Agent。

有词/无词实测样本分布(12 对中V样本):人声版 vocal_prob_sum ≥0.35,INST ≤0.05。
代码判决边界有意放宽留余量:**≥0.2 判 vocal,≤0.08 判 instrumental,其间 uncertain**。
浅层 vocalCoverage 会被 synth 主奏骗,PANNs 不会。

## pair-diff — 有词/无词配对差分 → 单音人声轨

```bash
python pi_audio.py pair-diff vocal.flac inst.flac --midi vocal-mono.mid
```

高级模式会围绕请求容差运行五组候选参数，选择评分最高的结果，并执行保守的八度偏移修正、重复音符合并和重叠碎片清理。JSON 会同时返回候选评分、实际容差、修正计数和置信度：

```bash
python pi_audio.py pair-diff vocal.flac inst.flac --midi vocal-mono.mid --tol 0.08 --advanced
```

原理:按 `(pitch, start±80ms)` 消耗式匹配去除伴奏音符,残差即人声贡献;
再经"最高音抢占"单音化 → 100% 单音,通常 ≤512 音符,
**可直接喂 synthv-agent-bridge 的 `import_monophonic_score`,绕开 demucs**。

实测(标题曲):有词 1157 + 无词 1180 音符 → 差分 575 → 单音化 437(100% 单音)。
局限:低于主线的和声声部会被丢弃;BPM 可能出现 2x/0.5x 歧义(用双版本一致性守卫);
调性检测应以**有词版**为准(旋律是调性锚)。

## 安装

```cmd
py -3.11 -m venv venv
venv\Scripts\pip install -r requirements.txt
```

PANNs(可选):按 requirements.txt 注释装 torch(CPU)+panns-inference。
首次 `probe --panns` 经内置 urllib 下载(库自带的 wget 下载在 Windows 上不可用,已绕开)。

## 数据纪律(统一数据根)

所有数据统一放 **`~/.SynthVcopilot/`**,并且**硬禁止 `..` 穿透**:

| 内容 | 位置 |
|---|---|
| PANNs checkpoint (~300MB) | `~/.SynthVcopilot/models/panns/`(显式传 checkpoint_path) |
| MIDI 等输出写入 | `~/.SynthVcopilot/output/`(`--midi` 只收相对名;绝对路径仅根内放行) |
| 配置 / 历史（Toolbox Agent） | `~/.SynthVcopilot/config.json` / `history/` |

唯一根外例外:AudioSet 标签 CSV(~60KB)——panns_inference 库在 import 时硬编码读
`~/panns_data/class_labels_indices.csv`,无法重定向,已自动预置。

## 验证记录

12 对有词/无词样本的完整实证数据与评价报告存于中央 agent 记忆库
(agents_memory/Pi_Agent,私有),本仓库不承载调研过程文件。
