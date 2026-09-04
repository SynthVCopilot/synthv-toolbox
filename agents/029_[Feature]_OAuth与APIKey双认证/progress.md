# 操作记录

- 已读取用户第二张截图并确认登录详情只有 OAuth，API Key 无录入与状态管理入口。
- 已读取 `openai-docs` 并核对官方 OpenAI API 认证与模型枚举契约。
- 已定位 OAuth 凭据存储、ProviderPool、OpenAI Codex Responses 实现和供应商弹窗详情渲染。
- 已更新 `types.ts`、`api.ts` 与预览 API，接入 `AiAuthMethod`、API Key 配置/删除以及认证方式参与模型选择。
- 已在详情弹窗实现 OAuth/API Key 分段按钮、浏览器 OAuth 账号列表、API Key 密码输入、显示切换、配置状态、替换和删除；输入提交后立即清空。
- 已将搜索栏固定为弹窗整行，并补充小屏和深色主题继承样式。
- 已新增根目录 `test/dual-auth-ui.mjs`；`npm run build`、定向契约测试和 `git diff --check` 通过。
- 新增 `api_keys.rs`：独立 keyring 服务、15 秒有界模型验证、1 MiB 响应限制、模型 ID 过滤和可恢复的写入/删除事务。
- 扩展 settings/model summary/Tauri commands：认证方式序列化为 `oauth`/`api-key`，API Key 仅回传配置布尔值和非敏感模型列表。
- 扩展 OpenAI provider：OAuth 维持订阅 Responses endpoint；API Key 强制走 OpenAI Platform `/v1/responses`，不附带 account id。
- 执行 `npm run build:bridge` 生成被 Tauri 构建要求的本地 Bridge 输出；执行 `cargo fmt --all`、`cargo check -q`、`cargo test -q`，结果为 212 passed / 2 ignored。
- 将 Provider summary 拆为 `oauthModels` 与 `apiKeyModels`，OAuth 授权成功时明确把当前认证方法写为 OAuth；新增目录隔离序列化测试。
- 更新安装态 displayName/description，补充通用标签及 OAuth/API Key 双路径测试；全量 Rust 测试最终为 214 passed / 2 ignored。
