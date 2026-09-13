# 调查记录

- 插件后端已经通过通用 `invokeHost(permission, capability, operation, params)` 调用宿主能力，协议不限制 capability 名称。
- `plugin_manager::authorize_capability` 已同时检查插件声明、全局内部函数开关和插件级内部函数开关，可直接复用 `host.internal`。
- `sv2_session_kit` 已具备机器密钥解密、明文结构校验、密文哈希、不可覆盖备份、替换后校验和失败恢复。
- 现有 inspect/export 面向人工使用，会隐藏凭据或写到新文件；插件接口需要返回完整明文，才能编辑 access、refresh 和所有产品字段。
- 内部写入发生在 Toolbox 进程中，因此进程冲突检查需要豁免当前进程，同时继续阻止运行中的 SV2 或其他 Toolbox 实例。
- 真实 SV2 数据不用于实现验证；测试使用临时目录、合成令牌、合成密钥和合成产品行。
- 用户截图显示账号设置的离线操作行发生严重横向压缩，说明操作容器的布局约束没有为说明文本保留最小宽度。
- 离线协议和本地 session 写入是多阶段操作，当前单一 loading 状态无法判断停留位置，需要在 UI 中明确展示步骤状态。

## 接口决定

- capability 使用 `synthv.session`，操作为 `read` 和 `write`。
- `read` 参数为 `path`，返回完整 `plaintext`、当前 `encryptedSha256` 和路径。
- `write` 参数为 `path`、`expectedSha256`、`plaintext`，返回新哈希和备份路径。
- 写入只接受能被现有 session 校验器完整解析的明文，避免生成 SV2 无法读取的密文。
