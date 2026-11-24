# Issue #8 修复说明与复测手册（2026-08-11）

| 项目 | 值 |
|---|---|
| Issue | [#8](https://github.com/SynthVCopilot/synthv-agent-bridge/issues/8) `[docs/ux] v0.3.0: misleading fingerprint docs, silent fields no-op, oversized get_track_notes` |
| 报告人 | slhssb (dnmcb)，在 OMP（OpenAI 兼容 MCP 宿主）下使用 |
| 分支 | `fix/issue-8-guard-docs-and-nested-projection` |
| Commit | `1b3bd4c` — 12 文件，+477/−40 |
| 基线版本 | v0.3.0 (`588c03f`)，IPC 协议 v3 不变 |
| 验证宿主 | Synthesizer V Studio 2 Pro 2.2.1 (131585)，Windows 11，Node 24 |
| 验证工程 | `D:\Project\SynthesizerV\test.svp`（空工程，可破坏） |

本文档面向**另一个 Agent 复测**。第 1 节讲清问题，第 2 节讲清改了什么、为什么这么改，
第 3 节是可直接执行的复测用例，每条都带实测期望值。

---

## 1. Issue 说了什么

报告人基于三次真实填词会话（558+555 音符双轨）与源码核对，提了 8 项，分「错误类」和
「体验优化类」。**8 项经逐条核对全部属实**，行号也都对得上。

### A. 错误类

| # | 问题 | 源码证据 |
|---|---|---|
| 1 | `fingerprint` 描述写成"必须来自最新读取"，实际传 `contextId` 会自动填充 | `server.ts:1955` 描述 vs `v3-surface.ts:635` `expandGuardedArray` 在校验前自动填充 |
| 2 | `sv_query.fields` 只裁剪结果根对象顶层 key，按"列投影"直觉使用会**静默返回空对象** | `v3-query-projector.ts:309` `projectFields` 只做 `owns(root, field)`，全 miss 时只剩信封字段，无任何告警 |
| 3 | `sv_describe` 的单查参数是 `action`，但 schema 无描述、报错不提示 | `v3-facade.ts:322` 是裸 `z.string()` |

第 2 项报告人实测踩到两次：对 `get_track_notes` 传音符字段名（`noteIndex` 等），因为音符在
`groups[].notes` 嵌套里，结果只剩 `page`，误判"工程没音符"。

### B. 体验优化类

| # | 问题 | 源码证据 |
|---|---|---|
| 4 | `get_track_notes` 无 compact/列投影，全量读取只能放宽 limit（558 音符 ≈37KB，宿主侧被迫落盘） | 该 action 无 `responseMode`；`QUERY_PROJECTION_DEFINITIONS` 不含它；`denseNotes`/`compactPhraseNotes` 只处理 `root.notes`，吃不到嵌套 |
| 5 | `BRIDGE_TIMEOUT` 默认 15s 对冷启动偏紧，首次 `get_project_info` 偶发超时 | `config.ts:58` |
| 6 | 批量写回流水线重：446 个 edits 拆 8 批，每批前重取 contextId，共 ~16 次往返 | — |
| 7 | `edit_notes` schema 上限 512，但宿主实际 >60-70 易闪退，给 Agent 造成"可大批量"错觉 | `server.ts:1968` `.max(512)` 无说明 |
| 8 | IPC 单客户端锁：第二客户端直接 `BridgeBusyError`，无排队/等待 | `file-ipc-client.ts:174` `wx` 独占创建，仅对**过期锁**重试一次 |

---

## 2. 改了什么

### 2.1 逐项对照

| # | 处理方式 | 主要文件 |
|---|---|---|
| 1 | 描述改为"有 writeIntent contextId 时由 Runtime 填充"；并把受 Context 填充的 guard 字段在 schema 里真正标成 **optional**；补一条 TS 层 fail-closed 检查 | `src/server.ts`、`src/v3-surface.ts` |
| 2 | `fields` 加描述；投影全部未命中 root 时返回 `projectionWarning` + `requestedFields` + `availableFields` | `src/v3-facade.ts`、`src/v3-query-projector.ts` |
| 3 | `sv_describe.action` 加描述 | `src/v3-facade.ts` |
| 4 | 投影器识别嵌套 `groups[].notes`，套用既有 compact + dense | `src/v3-query-projector.ts` |
| 5 | 超时默认 15s→30s，stale 阈值 30s→60s | `src/config.ts` |
| 6 | 文档：写清一个 contextId 可跨批复用的确切边界（见 2.3） | README ×2 |
| 7 | `edits`/`notes` 数组加描述，注明宿主脆弱、每批 ≤60；**保留** `.max(512)` | `src/server.ts` |
| 8 | `acquireLock` 改有界轮询等待，默认 1s，`SYNTHV_AGENT_BRIDGE_LOCK_WAIT_MS` 可覆盖 | `src/ipc/file-ipc-client.ts` |

### 2.2 几个关键决策及理由

**#1 为什么不止改文案。** `describeActionTool` 用 `z.toJSONSchema()` 生成 schema，
`fingerprint` 只要在 zod 里是必填，`sv_describe` 就会把它列进 `required`——描述写"可选"、
schema 写"必填"，Agent 只会继续手抄。所以把 `expandGuardedArray`/`retakeGuard` 会自动填充的
那些字段（note 数组、pitch control 数组、Retake 顶层）统一改成 optional。

为了不因此放宽安全性，新增 `assertGuardsResolved()`（`v3-surface.ts`），在 `expandContext`
的两个返回路径上都调用：**既没有 contextId、又没有显式 fingerprint 时在 TypeScript 就拒绝**，
不把请求甩给 Lua。Lua 侧原有的 `requireString(edit.fingerprint, ...)` 强制校验保持不变，
形成双层保险。

**#4 为什么不加 `responseMode`。** `sv_query` 是唯一公开读路径，投影层才是 v3 设计里做压缩的
位置；再开一个 `responseMode` 等于在 v3 之外拉第二条压缩通道。实现上直接复用现成的
`compactPhraseNotes`/`denseNotes`，对每个 group 调一次即可——它们本来就接受任意容器记录。
守卫在 `addNestedContexts` 阶段就已捕获（早于投影），所以行列化不影响 `contextId`。

**#5 为什么必须联动 stale 阈值。** `config.ts` 里有既有强校验
`staleRequestMs > timeoutMs`（否则活锁会被误判为过期锁并删除）。只把超时提到 30s 而不动
stale 的 30s，进程直接启动失败。

**#8 为什么是 clamp 而不是报错。** 初版给 `lockWaitMs >= timeoutMs` 加了硬校验，结果把仓库
里三个使用小超时的测试夹具（`TIMEOUT_MS=75`/`100`）全打挂了。改为在 `loadConfig` 里
`Math.min(lockWaitMs, timeoutMs)`——等待不会超过请求本身的超时，但不制造新的失败模式。

**#6 为什么只改文档、不做"跨批链式写"功能。** 报告人希望有"单 contextId 内连续多批写"的显式
模式。真机实测发现**这个能力本来就存在**（见 2.3），不需要新增机制；而真正会破坏安全性的
"跳过过期检查"是不能做的。

### 2.3 一条被真机推翻的结论（复测重点）

初版 README 我写的是"跨批复用同一个 contextId 是被设计性拒绝的"。**这是错的**，真机实测的
准确语义是：

- 一个 writeIntent `contextId` **可以服务多批写入**——Context 对每个音符**单独**签发守卫，
  只要该批目标音符的指纹仍新鲜就通过；
- 只有两种情况必须重读：① 再次修改 Context 已经改过的音符；② `add_notes`/`delete_notes`
  移动了索引，导致其后音符错位。两者都返回 `STALE_NOTE` + `retry:"query_again"`，
  且**写入前失败**。

所以报告人 #6 里那 16 次往返有一半是不必要的：读一页覆盖全部目标音符，然后用同一个
`contextId` 发多批互不相交的写入即可。README/README_CN/CHANGELOG 已按实测语义重写。

### 2.4 一个实现坑（复测时容易误判）

模型可见的 `sv_query`/`sv_describe` 定义在 **`src/v3-facade.ts`**；`src/v3-surface.ts` 里
同名的那份是内部适配器，不出现在 `tools/list` 里。第一版只改了 surface，`tools/list` 里
看不到 `fields` 的描述。**复测时请以 `tools/list` 的实际输出为准**，不要只看源码。

---

## 3. 复测手册

### 3.0 前置

```bash
npm run build
```

确认已安装的 Lua 与仓库一致（不一致会导致 `EXECUTOR_BUILD_ID` 不匹配）：

```powershell
(Get-FileHash "$env:APPDATA\Dreamtonics\Synthesizer V Studio 2\scripts\SynthV Agent Bridge\SynthVAgentBridge.lua" -Algorithm SHA256).Hash
(Get-FileHash "synthv\SynthVAgentBridge.lua" -Algorithm SHA256).Hash
```

不一致则：

```bash
npm run install:synthv -- --target "C:/Users/<user>/AppData/Roaming/Dreamtonics/Synthesizer V Studio 2/scripts" --without-sidebar --no-reload
```

启动宿主并在 SynthV 里执行 **脚本 → 重新扫描 → Start SynthV Agent Bridge**：

```powershell
Start-Process "D:\Program Files\Synthesizer V Studio 2 Pro\synthv-studio.exe" -ArgumentList "D:\Project\SynthesizerV\test.svp"
Get-Content "$env:TEMP\synthv-agent-bridge.status.json"   # 期望 "state":"running"
```

> **无人值守环境提示**：本机实测**鼠标注入被系统性屏蔽**（SendInput 返回成功，但连自建
> WinForms 测试窗口都收不到点击；键盘注入正常），Agent 点不了脚本菜单。绕过办法是先关闭
> SynthV，再编辑 `%APPDATA%\Dreamtonics\Synthesizer V Studio 2\settings\settings.xml`：
>
> ```xml
> <ScriptItem name="Start SynthV Agent Bridge" keyMapping="ctrl + alt + shift + B"/>
> <ScriptItem name="Stop SynthV Agent Bridge" keyMapping="ctrl + alt + shift + N"/>
> ```
>
> 重启 SynthV 后用键盘注入按该组合即可启动 Bridge。当前机器上这两个绑定已生效。

驱动方式：已注册 MCP 宿主就直接调工具；否则用附录 A 的 stdio 客户端直连
`dist/src/cli.js`（仓库根目录 `.mcp.json` 当前是空的）。

### 3.1 静态检查（不需要 SynthV）

| 步骤 | 命令 | 期望 |
|---|---|---|
| S1 | `npm run check` | 247 项，**246 通过 / 1 失败**（下方说明） |
| S2 | `node --check scripts/clean.mjs && node --check scripts/install-synthv-bridge.mjs && node --check scripts/doctor.mjs` | 退出码 0 |
| S3 | `luac -p synthv/*.lua` 与 `luac54 -p synthv/*.lua` | 退出码 0 |
| S4 | `node scripts/benchmark-v3.mjs --json` | `toolCatalog.characters` = **4552**（预算 6000） |

**S1 唯一失败项与本次改动无关**：

```
✖ doctor validates both project-scoped host profiles on request   'warning' !== 'ok'
```

成因是工作区里 `.mcp.json` 与 `.codex/config.toml` 被清空（未提交改动），doctor 报
`claude-project-config` / `codex-project-config` 两条 warning。确认方式：

```bash
git stash push -- .mcp.json .codex/config.toml
npm run build && node --test dist/tests/doctor.test.js    # 期望 4/4 通过
git stash pop
```

> AGENTS.md 里写的检查命令用的是 `luac5.4`，该名字在本机 PATH 中不存在，实际可用的是
> `luac` 与 `luac54`（Lua 5.4.8）。这行值得顺手修。

### 3.2 Schema 层用例（需要 dist，不需要 SynthV）

#### T1 — fingerprint 不再必填、描述准确（#1、#7）

`sv_describe {"action":"edit_notes"}`，检查返回的 `inputSchema`：

- 顶层 `required` = `["trackIndex","groupIndex","edits"]`，**不含** fingerprint；
- `edits.items.required` = `["noteIndex","changes"]`，**不含** fingerprint；
- `edits.items.properties.fingerprint.description` =
  `Optional with a writeIntent contextId: the Runtime fills this guard from that Context. Required without a contextId; a value that disagrees with the Context fails with CONTEXT_SCOPE_MISMATCH.`
- `edits.description` 同时包含 `keep each call at or below 60 items` 与
  `can serve multiple batches`，且**不再**要求 `refresh the contextId between batches`；
- 顶层 `description` 不再含 `Each edit must include the fingerprint`。

实测响应 2857 字符（动作描述预算 12000）。再查 `delete_notes`：`notes.items.required`
应为 `["noteIndex"]`。

#### T2 — 公开目录里的两条描述（#2a、#3）

调 `tools/list`：

- `sv_describe.inputSchema.properties.action.description` =
  `Action name returned by sv_describe, for example "edit_notes".`
- `sv_query.inputSchema.properties.fields.description` =
  `Filters top-level keys of the result root only. Nested collections such as get_track_notes groups[].notes are not column-filtered.`

#### T3 — 配置默认值（#5、#8）

```bash
node -e "import('./dist/src/config.js').then(m=>{const c=m.loadConfig({},'/tmp');console.log(c.timeoutMs,c.staleRequestMs,c.lockWaitMs)})"
```

期望 `30000 60000 1000`。再验 clamp：`TIMEOUT_MS=400` + `LOCK_WAIT_MS=9000` 时
`lockWaitMs` 应为 `400`（收紧而非报错）。

### 3.3 真机用例（需要 SynthV + Bridge，按顺序执行）

#### T4 — 冷启动首查（#5）

Bridge 刚起时立刻 `sv_status {operation:"bridge"}` 与 `sv_query {action:"list_tracks"}`。
期望：均成功、无 `BRIDGE_TIMEOUT`。实测首调 5 ms。

#### T5 — 准备数据：加 30 个音符

`sv_command add_notes`，`args`：`trackIndex:1, groupIndex:1, grouping:"target"`，
`notes` 为 30 个 —— `onset = i*705600000`，`duration = 705600000`，
`pitch` 循环 `60,62,64,65,67,69,71,72`，`lyrics:"la"`。

期望：`{"outcome":"changed","changedCount":30,"undoRecords":1,"verified":true}`。

#### T6 — 嵌套音符压缩（#4）

`sv_query {"action":"get_track_notes","args":{"trackIndex":1,"limit":200}}`

- `groups[0].noteFormat` = `"rows"`；
- `groups[0].notes.columns` 恰为这 15 项：`absoluteDurationSeconds, absoluteOnsetSeconds,
  attributes, detune, duration, languageOverride, lyrics, musicalType, noteIndex, onset,
  phonemes, pitch, pitchAutoMode, rapAccent, retakeCount`；
- **不含**这 6 个冗余字段：`absoluteOnset`、`absoluteEnd`、`absoluteEndSeconds`、
  `endPosition`、`onsetQuarters`、`durationQuarters`。

**实测基线（同一页 29 个音符）**：

| 版本 | 响应字符数 | 每音符字段数 |
|---|---:|---:|
| 修改前 v0.3.0 | 15932 | 22 |
| 修改后 | 5966 | 15（且行列化） |

即 **−62.6%**。要复现"修改前"基线：`git stash push -- src tests && npm run build` 跑同一
查询，再 `git stash pop && npm run build`（注意必须同时 stash `tests`，否则构建过不去）。

传 `dense:"never"` 应只关掉行列化、保留字段压缩（30 音符时实测 12217 vs 6313 字符）。

#### T7 — fields 不再静默返回空对象（#2b）

```json
sv_query { "action": "get_track_notes", "args": { "trackIndex": 1, "limit": 200 },
           "fields": ["noteIndex","lyrics","onset"] }
```

期望包含：

- `projectionWarning`：`No requested field exists on the result root, ...`；
- `requestedFields` 原样回显；
- `availableFields` = `["groupCount","groups","hasMore","page","projectFile","returnedGroupCount","returnedGroupOffset","track","trackIndex"]`。

对照组 `fields:["groups"]` 应正常裁剪，返回 key = `["traceId","groups","page","hasMore"]`，
**不**带 warning。

#### T8 — Context 填充守卫与 fail-closed（#1）

先取 `sv_query get_track_notes` + `contextMode:"writeIntent"` 的
`groups[0].contextId`，然后：

| 子用例 | 请求 | 期望 |
|---|---|---|
| T8.1 | `edit_notes` 带 contextId，edits 里**完全不写** fingerprint | `outcome:"changed"`，`changedCount:3`，`verified:true` |
| T8.2 | 同样 edits，**不带** contextId 也不带 fingerprint | `outcome:"failed"`，`wrote:false`，`error.code:"BRIDGE_PROTOCOL_ERROR"`，message = `edits[1].fingerprint is required without a writeIntent contextId` |
| T8.3 | 带 contextId 但显式写一个与 Context 不符的 fingerprint | `CONTEXT_SCOPE_MISMATCH` |

T8.2 的重点是**在 TypeScript 层就拒绝**，而不是落到 Lua 的 `INVALID_ARGUMENT`。

#### T9 — Context 跨批复用语义（#6，README 依据）

| 步骤 | 操作 | 期望 |
|---|---|---|
| T9.1 | 用同一 contextId，批 1 改音符 10-12 | `changed` |
| T9.2 | **同一 contextId** 改音符 13-15（与批 1 不相交） | `changed` —— 证明可跨批复用 |
| T9.3 | **同一 contextId** 再改音符 10（批 1 已改过） | `STALE_NOTE`，`retry:"query_again"`，`wrote:false` |
| T9.4 | 删除中间音符 5，再用**旧 contextId** 改音符 6 | `STALE_NOTE`（索引移位） |

**若 T9.2 被拒绝，说明 README 第 2.3 节的结论错了，需要回改文档。** 这四条正是本次修复过程中
推翻初版错误表述的依据。

#### T10 — 单写者锁有界等待（#8）

起**两个独立 OS 进程**的客户端，同时发同一个 `sv_query get_track_notes`：

| 配置 | 期望 |
|---|---|
| 默认（`lockWaitMs`=1000） | **两个都成功**，合计约 100–200 ms（实测 132 ms） |
| `SYNTHV_AGENT_BRIDGE_LOCK_WAIT_MS=1`（模拟修复前） | 其中一个 `BRIDGE_BUSY`，`phase:"freshRead"` |

必须是两个进程；同一进程内的 `SerialExecutor` 会先串行化，测不出跨进程锁竞争。

### 3.4 收尾

- test.svp **不要保存**，直接关闭 SynthV 即可复原。
- 还原快捷键绑定：先关 SynthV，再用备份覆盖 `settings.xml`（SynthV 退出时会重写该文件，
  必须先关）。
- Bridge 用 **Stop SynthV Agent Bridge**（或 `ctrl + alt + shift + N`）停止。

---

## 4. 复测结论模板

复测完请按此结构回报，便于与本次结果对齐：

```
静态检查：S1 __/247（已知 doctor 失败：是/否） S2 __ S3 __ S4 toolCatalog=____
Schema： T1 __ T2 __ T3 __
真机：   T4 __ T5 __ T6 压缩前____字符 → 压缩后____字符（__%）
         T7 __ T8.1 __ T8.2 __ T8.3 __
         T9.1 __ T9.2 __ T9.3 __ T9.4 __
         T10 默认__ / 1ms__
不一致项：
```

---

## 附录 A：stdio MCP 客户端

未注册 MCP 宿主时用它直连 Runtime。存为 `client.mjs`，用
`node client.mjs <toolName> '<jsonArgs>'` 调用，或 `import { createClient }` 编排脚本。

```js
import { spawn } from "node:child_process";

const REPO = "D:/Project/test_projects/synthv-agent-bridge";

export function createClient(env = {}) {
  const child = spawn(process.execPath, ["dist/src/cli.js"], {
    cwd: REPO,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  let buffer = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== "") {
        try {
          const message = JSON.parse(line);
          if (pending.has(message.id)) {
            pending.get(message.id).resolve(message);
            pending.delete(message.id);
          }
        } catch {
          // ignore non-JSON stdout
        }
      }
      index = buffer.indexOf("\n");
    }
  });
  let nextId = 1;
  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout ${method}`));
        }
      }, 120_000).unref?.();
    });
  };
  return {
    async initialize() {
      const result = await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "verification-client", version: "0.0.0" },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
      );
      return result;
    },
    listTools: () => request("tools/list", {}),
    async call(name, args) {
      const response = await request("tools/call", {
        name,
        arguments: args ?? {},
      });
      const raw = response.result?.content?.[0]?.text;
      let json;
      try {
        json = raw === undefined ? undefined : JSON.parse(raw);
      } catch {
        json = raw;
      }
      return {
        isError: response.result?.isError === true,
        raw,
        json,
        error: response.error,
      };
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}
```

---

## 附录 B：改动文件与对应项

| 文件 | 对应 Issue 项 |
|---|---|
| `src/server.ts` | #1 guard 可选化与描述、#7 批量上限说明 |
| `src/v3-surface.ts` | #1 TS 层 fail-closed（`assertGuardsResolved`） |
| `src/v3-facade.ts` | #2a `fields` 描述、#3 `action` 描述 |
| `src/v3-query-projector.ts` | #2b `projectionWarning`、#4 `compactTrackNoteGroups` |
| `src/config.ts` | #5 超时与 stale 默认值、#8 `lockWaitMs` 及 clamp |
| `src/ipc/file-ipc-client.ts` | #8 `acquireLock` 有界等待 |
| `README.md` / `README_CN.md` | #2、#4、#5、#6、#7、#8 文档 |
| `CHANGELOG.md` | Unreleased 条目 |
| `tests/v3-surface.test.ts` | #1、#2b、#4 单测 |
| `tests/config.test.ts` | #5、#8 配置单测 |
| `tests/file-ipc-client.test.ts` | #8 锁等待与超时单测 |

## 附录 C：未处理项与已知偏差

- **未做**：#2 建议的 c 方案（真正的音符级列投影）——投入大，且 #4 的嵌套压缩已覆盖主要收益。
- **未做**：#6 的"单 contextId 链式多批写"新机制——实测该能力本已存在（见 2.3），只补了文档。
- **保留**：`edits` 的 `.max(512)` 不下调，按报告人建议只加说明。
- **已知失败**：`doctor validates both project-scoped host profiles on request`，成因见 3.1，
  与本次改动无关。
- **环境**：本机鼠标注入被屏蔽、键盘可用；`luac5.4` 名称不存在（用 `luac`/`luac54`）。
