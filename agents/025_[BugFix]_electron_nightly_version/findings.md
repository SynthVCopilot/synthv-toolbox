# 调查记录

- [nightly job 成功但 Release 没有新资产] -> 检查 Electron Builder 日志 -> package 版本仍为已发布多日的 `0.2.0`，Builder 将 EXE、DMG 与更新清单全部标记为 skipped publishing。
- [只使用提交哈希不能保证更新顺序] -> SemVer 会比较预发行标识符，随机哈希不具备单调性 -> 使用 GitHub run number 作为数字排序段，并保留短哈希用于定位提交。
- [macOS 首次发布返回 422] -> DMG 与 blockmap 的并发 publisher 同时尝试创建同一 Release，一个成功而另一个因 tag 创建竞争失败 -> 在平台矩阵开始前单独创建 Release。
