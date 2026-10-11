# Release process / 发布流程

## English

Stable releases are cut by pushing a tag named `vX.Y.Z` that equals the version in `src/PiDesktop.Tauri/package.json`. Add `docs/releases/vX.Y.Z.md` before tagging.

- **Windows** is built by the `Desktop Release` workflow and published by electron-builder. The installer is not code-signed.
- **macOS** is signed and notarized by the signing center, never on the GitHub runner.
  1. The `macos-source` job of `Desktop Release` builds an unsigned arm64 app, packs it with the template disk image, submits it to the signing center and ends once the upload is complete.
  2. The `Desktop macOS Publish` workflow starts when `Desktop Release` succeeds. It waits for notarization (up to three hours), downloads the signed disk image, and verifies the report, Team ID, signature, staple and Gatekeeper result on a macOS runner.
  3. It then builds the updater zip from the signed app, writes `latest-mac.yml`, and uploads the disk image, the zip and the metadata to the release with `gh release upload --clobber`.
- Only stable tags are signed. A prerelease tag fails the `macos-source` job. Nightly builds stay unsigned and use their own workflow.
- Reruns are rejected. After a failed publish, start `Desktop macOS Publish` manually from `main` with the `Desktop Release` run id; the center keeps signed output for 24 hours after success, so later recovery needs a new tag.
- The repository needs the `SIGNING_URL` variable and the `SIGNING_API_KEY` secret, both provisioned by the signing center.
- The disk image carries no license agreement dialog. The terms of use stay in `src/PiDesktop.Tauri/electron/assets/TERMS-OF-USE.txt`.

## 中文

正式版通过推送与 `src/PiDesktop.Tauri/package.json` 版本一致的 `vX.Y.Z` 标签发布，打标签前需要先添加 `docs/releases/vX.Y.Z.md`。

- **Windows** 由 `Desktop Release` 构建并通过 electron-builder 发布，安装包不做代码签名。
- **macOS** 由签名中心签名并公证，不在 GitHub 运行器上签名。
  1. `Desktop Release` 的 `macos-source` 任务构建未签名的 arm64 应用，连同模板磁盘映像打包并提交给签名中心，上传完成后任务结束。
  2. `Desktop Release` 成功后触发 `Desktop macOS Publish`：最长等待三小时完成公证，下载已签名的磁盘映像，并在 macOS 运行器上校验报告、Team ID、签名、公证票据和 Gatekeeper 结果。
  3. 随后用已签名的应用生成更新用 zip 和 `latest-mac.yml`，再通过 `gh release upload --clobber` 把磁盘映像、zip 和元数据上传到对应 Release。
- 只有正式版标签会签名，预发布标签会使 `macos-source` 失败；夜间构建保持未签名，使用独立的工作流。
- 不支持重跑。发布失败后，可在 `main` 上手动运行 `Desktop macOS Publish` 并填入 `Desktop Release` 的运行编号；签名中心在成功后只保留签名产物 24 小时，超时需要重新打标签。
- 仓库需要由签名中心配置的 `SIGNING_URL` 变量和 `SIGNING_API_KEY` 密钥。
- 磁盘映像不再弹出许可协议，使用条款保留在 `src/PiDesktop.Tauri/electron/assets/TERMS-OF-USE.txt`。
