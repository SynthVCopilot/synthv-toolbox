# 存储与并发实现记录

## 数据映射

- `vault/slots/<slot-id>` 是该账号唯一的 SV2 数据根，包括 `databases`、`license/session`、设置与脚本。
- 每次并发启动创建一个唯一 Sandboxie box；其 `FileRootPath` 只保存该实例的 Sandboxie overlay。
- 该 box 通过 `OpenFilePath=<slot-root>\\` 让 SV2 直接读写账号权威根。Sandboxie 官方将 `FileRootPath` 定义为特定 box 的容器根，并说明 `OpenFilePath` 使匹配目录绕过重定向、直接更新外部目录。
- Sandboxie 的 `file.c` 会在生成 CopyPath 前解析 overlay 中的链接；`file_link.c` 也先尝试 overlay CopyPath。因此预先创建 overlay canonical AppData junction 能优先覆盖宿主 canonical junction，而 `OpenFilePath` 使 junction 目标直接写入 slot。创建前验证 overlay 父目录与 slot 根均不是 reparse point。
- 旧 `shared-databases` 和每 slot 的 copied sandbox tree 不再作为写入来源；迁移只解除受管 junction，不删除任何用户声库。

## 会话保护

- session guard 只保护 slot 权威根。并发实例共享同一账号 session，因此不为每个实例建立互相竞争的副本快照。
