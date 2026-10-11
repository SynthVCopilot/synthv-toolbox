# Release process / 发布流程

## English

Stable releases are cut by pushing a tag named `vX.Y.Z`. Before tagging, set the same version in `src/PiDesktop.Tauri/package.json` and add `docs/releases/vX.Y.Z.md`; the first job of both release workflows fails when either is missing or the version differs.

Pushing the tag starts two independent workflows, so a Windows failure or rerun never affects macOS signing.

- **Desktop Windows Release** creates a draft release, builds the unsigned Windows installer and uploads it with electron-builder, then tries to publish the release.
- **Desktop Release** is macOS only. `macos-build` builds an unsigned arm64 app and packs it with the template disk image. `macos-source`, the only job that sees the signing key, downloads that bundle, submits it to the signing center and ends once the upload is complete.
- **Desktop macOS Publish** starts when `Desktop Release` succeeds. It waits for notarization (up to three hours), downloads the signed disk image, and verifies the report, Team ID, signature, staple and Gatekeeper result on a macOS runner. It then builds the updater zip from the signed app, writes `latest-mac.yml`, uploads the three files with `gh release upload --clobber` and tries to publish the release.

The release stays a draft until `latest.yml`, the Windows installer, `latest-mac.yml`, the disk image and the updater zip are all present. Whichever platform finishes last publishes it as the latest release, so no updater sees a release that lacks its platform.

Recovery:

- Windows failed: rerun the failed jobs of `Desktop Windows Release`. The last upload publishes the release.
- macOS publishing failed: start `Desktop macOS Publish` manually from `main` with the `Desktop Release` run id. The signing center keeps signed output for 24 hours after success; later recovery needs a new tag.
- `Desktop Release` itself cannot be rerun, because the signing center binds a request to the first attempt of a run. Delete the draft release and tag, then tag again.
- A prerelease tag fails `macos-source`; only stable tags are signed. Nightly builds stay unsigned and use their own workflow.

Repository settings:

- The center provisions the repository secret `SIGNING_API_KEY`; its GitHub credential needs access to this organization's repository, Actions secrets/variables and webhooks. The `macos-source` job also needs `id-token: write`: submit and every upload call fetch a fresh GitHub Actions OIDC token for the fixed signing origin.
- Restrict creation, update and deletion of stable tags and writes to `main` to the authorized release owner before enabling the project. The center checks that the tag commit is on `main` and that the run and identity belong to that owner.
- The signing center address is fixed in `.github/scripts/macos-signing-shared.mjs`; there is no `SIGNING_URL` variable.
- The center must accept tag runs of this repository's `Desktop Release` workflow.

Notes:

- The disk image carries no license agreement dialog. The terms of use stay in `src/PiDesktop.Tauri/electron/assets/TERMS-OF-USE.txt`.
- The signed app has the RunAsNode fuse turned off, so shipped code must not start the app binary as Node; a contract test guards this.
- Squirrel.Mac only installs an update whose signing identity matches the installed app. The signing center signs with Team ID `76DMUAK6J5`. If the macOS build installed today was signed by another team, those users must reinstall manually once; say so in the release notes of the first center-signed release.

## 中文

正式版通过推送 `vX.Y.Z` 标签发布。打标签前需要把 `src/PiDesktop.Tauri/package.json` 的版本改成同一版本，并添加 `docs/releases/vX.Y.Z.md`；两个发布工作流的第一个任务都会在缺少发布说明或版本不一致时失败。

推送标签会同时启动两个互相独立的工作流，Windows 失败或重跑不会影响 macOS 签名。

- **Desktop Windows Release** 先创建草稿 Release，再构建未签名的 Windows 安装包并通过 electron-builder 上传，最后尝试发布该 Release。
- **Desktop Release** 只负责 macOS。`macos-build` 构建未签名的 arm64 应用并与模板磁盘映像一起打包；`macos-source` 是唯一能读取签名密钥的任务，它下载这个包并提交给签名中心，上传完成后结束。
- **Desktop macOS Publish** 在 `Desktop Release` 成功后启动：最长等待三小时完成公证，下载已签名的磁盘映像，并在 macOS 运行器上校验报告、Team ID、签名、公证票据和 Gatekeeper 结果；随后用已签名的应用生成更新用 zip 和 `latest-mac.yml`，通过 `gh release upload --clobber` 上传三个文件，并尝试发布该 Release。

在 `latest.yml`、Windows 安装包、`latest-mac.yml`、磁盘映像和更新 zip 全部到齐之前，Release 保持草稿状态。后完成的平台负责把它发布为最新版本，因此任何平台的更新检查都不会看到缺少本平台文件的 Release。

恢复方式：

- Windows 失败：重跑 `Desktop Windows Release` 的失败任务，最后一次上传完成后会发布 Release。
- macOS 发布失败：在 `main` 上手动运行 `Desktop macOS Publish` 并填入 `Desktop Release` 的运行编号；签名中心在成功后只保留签名产物 24 小时，超时需要重新打标签。
- `Desktop Release` 本身不能重跑，因为签名中心把请求绑定到运行的第一次尝试。需要删除草稿 Release 和标签后重新打标签。
- 预发布标签会使 `macos-source` 失败，只有正式版标签会签名；夜间构建保持未签名，使用独立的工作流。

仓库设置：

- 中心自动配发仓库密钥 `SIGNING_API_KEY`，中心的 GitHub 凭据需要访问组织仓库并管理 Actions 密钥、变量和 webhook。`macos-source` 需要 `id-token: write`：提交和每次上传请求都会重新取得面向固定签名地址的 GitHub Actions OIDC 令牌。
- 启用项目前，将正式标签的创建、修改、删除以及 `main` 写入权限限定给获授权的发布者。中心核对标签提交位于 `main`，运行和身份令牌属于获授权账号。
- 签名中心地址固定在 `.github/scripts/macos-signing-shared.mjs` 中，不再有 `SIGNING_URL` 变量。
- 签名中心必须接受本仓库 `Desktop Release` 工作流的标签运行。

说明：

- 磁盘映像不再弹出许可协议，使用条款保留在 `src/PiDesktop.Tauri/electron/assets/TERMS-OF-USE.txt`。
- 已签名应用的 RunAsNode 熔丝为关闭状态，发布代码不能再把应用可执行文件当作 Node 启动，契约测试会检查这一点。
- Squirrel.Mac 只安装签名身份与已安装应用一致的更新。签名中心使用 Team ID `76DMUAK6J5`；如果当前已安装的 macOS 版本由其他团队签名，这些用户需要手动重装一次，并应在首个由签名中心签名的版本的发布说明中注明。
