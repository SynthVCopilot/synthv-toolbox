# 发现

- CI 的 `npm ci` 完成后，前端类型检查无法解析 `@synthv-toolbox/runtime-protocol`。
- 清单和 lockfile 根依赖遗漏 `file:../../packages/runtime-protocol`。
- 旧的本地 `node_modules` 链接掩盖了该问题；干净安装可以稳定复现。
