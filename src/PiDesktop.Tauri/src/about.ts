import type { BootstrapState, ToolboxUpdateCheck, ToolboxUpdateDownload } from "./types";
import type { IconName } from "./icons";
interface AboutPageOptions { app: BootstrapState; update: ToolboxUpdateCheck | undefined; download: ToolboxUpdateDownload | undefined; busy: boolean; locale: string; translate: (key: string) => string; escapeHtml: (value: unknown) => string; icon: (name: IconName, size?: number) => string; }
export function renderAboutPage(options: AboutPageOptions): string {
  const { app, update, escapeHtml, translate: t } = options;
  const release = update ? `<section class="about-release-result"><h3>${escapeHtml(update.releaseName)}</h3></section>` : "";
  return `<div class="panel about-layout"><section class="about-product"><img class="brand-logo" src="./assets/synthv-toolbox-logo.svg" alt="Synthesizer V Toolbox" /><h2>Synthesizer V Toolbox</h2><p>${t("about.productDescription")}</p><dl><dt>${t("about.build")}</dt><dd>v${escapeHtml(app.appVersion)}</dd></dl></section><section class="about-updates"><h2>${t("about.updates")}</h2><p>${t("about.updatesDescription")}</p><div id="update-channel-host" class="kit-fluent-select-host"></div><button class="secondary" data-check-toolbox-update ${options.busy ? "disabled" : ""}>${t("about.check")}</button>${release}</section></div>`;
}
