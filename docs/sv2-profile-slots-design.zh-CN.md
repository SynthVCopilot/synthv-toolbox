# SV2 账号槽位启动器设计

状态：顺序槽位已实现；并发隔离为实验性可选能力
目标版本：Synthesizer V Studio 2 Pro 2.2.1 / Windows 10、11
范围：同一 Windows 用户、同一物理设备上的快速顺序切换，以及受约束的多进程隔离实验

## 1. 决策摘要

工具箱提供类似游戏启动器的“账号档案”体验：用户选择一个槽位，工具箱将该槽位设为当前默认环境并启动 SV2。用户直接从开始菜单、资源管理器或 `.svp` 文件启动 SV2 时，也自然使用最近激活的默认槽位。

第一版不解析、复制或修改 `license\session`，而是把整个 SV2 用户数据根视为不可分割的槽位：

```text
%APPDATA%\Dreamtonics\Synthesizer V Studio 2
```

当前槽位真实占用上述官方路径；其他槽位停放在同一父目录下的工具箱保管区。切换通过同卷目录重命名完成，不安装驱动、不注入进程、不修改 SV2 二进制，也不改变系统文件关联。

普通启动路径同一时刻最多激活一个槽位。实验性并发路径使用 Sandboxie Plus / Classic 为每个已准备槽位建立持久化的文件、注册表和 IPC 隔离空间；它是独立能力，不改变普通槽位的事务模型。

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

1. 槽位必须包含完整数据根，不能只切换 `license\session`。
2. 切换前必须确认 standalone、DAW 插件和相关 WebView2 子进程均已退出。
3. 槽位切换只解决快速顺序切换，不声称支持两个 standalone 并发。
4. 任何在线会话过期都交还 SV2 的官方登录流程处理。

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
- 普通启动按钮：`普通启动` 或 `切换并启动`；
- 隔离启动按钮：`准备隔离实例` 或 `启动隔离实例`；
- 次按钮：`设为默认`、打开数据目录；
- 低频的重命名和数据路径收纳到“管理槽位与存储位置”折叠区。

用户名和邮箱仅作为用户填写的工具箱本地元数据；不从 `license/session`、Cookie 或 WebView2 缓存推断账号邮箱，不读取产品清单，也不保存 Dreamtonics 密码。

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

用户第一次点击“准备隔离实例”时，工具箱从该槽位建立一份持久化、不透明的完整副本。之后点击“启动隔离实例”会通过对应 Sandboxie box 启动 SV2 standalone；普通槽位和隔离副本各自保存本地变化，不做运行中合并。

普通槽位被 SV2 / 插件占用时只阻止普通切换，不应错误阻止已经准备好的其他隔离实例启动。同一个 Sandboxie box 已运行时，界面显示“运行中”并禁用重复启动。

## 4. 文件布局

```text
%APPDATA%\Dreamtonics\
├─ Synthesizer V Studio 2\                    # 当前激活槽位
└─ Synthesizer V Studio 2.toolbox-slots\
   ├─ slots\
   │  ├─ 0c8f...\                             # 停放槽位的完整数据根
   │  └─ a01d...\
   └─ trash\                                  # 后续版本的可恢复移除区

%LOCALAPPDATA%\SynthVToolbox\
└─ sv2-slots\
   ├─ manifest.json
   ├─ switch.journal.json
   └─ switch.lock
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
3. 通过 `ProcessStartInfo` 直接启动检测到的 `synthv-studio.exe`。
4. 如果传入工程路径，使用 `ArgumentList` 添加绝对 `.svp` 路径。
5. 不使用 shell 拼接命令，不把槽位信息放入 SV2 命令行。

现有 `SynthVDetectionService` 必须补充实际文件名：

```text
synthv-studio.exe
```

如果当前槽位已经运行：

- 选择同一槽位时显示“正在运行”，可提供“切换到窗口”；
- 选择其他槽位时显示阻塞程序并要求用户自行保存、关闭；
- 工具箱不发送强制结束进程命令。

## 9. 文件拦截与并发评估

### 9.1 第一版：不拦截

顺序切换不需要文件拦截。保持官方路径不变并轮换完整数据根，兼容性比以下方案更高：

- 注入并 Hook `SHGetKnownFolderPath`、`CreateFileW`；
- 给 WebView2 子进程追加私有数据目录；
- 文件系统 minifilter 驱动；
- 将 SV2 重新打包进 AppContainer；
- 修改 SV2 的单实例互斥量。

### 9.2 已实现的实验性进程树隔离

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
%APPDATA%\Dreamtonics\Synthesizer V Studio 2.toolbox-slots\concurrent\<slot-id>\box
```

工具箱同时为该 sandbox 配置独立 `KeyRootPath` 和 `IpcRootPath`，从而覆盖 SV2 进程树、WebView2 子进程以及命名对象，而不是只改主进程看到的文件路径。启动使用 Sandboxie `Start.exe /box:<name> /silent` 接口，box 名称前不添加 `#`；配置通过 `SbieIni.exe` 写入并回读校验 `FileRootPath`。

当前入口只并发启动 SV2 standalone。工具箱不会把已有 DAW 宿主强行移入 sandbox，因此不承诺隔离 DAW 内的 SV2 插件实例。

并发能力默认关闭，只有用户对某槽位点击“准备隔离实例”后才启用。第一次实际启动并发实例前，界面必须提示这不是 Dreamtonics 官方支持的行为，并在用户明确确认后持久化该选择。首次准备复制完整不透明数据根，不解析 `license\session`；后续隔离实例直接在持久化副本上运行。隔离副本不会自动覆盖或合并回普通槽位，避免把两个运行中的数据库、WebView2 状态或 session 做文件级拼接。网络不被工具箱拦截，持续验证以及同账号/工程同步仍由 Dreamtonics 官方服务决定。

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
- 服务对象保持无网络、无账号解析。

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
- 后端支持带 `.svp` 工程启动；
- 展示 standalone、DAW 插件、文件句柄和单实例锁阻塞提示。

### Phase 4：受控验证（自动化部分已实现，真实账号往返需人工执行）

- 账号 A 登录、关闭、切换到新槽位；
- 账号 B 官方登录、关闭；
- A/B 往返各三次，确认账号与产品列表未串槽；
- 模拟每个事务阶段崩溃并验证无覆盖恢复；
- 验证直接启动和工具箱启动使用同一默认槽位；
- 验证 standalone、WebView2 或 DAW 插件运行时拒绝切换。

### Phase 5：实验性并发隔离（代码、自动化检查和本机 standalone 冒烟测试已通过，多账号登录仍需人工验证）

- 探测 Sandboxie Plus / Classic 并拒绝低于 1.17.6 / 5.72.6 的版本；
- 为槽位原子准备带标记的持久化不透明副本；
- 配置并回读每槽位 `FileRootPath`、注册表根和 IPC 根；
- 允许不同槽位并发启动，拒绝同一 sandbox 重复启动；
- 第一次并发启动前显示非官方支持警告，并确保 Sandboxie `/box:<name>` 参数不含 `#`；
- 不拦截网络，不解析登录缓存，不自动合并隔离副本；
- 已在 Sandboxie Classic 5.73.2 + SV2 2.2.1 上验证：普通 SV2 保持运行时，第二个 boxed SV2 主窗口可响应，WebView2 进程树正常，网络连接保持建立；测试结束后可正常关闭并清理 box。
- 上述测试未确认 Dreamtonics 的并发登录、设备计数、账号同步或云工程政策；这些行为必须在用户自己的合法账号上人工确认。

## 13. 必测不变量

1. 空闲状态下 canonical 必须存在且只属于一个槽位。
2. 同一个槽位不能同时出现在 canonical 和保管区。
3. 任何切换失败都不得删除或覆盖目录。
4. 未完成日志存在时不得启动新切换。
5. 任何未知 reparse point 或越界最终路径都必须 fail closed。
6. SV2/插件/WebView2 有占用时不得移动数据根。
7. 工具箱日志和清单不得包含账号凭据或登录缓存内容。
8. 工具箱卸载后，当前槽位仍位于官方路径，SV2 可正常直接启动。
9. 并发副本只能由与槽位 UUID 匹配的工具箱标记识别，未知目录不得覆盖。
10. 并发配置写入后必须回读并确认 `FileRootPath` 指向该槽位的受管目录。
11. 普通槽位与并发副本之间不得做运行中合并；官方联网验证保持由 SV2 自身负责。
