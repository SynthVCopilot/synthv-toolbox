# 操作记录

- 已读取用户第二张截图并确认登录详情只有 OAuth，API Key 无录入与状态管理入口。
- 已读取 `openai-docs` 并核对官方 OpenAI API 认证与模型枚举契约。
- 已定位 OAuth 凭据存储、ProviderPool、OpenAI Codex Responses 实现和供应商弹窗详情渲染。
- 已更新 `types.ts`、`api.ts` 与预览 API，接入 `AiAuthMethod`、API Key 配置/删除以及认证方式参与模型选择。
- 已在详情弹窗实现 OAuth/API Key 分段按钮、浏览器 OAuth 账号列表、API Key 密码输入、显示切换、配置状态、替换和删除；输入提交后立即清空。
- 已将搜索栏固定为弹窗整行，并补充小屏和深色主题继承样式。
- 已新增根目录 `test/dual-auth-ui.mjs`；`npm run build`、定向契约测试和 `git diff --check` 通过。
