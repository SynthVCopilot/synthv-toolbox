# 技术调研

- Rust 主应用原先直接承载 Agent、Provider 和工具执行，修改 AI 行为会触发原生层重新编译。
- Pi SDK 适合作为独立 Node Runtime：会话、扩展和工具生命周期留在 TypeScript，Rust 只维护稳定的进程与能力边界。
- model-auth core 能统一凭据选择和 Provider adapter；当前适配器并非都提供通用 request/stream，因此不能一次性替换已有全部模型链路。
- 插件 GUI 使用独立资源协议和 sandbox iframe；GUI 只经消息桥调用后端，不接触宿主凭据。
- 插件后端属于受信任的本地代码。宿主能力仍按 manifest 权限声明检查并由 Rust 路由。
- 首次 Cargo 检查因前端 Bridge 构建产物不存在而失败；统一预构建脚本生成依赖后检查通过。
