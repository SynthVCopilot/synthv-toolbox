import { createApp, nextTick, reactive } from "vue";
import AppShell from "./AppShell.vue";
import { i18n } from "../i18n";
import type { PluginPageId, RegisteredPluginPage } from "./pluginRegistry";

export type HostShellPage = "home" | "accounts" | "import" | "convert" | "analysis" | "quality" | "lyrics" | "history" | "copilot" | "ai" | "components" | "bridge" | "connections" | "plugins" | "settings" | "about";
export type ShellPage = HostShellPage | PluginPageId;

export interface ShellState {
  page: ShellPage;
  sidebarCollapsed: boolean;
  sidebarHtml: string;
  title: string;
  subtitle: string;
  bridgeConnected: boolean;
  busy: boolean;
  pageHtml: string;
  pageActionsHtml: string;
  pluginPage?: RegisteredPluginPage;
  noticeHtml: string;
  errorHtml: string;
  overlayHtml: string;
}

export interface ShellController {
  update(next: ShellState): void;
  updateToast(noticeHtml: string, errorHtml: string): void;
  afterUpdate(callback: () => void): void;
}

export function mountShell(element: HTMLElement, initial: ShellState): ShellController {
  const state = reactive<ShellState>({ ...initial });
  createApp(AppShell, { state }).use(i18n).mount(element);
  return {
    update(next) { Object.assign(state, next); },
    // Patches only the toast, so an approval decision or Stop can surface it without a
    // full-page re-render resetting conversation scroll, open <details> and selection.
    updateToast(noticeHtml, errorHtml) { Object.assign(state, { noticeHtml, errorHtml }); },
    afterUpdate(callback) { void nextTick(callback); },
  };
}
