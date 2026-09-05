# 调研记录

- [全部账号显示会话同步失败] -> 脱敏读取三个真实槽位的结构、文件大小、隔离状态与安装版本 -> 槽位已各自只有一份实际数据，主目录 junction 指向正确槽位。并非仍在运行旧程序或缺失授权文件；未输出任何令牌或账号身份。
- [可正常登录却不显示授权] -> 本地解密后仅检查公开 JWT 元数据与有效期 -> 实际 azp 是 `svstudio2-agent`，与原固定 client ID 不一致；issuer 与受信官方 issuer 相同。客户端现在从固定 issuer 下的原会话读取有效 azp，绝不从 JWT 拼接任意请求地址。
- [刷新被归为可能轮换] -> 使用占位 refresh 值分别请求旧/正确 client ID，不发送用户 refresh token -> 两者均得到 HTTP 403、HTML、Cloudflare challenge。旧实现把明确非成功响应、传输中断和不完整成功响应混为 Ambiguous，造成槽位长期 SyncFailed。新实现区分 Unavailable、Rejected、Expired、UnsupportedClient 与真正的 Ambiguous。
- [有效会话仍强制刷新] -> 使用用户已授权的只读诊断请求官方授权 API -> 返回 5 个授权；调用前后原会话文件指纹完全一致。其他两个槽位 access token 已过期；远端 403 仍会阻碍这些槽位刷新，不能声称客户端修改已消除该外部限制。
- [旧隔离状态阻止授权读取] -> 使用加密的合成会话执行生产只读探测分支 -> 活跃与空闲场景均可在授权确认且源文件未变化后解除旧隔离；并发修改时丢弃结果并保留隔离；读取失败不写回或轮换会话。
- [完整真实恢复诊断] -> 后续增加 opt-in 批量探测入口，并在网络前要求 access token 至少剩余两分钟 -> 实际主槽 token 在长时间调查后已过期，诊断在预条件断言停止，未调用刷新/注册/写回。该次不是完整真实恢复通过；合成端到端回归通过。
- [安装程序被列为实例] -> 检查宽松名称匹配与实际安装目录 -> 只接受准确的 SynthV/Flat 可执行名称及产品路径，排除 setup/updater。版本从 PE 固定版本资源读取。保留 SV1/Flat 发现与控制；仅 SV2 映射账号。
- [PID 复用风险] -> 检查操作验证和执行顺序 -> Windows 对同一打开句柄验证映像与启动时间再执行操作；每次只授予必要查询/终止权限，拒绝旧身份与非 SynthV 目标。
- [简洁实例展示] -> 浏览器预览实际点击、展开、轮询及终止确认 -> 主行显示产品、版本、账号和工程；PID/路径默认收起，轮询保留展开状态；终止前使用应用内对话框并保留原始进程身份，只删除指定实例。
- [浏览器原生 confirm 卡住自动化] -> 首次预览终止触发原生确认后后续浏览器控制超时 -> 改为应用内对话框，再在新预览页完成交互检查。临时旧预览页无法通过已提供 API 正常关闭，未操作用户原有页面。
- [Rust 全量测试权限错误] -> 测试链接完成但执行报 OS error 5，随后用户提供火绒删除 `target/debug/deps/synthv_toolbox_lib-ccf65ef5788c1616.exe` 的日志 -> 删除对象是本地 lib test 程序，构建链是 rustc → link.exe，链接器 Microsoft Authenticode 有效；样本已不存在，不能验证其哈希、内容或确认误报。
- [误报规避请求] -> 主工作区与独立子 agent 只读检查 Windows/native API、build.rs、已安装发布 PE 和签名 -> 未发现远程进程内存注入、shellcode、混淆或关闭防护代码。进程回环音频、受管媒体进程 Job Object、精确终止均有既有功能用途。已安装 PE 为普通用户权限 `asInvoker`、`uiAccess=false`，具有 High Entropy VA、Dynamic base、NX；产品/版本元数据正常但 NotSigned。没有依据为改变检测结果盲目删功能或调整编译参数。
- [后续误报处理边界] -> 查阅 Microsoft 应用清单、签名与软件开发者 FAQ，以及火绒公开资料 -> 签名用于可验证的发布者身份，不保证无恶意/不误报；争议样本应由检测厂商复核。用户临时关闭防护不是验证条件。未恢复隔离文件、未添加排除、未向第三方上传样本。

参考：https://learn.microsoft.com/en-us/windows/win32/sbscs/application-manifests 、https://learn.microsoft.com/en-us/defender-xdr/developer-faq 、https://learn.microsoft.com/en-us/windows/win32/secbp/understanding-pe-signatures 。

- [远端 macOS lint 失败] -> e5f3df6 的运行 33992629554 已通过 macOS 全量测试与新增控制 harness，但 lint 报 `is_strict_synthv_executable_path` dead_code -> 此 helper 仅供 Windows 句柄内复核使用，应添加 Windows cfg，不能放宽 lint。
