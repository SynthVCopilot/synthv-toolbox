# Findings

- [布局问题] -> 现有 `.http-api-form` 将两个端点开关、两项带长说明的特权开关、端口和保存按钮放进同一网格 -> 长文本与端口/保存操作争用列宽，窄窗口下无法保持清晰分组。
- [下拉组件] -> Connections 页面当前没有下拉控件；`@model-auth/vue` 仅提供模型连接相关组件，项目及相邻仓库均未安装或声明通用 Fluent kit -> 不以 `.fluent-select` 样式替代 kit 组件，等待确定应使用的包。
- [验证] -> `node test/http-mcp-ui.mjs`、`node test/autostart-behavior.mjs` 与 `npm run build:renderer` 均通过 -> 分组标记、窄窗口断点、语言选择器样式和 TypeScript/Vite 构建均已验证。
