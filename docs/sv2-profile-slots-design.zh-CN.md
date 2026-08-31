# SV2 账号槽位启动器设计

状态：顺序槽位与并发隔离均已实现；并发隔离是可选能力
目标版本：Synthesizer V Studio 2 Pro 2.2.1 / Windows 10、11
范围：同一 Windows 用户、同一物理设备上的快速顺序切换，以及受约束的正式多进程隔离能力

## 1. 决策摘要

工具箱提供类似游戏启动器的“账号档案”体验：用户选择一个槽位，工具箱将该槽位设为当前默认环境并启动 SV2。用户直接从开始菜单、资源管理器或 `.svp` 文件启动 SV2 时，也自然使用最近激活的默认槽位。

槽位事务不解析或单独切换 `license\session`，而是切换完整的账号私有数据根。唯一例外是受工具箱管理的 `databases` junction：它指向同一份全局声库数据，不随账号切换。

```text
%APPDATA%\Dreamtonics\Synthesizer V Studio 2
```

当前槽位真实占用上述官方路径；其他槽位停放在同一父目录下的工具箱保管区。切换通过同卷目录重命名完成，不安装驱动、不注入进程、不修改 SV2 二进制，也不改变系统文件关联。

普通启动路径同一时刻最多激活一个槽位。并发路径使用 Sandboxie Plus / Classic 为每个已准备槽位建立持久化的文件、注册表和 IPC 隔离空间；它是独立能力，不改变普通槽位的事务模型。

## 2. 已验证事实与设计约束

本机 SV2 2.2.1 使用以下数据结构：

```text
Synthesizer V Studio 2\
├─ license\session
├─ webview2\EBWebView\Default\
├─ settings\settings.xml
├─ databases\
├─ cache\
└─ scripts\
```

- `license\session` 是高熵二进制状态，不是可独立管理的明文配置。
- WebView2、产品数据库、区域设置、脚本和许可会话会共同构成一个可用环境。
- standalone 进程创建了 `\BaseNamedObjects\Applock_SVStudio2_Pro` 命名互斥量。该对象位于全局 BaseNamedObjects 命名空间，而不是某个 Windows 用户的普通文件目录。
- 官方数据根当前没有公开的 per-process 命令行覆盖参数。
- 当前主实现位于 `src/PiDesktop.Tauri`，由 Tauri 前端调用 Rust Core；Windows 后端可以直接使用 Restart Manager、ToolHelp 进程/模块枚举和同卷目录重命名。

因此：

1. 槽位必须保留完整的账号私有数据，不能只切换 `license\session`；受管 `databases` junction 是唯一允许的共享项。
2. 切换前必须确认 standalone、DAW 插件和相关 WebView2 子进程均已退出。
3. 槽位切换只解决快速顺序切换，不声称支持两个 standalone 并发。
4. 账号登录指示器关闭时，在线会话过期仍完全交还 SV2；开启且显式预检时，工具箱可以复刻官方 refresh 流程并原子更新加密 session。
5. 账号登录指示器默认关闭，首次开启必须弹窗确认。预检可以解密本机 `license/session` 取得 JWT、只读查询许可清单，并固定以 `kickout_other_sessions=false` 发送官方客户端的真实 `enroll_device` 登录事件；它可能登记或续用本设备，不是 dry-run。不得自动发送 `true`、踢出其他会话，亦不得把 JWT、解密密钥、明文 session 或完整响应写入日志、清单或前端；前端只可接收 JWT 标准 claims 中经过长度、控制字符、空白与邮箱格式检查的 `name` / `email`，并可用 `preferred_username` 作为姓名回退。

Windows 对全局和会话级命名对象的区别见 [Kernel object namespaces](https://learn.microsoft.com/en-us/windows/win32/termserv/kernel-object-namespaces)。

## 3. 用户体验

工具箱增加一级导航项“SV2 账号”。页面先并列解释两条启动路线，再按账号展示启动器式卡片：

- `普通启动`：使用当前默认槽位；切换账号前必须退出普通 SV2 / 插件进程；
- `隔离启动`：使用 Sandboxie 为该槽位启动独立实例；准备完成后可与普通实例或其他隔离槽位并发；
- 隔离提供方区域显示实际识别到的 Sandboxie 版本线、版本号、安装目录、已准备数量和运行数量；
- 网络持续验证与官方同步明确标为 SV2 / Dreamtonics 负责，工具箱不代理网络。

每个账号卡片包含：

- 用户自定义名称，例如“主账号”“制作账号”“测试账号”；
- 用户自行填写的用户名和邮箱标签；
- 自定义颜色或头像首字母；
- 状态：`当前默认`、`登录缓存已存在`、`首次启动需要登录`、`未准备`、`已准备`、`运行中`、`需要处理`；
- 最近使用时间；
- 会话缓存是否存在，仅作为诊断信息，不宣称账号仍在线有效；
- 登录态保护状态：`保护就绪`、`正在监测`、`等待恢复`、`已自动恢复` 或 `需要处理`；
- 普通启动按钮：`普通启动` 或 `切换并启动`；
- 隔离启动按钮：`准备隔离实例` 或 `启动隔离实例`；
- 全局隔离内容默认值：分别控制应用设置和声库数据是否隔离；
- 每个账户的应用设置、声库数据均可选择“跟随全局”“开启隔离”或“关闭隔离（共享）”，并显示解析后的实际状态；
- 普通切换遇到占用时显示进程确认弹窗，提供取消、强制切换和以并发模式运行；
- 次按钮：`设为默认`、打开数据目录；
- 低频的重命名和数据路径收纳到“管理槽位与存储位置”折叠区。

槽位用户名和邮箱仍是用户填写的工具箱本地元数据。只有用户确认开启账号登录指示器并执行预检后，界面才可额外显示从 access JWT 标准 claims 提取并清洗的姓名/邮箱作为识别信息；这些值不从 Cookie 或 WebView2 缓存推断，不写回槽位清单，也不得连同 JWT 或其他 claims 一起暴露。预检从许可响应提取有效声库产品名和计数；服务返回的 device ID 仅按 SV2 原格式保留在其加密 session 内，不进入工具箱清单或前端。工具箱不保存 Dreamtonics 密码、JWT 明文、预检得到的账号姓名/邮箱或完整产品响应。

### 3.1 首次使用

如果官方数据根已存在但没有工具箱槽位标记：

1. 展示“导入当前 SV2 环境”；
2. 用户输入槽位名称；
3. 工具箱只在根内写入槽位标记并创建清单，不移动现有数据；
4. 该槽位成为当前默认槽位。

如果官方数据根不存在，则允许创建一个新的空槽位并立即启动 SV2，由 SV2 创建数据和完成官方登录。

### 3.2 新建账号槽位

1. 在保管区创建只含工具箱标记的新目录；
2. 用户点击“切换并启动”；
3. 工具箱将当前槽位停放并把新槽位移到官方路径；
4. 启动 SV2；
5. 用户在 Dreamtonics 官方界面完成登录。

不提供“复制槽位”，避免无意复制登录会话和账号拥有的产品状态。

### 3.3 默认启动

“默认”不是一个代理进程或命令行参数，而是当前真实占用官方路径的槽位：

```text
开始菜单 / 双击 synthv-studio.exe / 双击 .svp
                         │
                         ▼
%APPDATA%\Dreamtonics\Synthesizer V Studio 2
                         │
                         ▼
                   当前默认槽位
```

因此工具箱不运行时，SV2 仍然保持正常启动行为。

### 3.4 隔离启动

启用隔离功能后，工具箱会为现有和新建槽位自动准备一份持久化、不透明的隔离副本。账号卡默认从该隔离副本启动 SV2 standalone；普通槽位仍保留为用户主动选择的回退路径，不做运行中合并。

所有槽位和隔离实例共享一份受管声库数据库。每个普通槽位的 `databases\` 都是指向该稳定目录的 junction；Sandboxie 通过 box 级 `OpenFilePath` 访问当前官方根的同一 junction。`settings`、`license`、`webview2`、其他文件、注册表和 IPC 继续使用各自环境的私有空间；并发下载或更新声库时仍可能争写共享目录，因此不保证该场景。

普通槽位被 SV2 / 插件占用时只阻止普通切换，不应错误阻止已经准备好的其他隔离实例启动。同一个 Sandboxie box 已运行时，界面显示“运行中”并禁用重复启动。

用户从“切换并启动”触发普通切换且存在占用时，界面不得只显示错误文本，而应弹出结构化进程列表。选择“强制切换并启动”表示用户授权结束列表中的进程树；后端必须重新检测 PID，使用独立命令参数结束进程，并在占用与单实例锁全部消失后才进入槽位事务。选择“以并发模式运行”不得关闭现有进程；若目标隔离副本尚未准备，应先准备副本，并继续遵守首次非官方行为确认。

### 3.5 账号占用锁与登录态恢复

SV2 在发现同一账号仍由其他设备占用时，会由官方界面询问是否强制结束另一设备的会话。用户取消而不强制时，SV2 可能移除本机 `license/session`。工具箱不拦截对话框，也绝不模拟“确认踢出”；登录态恢复把 session 当作不透明字节，账号登录指示器则在用户 opt-in 后通过独立模块解密真实 session，并只模拟固定为 false 的初始登录事件。普通启动和隔离启动采用同一套保护状态机：

1. 启动前只在 session 已存在时建立原样字节快照，并保存 SHA-256、槽位 UUID、环境类型和启动时间；
2. 启动后的前 10 分钟为冲突识别窗口。session 在窗口内消失且快照仍匹配时，标记 `RecoveryPending`；超过窗口才消失则视为用户主动退出或普通过期，不自动恢复；
3. 下次由工具箱启动同一槽位前，如果 session 仍不存在且没有占用进程，回写校验通过的快照；
4. 如果 SV2 已生成任何新的非空 session，立即丢弃旧快照，绝不覆盖；正常退出且 session 保留时也清理短期快照；
5. 普通槽位和对应 Sandboxie 隔离副本使用不同的保护记录，禁止跨环境恢复或合并；
6. 恢复只尝试还原本地缓存，最终是否有效仍由 SV2 与 Dreamtonics 服务权威判断。

指示器关闭时，进入“SV2 账号”页面只读取普通槽位与本机进程状态。用户在风险弹窗中明确开启后，每次从其他页面进入账号页执行一次预检，之后只允许用户通过“重新预检/刷新”显式触发；不得定时轮询，也不得由页面恢复可见、选择性同步、`.svp` 路由或启动命令旁路触发敏感接口。本机普通/插件/WebView2/Sandboxie 占用可以确定；`RecoveryPending` 或 `enroll_device(false)` 返回的并发/需踢出错误可以确定 Busy；只有该登录事件被接受时才可标记 Clear。没有近期脱敏缓存时必须显示为 `Unknown`，不能声称“无人使用”。

一次显式预检每个槽位只读取一个启动权威：已准备隔离副本时使用隔离根，否则使用普通根。权威副本只提交一次 refresh、一轮原生等价的 `enroll_device(false)` 检查和一次授权查询；所有请求必须保持 `kickout_other_sessions=false`。普通回退副本不参与预检写回，因此它的缺失、占用或旧缓存不会把可启动的隔离账号标记为 `SyncFailed`。不同槽位不得跨写；权威副本的响应无法安全验证时，仅该副本保持隔离，直到后续显式预检成功。

普通根与 Sandboxie 根在物理上仍是两个文件系统副本，这是隔离并发的必要条件；但两者属于同一个账号槽位。账号页必须合并呈现一个账号级结论：任一未占用启动环境通过无踢出登录预检，即可显示“至少一个启动环境可用”；只有所有候选环境均不可用时才显示 Busy、过期或未知。普通/隔离的独立结果只供启动模式选择和诊断，不得并排显示成互相矛盾的账号登录状态。本地 `databases` 目录只用于安装与工程匹配证据，不得在账号卡上显示为授权；账号授权只来自官方许可响应或用户明确确认的补充记录。

## 4. 文件布局

```text
%APPDATA%\Dreamtonics\
├─ Synthesizer V Studio 2\                    # 当前激活槽位，databases 为 junction
├─ Synthesizer V Studio 2.shared-databases\   # 所有槽位共用的实际声库数据
└─ Synthesizer V Studio 2.toolbox-slots\
   ├─ slots\
   │  ├─ 0c8f...\                             # 停放槽位的账号私有数据根，databases 为 junction
   │  └─ a01d...\
   └─ trash\                                  # 后续版本的可恢复移除区

%LOCALAPPDATA%\SynthVToolbox\
└─ sv2-slots\
   ├─ manifest.json
   ├─ switch.journal.json
   ├─ switch.lock
   └─ session-recovery\<slot-id>\
      ├─ normal.json / concurrent.json
      └─ normal.session / concurrent.session   # 仅监测或待恢复时存在
```

约束：

- 官方路径与槽位保管区必须位于同一卷；不允许网络路径。
- 槽位 ID 为工具箱生成的 GUID；目录名不使用邮箱或用户输入。
- 所有路径由程序从固定根组合，不接受任意目标路径。
- 不改变目录 ACL，不把账号数据放进仓库或云同步目录。

槽位数据放在官方目录的同一父目录，是为了保证目录重命名不会退化成复制和删除。Windows 的跨卷 `MoveFileEx` 可能退化为复制再删除，因此实现必须明确拒绝跨卷切换，见 [MoveFileEx](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexa)。

## 5. 数据模型

`manifest.json` 只保存非敏感元数据：

```json
{
  "schemaVersion": 1,
  "activeSlotId": "0c8fd8f4-3e0d-4c48-97c1-377167d5f158",
  "slots": [
    {
      "id": "0c8fd8f4-3e0d-4c48-97c1-377167d5f158",
      "displayName": "主账号",
      "username": "Producer",
      "email": "producer@example.com",
      "color": "#5B8DEF",
      "createdAtUtc": "2026-08-28T20:00:00Z",
      "lastActivatedAtUtc": "2026-08-28T20:00:00Z"
    }
  ]
}
```

每个槽位数据根包含标记文件：

```text
.synthv-toolbox-slot.json
```

内容仅包含 `schemaVersion` 和 `slotId`。标记随完整数据根移动，用来在清单损坏或切换中断后识别官方路径当前属于哪个槽位。

程序不得在日志、清单或 UI 中写入：

- Dreamtonics 密码；
- Cookie 或 WebView2 加密值；
- `license\session` 内容；
- 登录回调 URL；
- 从缓存推断出的邮箱。

`session-recovery` 是唯一允许保存 session 原始字节的位置。它位于当前 Windows 用户的 LocalAppData 中，文件名只由槽位 UUID 和固定环境名组成；快照不进入日志、清单、前端、仓库或云同步目录，正常结束或发现新 session 后立即删除。

## 6. 状态机

### 6.1 系统状态

```text
Idle ──选择其他槽位──► Preflight
 ▲                         │
 │                         ├─有占用──► Blocked ──用户关闭程序──┐
 │                         │                                  │
 │                         ▼                                  │
 └──── Commit ◄──── ActivateTarget ◄──── ParkCurrent ◄────────┘

任意切换阶段崩溃 ──► RecoveryRequired ──确定性恢复──► Idle
```

### 6.2 槽位状态

- `Active`：数据根位于官方路径，且根标记与清单一致。
- `Parked`：数据根位于保管区。
- `New`：槽位存在，但没有 `license\session`；启动后由用户首次登录。
- `Missing`：清单有记录，但活动路径和保管区都找不到该槽位。
- `RecoveryRequired`：目录实况、标记、清单或事务日志不一致。
- `SessionMonitoring`：本次工具箱启动已有短期保护快照。
- `SessionRecoveryPending`：启动窗口内 session 消失，等待下一次工具箱启动恢复。

UI 不把“存在 session 文件”显示为“已登录”，因为在线状态只能由 SV2/服务端权威判断。

## 7. 切换事务

设当前槽位为 `A`，目标槽位为 `B`：

```text
canonical = %APPDATA%\Dreamtonics\Synthesizer V Studio 2
parkA     = ...toolbox-slots\slots\A
parkB     = ...toolbox-slots\slots\B
```

### 7.1 预检

1. 获取工具箱自己的跨进程切换锁。
2. 如果存在未完成日志，先恢复，不开始新事务。
3. 校验清单、槽位标记和固定路径边界。
4. 校验 canonical、parkA、parkB 在同一卷。
5. 拒绝未知 reparse point、符号链接或越界最终路径。
6. 检查 SV2 standalone、WebView2 和加载 SV2 插件的 DAW 进程。
7. 使用 Restart Manager 查询关键文件占用。
8. 有任何占用时只列出阻塞程序，不自动结束进程。

Restart Manager 可以把文件注册为资源，并查询正在使用这些资源的应用，见 [RmRegisterResources](https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/nf-restartmanager-rmregisterresources) 和 [RmGetList](https://learn.microsoft.com/zh-cn/windows/win32/api/restartmanager/nf-restartmanager-rmgetlist)。

关键资源至少包括存在的：

```text
license\session
settings\settings.xml
webview2\EBWebView\Local State
webview2\EBWebView\Default\Network\Cookies
```

Restart Manager 不是唯一判断依据。还要检查：

- `synthv-studio.exe`；
- 命名互斥量 `Applock_SVStudio2_Pro`，作为诊断提示而非稳定 API；
- 命令行引用该 WebView2 数据根的 `msedgewebview2.exe`；
- 已加载 `Synthesizer V Studio 2 Plugin.vst3` 或 ARA 插件的进程。

### 7.2 持久化事务步骤

1. 写入并强制刷新 `switch.journal.json`，阶段为 `Prepared`。
2. `Directory.Move(canonical, parkA)`；刷新日志阶段为 `CurrentParked`。
3. `Directory.Move(parkB, canonical)`；刷新日志阶段为 `TargetActivated`。
4. 从 canonical 内的标记复核槽位 ID 为 `B`。
5. 原子更新 `manifest.json` 的 `activeSlotId` 和最近使用时间。
6. 刷新日志阶段为 `Committed`，再移除日志。
7. 释放切换锁。

目录移动禁止覆盖目标。任何意外存在的目录都触发失败和恢复界面，绝不通过删除来“修复”。

两次重命名之间存在一个极短的 canonical 缺口。若用户恰好从外部启动 SV2 并创建了新目录，第二次重命名会失败；日志必须保留，并把新目录作为未知数据呈现给用户，不能覆盖。

### 7.3 恢复判定

恢复以“实际目录 + 根标记 + 日志”为权威，清单只作为期望状态：

| canonical | parkA | parkB | 推断 | 恢复动作 |
|---|---|---|---|---|
| A | 不存在 | B | 尚未移动 | 清除未执行的 `Prepared` 日志 |
| 不存在 | A | B | 当前已停放 | 将 B 移到 canonical，继续提交 |
| B | A | 不存在 | 目标已激活 | 更新清单并提交 |
| 其他/标记不符 | 任意 | 任意 | 外部修改或竞争启动 | 停止自动恢复，展示路径和只读诊断 |

恢复过程不删除任何目录。

## 8. 启动流程

`切换并启动(slotId, optionalProjectPath)`：

1. 如果目标不是当前槽位，执行完整切换事务。
2. 再次确认清单和根标记一致。
3. 恢复同一槽位仍待处理且 SHA-256 匹配的 session，再为本次启动建立短期保护快照。
4. 通过 Rust `Command` 直接启动检测到的 `synthv-studio.exe`。
5. 如果传入工程路径，使用独立参数添加绝对 `.svp` 路径。
6. 不使用 shell 拼接命令，不把槽位信息放入 SV2 命令行。

现有 `SynthVDetectionService` 必须补充实际文件名：

```text
synthv-studio.exe
```

如果当前槽位已经运行：

- 选择同一槽位时显示“正在运行”；
- 选择其他槽位时显示阻塞程序并要求用户自行保存、关闭；
- 用户在结构化弹窗中明确选择“强制切换”时，后端重新扫描并结束检测到的进程树；否则不结束进程。

## 9. 文件拦截与并发评估

### 9.1 第一版：不拦截

顺序切换不需要文件拦截。保持官方路径不变并轮换账号私有数据根；仅受管 `databases` junction 固定指向全局声库目录，兼容性比以下方案更高：

- 注入并 Hook `SHGetKnownFolderPath`、`CreateFileW`；
- 给 WebView2 子进程追加私有数据目录；
- 文件系统 minifilter 驱动；
- 将 SV2 重新打包进 AppContainer；
- 修改 SV2 的单实例互斥量。

### 9.2 已实现的进程树隔离

仅重定向一个 AppData 目录仍不够，因为必须同时处理：

1. SV2 主进程的 Known Folder 与文件访问；
2. WebView2 子进程的数据根；
3. DAW 内插件进程；
4. DPAPI 用户上下文；
5. 全局 `Applock_SVStudio2_Pro`；
6. 更新器、崩溃恢复和音频驱动。

用户态 API Hook 容易漏掉直接 NT 文件调用和子进程。minifilter 能覆盖文件系统，但需要管理员权限、驱动签名、安全维护和版本兼容；而且它仍不能自然虚拟化全局命名互斥量。Windows 的 reparse point 与文件系统过滤机制见 [Reparse points](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points)。

因此实现没有编写 DLL 注入或文件系统驱动，而是把共享同一隔离核心的 Sandboxie Plus / Classic 作为可选提供方。每个槽位使用确定性的 sandbox 名称，并把 `FileRootPath` 指向：

```text
%APPDATA%\Dreamtonics\Synthesizer V Studio 2.toolbox-slots\c\<slot-id-prefix>
```

工具箱同时为该 sandbox 配置独立 `KeyRootPath` 和 `IpcRootPath`，从而覆盖 SV2 进程树、WebView2 子进程以及命名对象，而不是只改主进程看到的文件路径。`FileRootPath` 保持绝对路径以便回读验证，但使用短目录名控制长度；启动使用 Sandboxie `Start.exe /box:<name> /silent` 接口，box 名称前不添加 `#`。选择共享的隔离内容只为受管声库 junction 写入 box 级 `OpenFilePath`，不会扩大为整个 SV2 数据根或其他账户目录。

当前入口只并发启动 SV2 standalone。工具箱不会把已有 DAW 宿主强行移入 sandbox，因此不承诺隔离 DAW 内的 SV2 插件实例。

并发隔离是正式可选能力，其技术方案基于 Sandboxie 进程树虚拟化实现，不是 Dreamtonics 原生多实例功能。第一次实际启动并发实例前，界面必须提示这种多实例使用方式尚未被 Dreamtonics 官方承认，并在用户明确确认后持久化该选择。告知内容应说明：工具箱不修改 SV2 二进制、不绕过账户限制、不拦截官方联网验证，但这不构成 Dreamtonics 对账号政策或服务条款兼容性的确认；截至当前版本开发组没有收到相关官方警告或处理记录，但官方仍可能将其认定为不当或违规使用；用户启用即表示知情、自担风险，并在适用法律允许的最大范围内不追究开发组的直接或连带责任。首次准备复制完整不透明数据根，不解析 `license\session`；后续隔离实例直接在持久化副本上运行。隔离副本不会自动覆盖或合并回普通槽位，避免把两个运行中的数据库、WebView2 状态或 session 做文件级拼接。网络不被工具箱拦截，持续验证以及同账号/工程同步仍由 Dreamtonics 官方服务决定。

出于安全原因，提供方版本低于 Sandboxie Plus 1.17.6 / Classic 5.72.6 时拒绝启用；复制源、目标和中间树中出现 reparse point 时 fail closed。若 Sandboxie 未安装或配置受密码保护，普通顺序切换不受影响。

## 10. RDPWrap 决策

不采用 RDPWrap。

原因不是 UI 偏好，而是它没有解决本设计的核心约束：

- 多远程桌面会话只能天然隔离会话级对象；SV2 当前的 `Applock` 位于全局 BaseNamedObjects 命名空间；
- 同一 Windows 用户数据根仍需额外隔离；
- DAW、音频设备和插件跨会话增加新的同步问题；
- RDPWrap 依赖非官方的系统服务兼容层，Windows 更新后稳定性和安全维护成本不可接受。

当前并发方案的优先级仍然低于官方原生支持：

1. Dreamtonics 官方多实例/多账号支持；
2. 不同 Windows 用户运行不同 DAW 插件进程的受控实验；
3. 本实现的 Sandboxie Plus / Classic 进程树隔离；
4. 完整 VM/Windows Sandbox 级隔离。

## 11. 项目集成点

已新增：

```text
src/PiDesktop.Tauri/src-tauri/src/sv2_profiles.rs
src/PiDesktop.Tauri/src-tauri/src/sv2_concurrent.rs
src/PiDesktop.Tauri/src-tauri/src/sv2_session_guard.rs
```

已修改：

```text
src/PiDesktop.Tauri/src-tauri/src/synthv.rs
src/PiDesktop.Tauri/src-tauri/src/state.rs
src/PiDesktop.Tauri/src-tauri/src/commands.rs
src/PiDesktop.Tauri/src-tauri/src/lib.rs
src/PiDesktop.Tauri/src/main.ts
src/PiDesktop.Tauri/src/api.ts
src/PiDesktop.Tauri/src/types.ts
src/PiDesktop.Tauri/src/styles.css
```

复用现有约定：

- 账号启动器作为 Tauri 单页前端中的 Windows 专用导航页；
- 本地非敏感清单放在 `%LOCALAPPDATA%\SynthVToolbox`；
- 进程启动使用 Rust `Command` 的独立参数，不拼 shell 字符串；
- 后端错误通过 Tauri command 返回并由现有 toast 展示；
- 槽位切换、路由预览和启动服务保持无网络、无账号解析；只有 opt-in 的账号登录指示器刷新入口可以解密 session、刷新 JWT 并访问账号服务。

## 12. 实施阶段

### Phase 1：只读发现（已实现）

- 修正 SV2 2.2.1 可执行文件检测；
- 发现官方数据根、槽位保管区和当前进程；
- 展示当前目录大小、session 是否存在和阻塞程序；
- 不做任何移动。

### Phase 2：槽位事务（已实现）

- 导入当前环境；
- 创建空槽位；
- 实现切换日志、同卷重命名和恢复；
- 实现设为默认；
- 第一版不提供永久删除和复制。

### Phase 3：启动器 UI（已实现）

- 账号卡片内区分“普通启动”和“隔离启动”；
- 展示用户填写的用户名和邮箱标签，不从 SV2 会话数据推断身份；
- 显示默认路由、登录缓存、隔离准备和运行状态；
- 显示实际 Sandboxie 版本线、版本号、安装目录与实例统计；
- 将重命名和存储路径收纳到可展开管理区；
- 将普通切换占用提示改为弹窗，提供强制结束已检测进程树或转入并发模式的选择；
- 后端支持带 `.svp` 工程启动；
- 展示 standalone、DAW 插件、文件句柄和单实例锁阻塞提示。
- 在账号页展示当前账号占用预检；只有进入页面和手动刷新才更新本机占用与远端冲突证据。

### Phase 4：受控验证（自动化部分已实现，真实账号往返需人工执行）

- 账号 A 登录、关闭、切换到新槽位；
- 账号 B 官方登录、关闭；
- A/B 往返各三次，确认账号与产品列表未串槽；
- 模拟每个事务阶段崩溃并验证无覆盖恢复；
- 验证直接启动和工具箱启动使用同一默认槽位；
- 验证 standalone、WebView2 或 DAW 插件运行时拒绝切换。

### Phase 5：并发隔离（代码、自动化检查和本机 standalone 冒烟测试已通过，多账号登录仍需人工验证）

- 探测 Sandboxie Plus / Classic 并拒绝低于 1.17.6 / 5.72.6 的版本；
- 为槽位原子准备带标记的持久化不透明副本；
- 配置并回读每槽位 `FileRootPath`、注册表根和 IPC 根；
- 允许不同槽位并发启动，拒绝同一 sandbox 重复启动；
- 第一次并发启动前显示非官方支持警告，并确保 Sandboxie `/box:<name>` 参数不含 `#`；
- 不拦截网络；复制和恢复流程不解析登录缓存；独立账号登录指示器仅在 opt-in 后显式解密真实 session、按“槽位 + 账号主体”选取唯一 authority，必要时刷新并把凭据原子收敛到闲置副本，再提交无踢出登录事件；
- 已在 Sandboxie Classic 5.73.2 + SV2 2.2.1 上验证：普通 SV2 保持运行时，第二个 boxed SV2 主窗口可响应，WebView2 进程树正常，网络连接保持建立；测试结束后可正常关闭并清理 box。
- 上述测试未确认 Dreamtonics 的并发登录、设备计数、账号同步或云工程政策；这些行为必须在用户自己的合法账号上人工确认。

### Phase 6：账号占用锁（代码与自动化检查已实现，真实双设备取消流程需人工验证）

- 普通与隔离启动前分别建立不透明 session 快照和 SHA-256；
- 启动窗口内 session 消失时标记待恢复，窗口外视为主动退出；
- 下次启动前仅在目标为空时恢复，同槽位新 session 永远优先；
- 指示器默认关闭且开启前必须确认；开启后只在进入账号页和用户手动刷新时预检本机进程、会话失效证据、缓存 JWT 与无踢出登录事件；其他页面与智能路由只读脱敏缓存，不触发敏感接口；
- 自动化覆盖 session 丢失恢复、新 session 不覆盖、正常退出清理和窗口外主动退出。

## 13. 必测不变量

1. 空闲状态下 canonical 必须存在且只属于一个槽位。
2. 同一个槽位不能同时出现在 canonical 和保管区。
3. 任何切换失败都不得删除或覆盖目录。
4. 未完成日志存在时不得启动新切换。
5. 任何未知 reparse point 或越界最终路径都必须 fail closed。
6. SV2/插件/WebView2 有占用时不得移动数据根。
7. 工具箱日志、清单与 Tauri 序列化结果不得包含 JWT、账号凭据、明文登录缓存、其他 JWT claims 或完整许可响应；用户确认开启指示器后，Tauri 结果只可包含经过清洗的 `name` / `email` 识别值。解密缓冲和 key 在使用后清零。
8. 工具箱卸载后，当前槽位仍位于官方路径，SV2 可正常直接启动。
9. 并发副本只能由与槽位 UUID 匹配的工具箱标记识别，未知目录不得覆盖。
10. 并发配置写入后必须回读并确认 `FileRootPath` 指向该槽位的受管目录。
11. 普通槽位与并发副本之间不得做运行中合并；只有受管声库数据库可共享，官方联网验证保持由 SV2 自身负责。
12. 强制切换不得接收前端指定的 PID；结束进程后必须重新扫描占用，仍有占用时不得开始目录事务。
13. 登录态恢复快照必须与槽位 UUID、普通/隔离环境及 SHA-256 全部匹配，目标已有非空 session 时不得覆盖。
14. 工具箱不得把缺乏证据的远端占用显示为“无人使用”；只有 `enroll_device(false)` 在本次检查中被接受时才显示 `Clear`，明确冲突显示 `Detected`，其余一律为 `Unknown`。
