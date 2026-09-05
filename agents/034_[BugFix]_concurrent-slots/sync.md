# 默认同步审计

- 新增 `sync_defaults`，固定同步安全设置、脚本、用户词典和预设，始终 overwrite=true，并复用 dry-run token 校验与 execute 原子复制。
- `settings/settings.xml` 作为允许的单文件根直接处理；目录类别继续递归遍历。
- 受保护的 license、session、WebView2、Cookie、database 等路径仍被过滤，reparse point / 符号链接拒绝访问。
- 源目标相同直接返回空结果，避免自同步。
- 测试迁移至 `test/sv2_sync_tests.rs`，覆盖设置更新、脚本复制、保护数据不变和 symlink 拒绝。
