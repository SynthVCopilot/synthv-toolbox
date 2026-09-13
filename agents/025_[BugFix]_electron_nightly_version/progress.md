# 操作记录

- 已核对 Action `34780707532`：两平台验证与 artifact 上传成功；nightly job 返回成功但实际跳过发布，因此自动更新链路尚未完成验收。
- nightly 发布现在使用已有 `set-dev-version.mjs --next-patch` 生成包含提交短哈希的下一补丁预发行版本，并在 Builder 返回后校验平台安装包和 channel 元数据确实存在于新 Release。
- 版本格式调整为 `下一补丁-dev.<run number>.<短哈希>`，确保连续 nightly 在 SemVer 中单调递增。
- Action `34781376160` 的验证 job 全部通过，Windows 发布及资产校验通过；macOS 暴露出 Electron Builder 首次创建 Release 时的内部并发竞争。
- 新增平台矩阵之前的 Release 准备 job，让 Builder 仅上传资产。
