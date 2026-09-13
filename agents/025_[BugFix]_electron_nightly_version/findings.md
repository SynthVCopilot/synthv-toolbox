# 调查记录

- [nightly job 成功但 Release 没有新资产] -> 检查 Electron Builder 日志 -> package 版本仍为已发布多日的 `0.2.0`，Builder 将 EXE、DMG 与更新清单全部标记为 skipped publishing。
- [只使用提交哈希不能保证更新顺序] -> SemVer 会比较预发行标识符，随机哈希不具备单调性 -> 使用 GitHub run number 作为数字排序段，并保留短哈希用于定位提交。
