# 调研与发现

- 现有 OAuth 可保存多个账号，但 ProviderPool 每次固定从第一项开始，只具备故障转移而非负载均衡。
- 现有 API Key 以提供商 ID 作为唯一钥匙串账号，同一提供商只能保存一份密钥。
- 本次冻结契约将 API Key 元数据与密钥内容分离：UI 只接收 `AiApiKeySummary`，密钥输入提交后立即清空。
- Provider 级 `apiKeyModels` 是所有已验证 key 的模型并集，单个 key 的 `models` 仅用于显示资格数量；删除按 `credentialId` 执行。
- 语义复核后，认证方式不属于活动运行时；运行时只保存 provider+model，`models` 使用所有已配置凭据的模型并集，界面仍以添加连接时选定的方式过滤详情内容。
- 多凭据调度必须先按所选模型过滤资格，再轮转健康凭据；401/403 应失效对应凭据，429/5xx/传输错误应进入有界冷却并尝试下一项。
- OAuth/API Key 是新增凭据时的方式，不是运行时互斥模式；同一提供商与模型下两类合格凭据必须进入同一个调度池，否则无法实现用户要求的整体额度均衡。
- API Key 元数据现在按 UUID 独立保存，钥匙串账号严格使用 credential id；删除前校验 provider+id，设置保存失败时恢复钥匙串。
- runtime 的 route cursor 只按 provider+model 建立，候选携带 auth method，因此同一模型的 OAuth 与 API Key 会进入同一轮转队列；永久失效只能通过 upsert/重启恢复。
- `apiKeyModels` 为 provider 下全部 API Key 模型并集，`models` 为 OAuth/API Key 运行时并集；`apiKeys` 只输出非敏感摘要和 balancer 健康/冷却状态。
- 首次 Rust check 因 worktree 缺少受管 Bridge `node_modules` 失败，执行既有 `npm run build:bridge` 后恢复；最终 check/test 通过。
- 运行时 `models` 不能包含尚无 OAuth 账号时的静态潜在目录，否则可绕过 UI 选中没有任何凭据支持的模型；模型并集现只纳入已授权 OAuth 或已配置 Key 的目录。
