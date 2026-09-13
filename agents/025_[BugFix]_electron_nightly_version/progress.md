# 操作记录

- 已核对 Action `34780707532`：两平台验证与 artifact 上传成功；nightly job 返回成功但实际跳过发布，因此自动更新链路尚未完成验收。
- nightly 发布现在使用已有 `set-dev-version.mjs --next-patch` 生成包含提交短哈希的下一补丁预发行版本，并在 Builder 返回后校验平台安装包和 channel 元数据确实存在于新 Release。
- 版本格式调整为 `下一补丁-dev.<run number>.<短哈希>`，确保连续 nightly 在 SemVer 中单调递增。
