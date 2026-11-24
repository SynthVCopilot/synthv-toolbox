import type { BootstrapState, ToolboxUpdateCheck, ToolboxUpdateDownload } from "./types";
import type { IconName } from "./icons";

interface AboutPageOptions {
  app: BootstrapState;
  update: ToolboxUpdateCheck | undefined;
  download: ToolboxUpdateDownload | undefined;
  busy: boolean;
  locale: string;
  translate: (key: string, params?: Record<string, unknown>) => string;
  escapeHtml: (value: unknown) => string;
  icon: (name: IconName, size?: number) => string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderDownload(options: AboutPageOptions): string {
  const { app, download, escapeHtml, icon, translate: t } = options;
  const state = download ?? { status: "idle", downloadedBytes: 0 } satisfies ToolboxUpdateDownload;
  const fileName = state.fileName ? escapeHtml(state.fileName) : "";
  const installerAvailable = Boolean(options.update?.installer);
  if ((!options.update?.updateAvailable || !installerAvailable) && !["downloading", "ready", "failed"].includes(state.status)) {
    return options.update?.updateAvailable ? `<div class="about-empty-update">${t("about.noInstaller")}</div>` : "";
  }
  if (state.status === "downloading") {
    const ratio = state.totalBytes && state.totalBytes > 0 ? Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 100)) : undefined;
    const progress = ratio === undefined ? "" : `<div class="about-download-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${ratio}"><span style="width:${ratio}%"></span></div>`;
    const description = state.totalBytes
      ? t("about.downloaded", { current: formatBytes(state.downloadedBytes), total: formatBytes(state.totalBytes) })
      : t("about.downloadedUnknown", { current: formatBytes(state.downloadedBytes) });
    return `<div class="about-download-state downloading"><div><strong>${t("about.downloading")}</strong><small>${escapeHtml(description)}</small>${fileName ? `<small>${fileName}</small>` : ""}</div>${progress}<button class="secondary compact" data-cancel-toolbox-update ${options.busy ? "disabled" : ""}>${t("about.cancelDownload")}</button></div>`;
  }
  if (state.status === "ready") {
    const macos = app.platform === "macos";
    return `<div class="about-download-state ready"><div><strong>${t("about.readyToInstall")}</strong>${fileName ? `<small>${fileName}</small>` : ""}${macos ? `<small>${t("about.macInstallGuide")}</small>` : ""}</div><div class="about-download-actions"><button class="secondary compact" data-cancel-toolbox-update ${options.busy ? "disabled" : ""}>${t("about.discardDownload")}</button><button class="primary" data-install-toolbox-update ${options.busy ? "disabled" : ""}>${icon("download", 16)} ${macos ? t("about.openDiskImage") : t("about.installWindows")}</button></div></div>`;
  }
  if (state.status === "failed") return `<div class="about-download-state failed"><div><strong>${t("about.downloadFailed")}</strong><small>${escapeHtml(state.error ?? "")}</small></div><button class="secondary" data-download-toolbox-update ${options.busy ? "disabled" : ""}>${icon("sync", 16)} ${t("about.retryDownload")}</button></div>`;
  return `<div class="about-download-state"><div><strong>${t("about.available")}</strong>${fileName ? `<small>${fileName}</small>` : ""}</div><button class="primary" data-download-toolbox-update ${options.busy ? "disabled" : ""}>${icon("download", 16)} ${t("about.download")}</button></div>`;
}

export function renderAboutPage(options: AboutPageOptions): string {
  const { app, update, escapeHtml, icon, translate: t } = options;
  const status = update?.updateAvailable ? t("about.available") : update?.latestVersion === update?.currentVersion ? t("about.current") : update ? t("about.newer") : "";
  const published = update?.publishedAtUtc ? new Date(update.publishedAtUtc).toLocaleString(options.locale) : "";
  const checked = update?.checkedAtUtc ? new Date(update.checkedAtUtc).toLocaleString(options.locale) : "";
  const latestLabel = update?.channel === "nightly" ? t("about.latestNightly") : t("about.latestStable");
  const currentVersionIsNewer = Boolean(update && !update.updateAvailable && update.latestVersion !== update.currentVersion);
  const releaseNotes = update && !currentVersionIsNewer ? `<div class="about-notes"><strong>${t("about.releaseNotes")}</strong><pre class="update-release-notes">${escapeHtml(update.releaseNotes.trim() || t("about.noNotes"))}</pre></div>` : "";
  const releaseAction = update?.updateAvailable ? `<div class="about-release-actions"><button class="secondary compact" data-open-toolbox-releases ${options.busy ? "disabled" : ""}>${icon("arrow", 16)} ${t("about.openRelease")}</button></div>` : "";
  const updateResult = update ? `<section class="about-release-result ${update.updateAvailable ? "available" : currentVersionIsNewer ? "ahead" : "current"}"><div class="about-update-status"><span class="feature-icon ${update.updateAvailable ? "orange" : "emerald"}">${icon(update.updateAvailable ? "download" : "check", 22)}</span><div><span class="availability ${update.updateAvailable ? "warning" : "ready"}">${escapeHtml(status)}</span><h3>${escapeHtml(update.releaseName)}</h3><small>${t("about.published")} ${escapeHtml(published)} · ${t("about.checked")} ${escapeHtml(checked)}</small></div></div><div class="result-dashboard compact"><div><small>${t("about.currentVersion")}</small><strong>v${escapeHtml(update.currentVersion)}</strong></div><div><small>${latestLabel}</small><strong>v${escapeHtml(update.latestVersion)}</strong></div></div>${releaseNotes}${releaseAction}${renderDownload(options)}</section>` : renderDownload(options);
  const updateAssetActive = options.download?.status === "downloading" || options.download?.status === "ready";
  return `<div class="panel about-layout"><section class="about-product" aria-label="${t("about.product")}"><div class="about-product-mark"><img class="brand-logo" src="/assets/synthv-toolbox-logo.svg" alt="Synthesizer V Toolbox" /></div><div class="about-product-copy"><span class="eyebrow">SYNTHESIZER V TOOLBOX</span><h2>Synthesizer V Toolbox</h2><p>${t("about.productDescription")}</p><code class="about-project-url">github.com/SynthVCopilot/synthv-toolbox</code></div><dl class="about-product-details"><div><dt>${t("about.build")}</dt><dd>v${escapeHtml(app.appVersion)}</dd></div><div><dt>${t("about.platform")}</dt><dd>${escapeHtml(app.platform)}</dd></div><div><dt>${t("about.license")}</dt><dd>Apache-2.0</dd></div></dl><div class="about-links"><button class="secondary" data-open-toolbox-project="project">${icon("github", 16)} ${t("about.project")}</button><button class="secondary" data-open-toolbox-project="guide">${icon("info", 16)} ${t("about.guidance")}</button><button class="secondary" data-open-toolbox-project="issues">${icon("warning", 16)} ${t("about.issues")}</button></div></section><section class="about-updates" aria-label="${t("about.updates")}"><div class="section-heading"><div><h2>${t("about.updates")}</h2><p>${t("about.updatesDescription")}</p></div></div><div class="about-update-controls"><label class="field"><span>${t("about.channel")}</span><select class="fluent-select" id="update-channel" ${options.busy || updateAssetActive ? "disabled" : ""}><option value="stable" ${app.updateChannel === "stable" ? "selected" : ""}>${t("about.stable")}</option><option value="nightly" ${app.updateChannel === "nightly" ? "selected" : ""}>${t("about.nightly")}</option></select><small>${app.updateChannel === "nightly" ? t("about.nightlyDescription") : t("about.stableDescription")}</small></label><div class="about-check-action"><div><small>${t("about.currentVersion")}</small><strong>v${escapeHtml(app.appVersion)}</strong></div><button class="secondary" data-check-toolbox-update ${options.busy || updateAssetActive ? "disabled" : ""}>${icon("sync", 16)} ${update ? t("about.checkAgain") : t("about.check")}</button></div></div>${updateResult}</section></div>`;
}
