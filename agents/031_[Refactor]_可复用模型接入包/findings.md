# 调研与发现

- WorkBuddy 开放平台公开 OAuth 2.1 授权码流程及本地助理/云任务 API，但第三方应用必须先获得经审核的 `client_id`、`client_secret` 和登记回调地址；当前本机未发现 WorkBuddy 客户端或可复用注册信息。
- TRAE 官方公开资料目前说明的是企业为 TRAE 配置入站 OAuth SSO，以及在 TRAE 中添加第三方 API Key 模型；尚未发现允许外部桌面应用以 TRAE 账号 OAuth 调用其内置模型的公开出站 API。
- 可复用包应把“协议适配已实现”和“部署凭据已配置”分开表达，不能通过抓取其他客户端会话或私有端点制造不稳定接入。
- `/Users/user/development/platform-kit` 是现有复用技术包；其规则要求来源项目只读，且公共包不得复制品牌、域名、凭据或产品页面，因此通用向导和凭据调度进入 Platform Kit，WorkBuddy/TRAE 适配留在 Toolbox。
- Epilogue 远端 `main` 已有 Provider Source 搜索列表、OAuth 多账号和 WorkBuddy 登录/刷新实现，可作为同一所有者下的行为证据；其产品代码不直接复制，避免语言、许可证和维护耦合。
- TRAE 官方目前公开 CLI 浏览器登录、PAT 登录和企业管理 OpenAPI，但未公开把个人订阅作为第三方模型 API 的稳定接口；可优先集成官方 `traecli` 运行时，不宣称不存在的模型 OAuth API。
- TRAE 官方 CLI 2.0 提供 `login`、`exec --json`、`--output-schema`、`--ephemeral` 与 ACP/MCP；产品可把 CLI 自有浏览器登录视为外部 OAuth 凭据边界，并以受限非交互执行适配 Copilot，而无需读取其 token。
- WorkBuddy 运行时采用产品已验证的 `apiBase`/`chatBase` 协议：`POST /auth/state?platform=workbuddy`、`GET /auth/token?state=`、业务码 `11217` 有界等待、`GET /login/account?state=` 与 `POST /auth/token/refresh`；没有引入 client secret 配置。
- `OpenAiChatConfig` 支持完整 Chat Completions URL 和额外静态 headers；所有解析均受响应/事件大小上限保护。
- TraeCode 只解析 `traecli login`、`login status`、`exec --json --output-schema --ephemeral --sandbox read-only`；未找到 CLI 时报告不可用，不读取 token。
- 前端稳定契约将提供商认证能力显式建模为 `authMethods`，并以 `available/unavailableReason` 表达 TraeCode 的本机 CLI 状态；WorkBuddy 使用静态 `glm-5.2` 潜在模型目录，但未登录时运行时模型并集为空。
- Provider 列表按所选认证方式过滤：OAuth 展示四家，API Key 仅展示 Anthropic/OpenAI；不可用 OAuth 项仍可进入详情查看状态，但不会显示可选模型。
- WorkBuddy 连接实际验证了 `auth/state` 可返回 state+authUrl，未登录时 `auth/token` 返回业务码 11217；默认轮询窗口扩至约 10 分钟。
- WorkBuddy access 只在内存中使用；系统钥匙串仅保存 refresh 与 domain/user/enterprise routing envelope，序列化缓冲和凭据结构均归零。
- TraeCode `login status` 使用短超时缓存；缺少 CLI 时 `available=false` 并提供具体 unavailableReason，不能伪造连接。
- TraeCode `login` 使用独立 10 分钟超时；`login status` 使用短超时与短 TTL 缓存；exec 使用受管临时目录、文件 schema、`--output-last-message`、位置 prompt 和 `--skip-git-repo-check`。
