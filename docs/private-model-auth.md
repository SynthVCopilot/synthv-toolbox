# 私有模型认证依赖

UI、认证核心与宿主授权适配器由私有 Platform Kit 的 `kits/model-auth` 提供，不再从公开 Release 安装。

先在已授权的 Platform Kit checkout 执行 `pnpm model-auth:pack`，然后在本项目根目录运行：

```sh
PLATFORM_KIT_PATH=/absolute/path/to/platform-kit node scripts/prepare-private-model-auth.mjs
```

再在 `src/PiDesktop.Tauri` 执行原有 npm 安装或构建命令。私有归档位于包目录的 `.platform-kit-private/model-auth/`，必须保持 gitignored，不能提交到公开仓库。

CI 需要专用的 Platform Kit 仓库只读凭据 `PLATFORM_KIT_TOKEN`。不得将个人 token、OAuth 凭据或私有源码写入公开配置。未配置凭据的外部 fork 无法重建该私有依赖；已有安装包不会因此自动删除或失效。
