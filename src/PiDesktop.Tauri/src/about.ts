import type { BootstrapState, ToolboxUpdateCheck, ToolboxUpdateDownload } from "./types";
import type { IconName } from "./icons";
interface AboutPageOptions { app: BootstrapState; product: { name: string; alternate: string; logo: string }; update: ToolboxUpdateCheck | undefined; download: ToolboxUpdateDownload | undefined; busy: boolean; locale: string; translate: (key: string) => string; escapeHtml: (value: unknown) => string; icon: (name: IconName, size?: number) => string; }
export function renderAboutPage(options: AboutPageOptions): string {
  const { app, update, escapeHtml, translate: t } = options;
  const release = update ? `<section class="about-release-result"><h3>${escapeHtml(update.releaseName)}</h3></section>` : "";
  const { name, alternate, logo } = options.product;
  const links = (["project", "issues", "terms"] as const).map((target) => `<button class="secondary" data-open-toolbox-project="${target}">${t(`about.${target}`)}</button>`).join("");
  return `<div class="panel about-layout"><section class="about-product"><div class="about-product-mark"><img class="brand-logo" src="${escapeHtml(logo)}" alt="" /></div><div class="about-product-copy"><h2>${escapeHtml(name)} <small>${escapeHtml(alternate)}</small></h2><p>${t("about.productDescription")}</p></div><dl class="about-product-details"><div><dt>${t("about.build")}</dt><dd>v${escapeHtml(app.appVersion)}</dd></div><div><dt>${t("about.license")}</dt><dd>Apache-2.0</dd></div><div><dt>${t("settings.platform")}</dt><dd>${escapeHtml(app.platform)}</dd></div></dl><div class="about-links">${links}</div><p class="about-notice">${t("brand.notAffiliated")}</p></section><section class="about-updates"><h2>${t("about.updates")}</h2><p>${t("about.updatesDescription")}</p><div id="update-channel-host" class="kit-fluent-select-host"></div><button class="secondary" data-check-toolbox-update ${options.busy ? "disabled" : ""}>${t("about.check")}</button>${release}</section></div>`;
}
