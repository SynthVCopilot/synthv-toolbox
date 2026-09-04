# 调研与发现

- 当前供应商弹窗入口只由设置页 `renderAiProviderSettings` 渲染；Copilot 头部只有静态 AI 标签，因此对话中不显示当前供应商或模型。
- `.sessions-panel` 使用固定 `rgba(243,243,243,.52)`，没有深色覆盖，导致用户截图中的整列亮灰色块。
- Composer 使用页面级网格和普通矩形 textarea，视觉上与消息区割裂；应限制最大宽度并改为底部悬浮圆角容器。
- 后端模型与模式状态已经在 `app.model`、`app.agentWorkMode` 中，无需新增状态或复制凭据。
