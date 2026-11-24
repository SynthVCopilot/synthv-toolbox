import { createApp, nextTick, reactive } from "vue";
import AppShell from "./AppShell.vue";
import { i18n } from "../i18n";

export type ShellPage = "home" | "accounts" | "import" | "convert" | "analysis" | "quality" | "lyrics" | "history" | "copilot" | "components" | "bridge" | "connections" | "settings" | "about";

export interface ShellState {
  page: ShellPage;
  sidebarCollapsed: boolean;
  sidebarHtml: string;
  title: string;
  subtitle: string;
  bridgeConnected: boolean;
  busy: boolean;
  pageHtml: string;
  noticeHtml: string;
  errorHtml: string;
  overlayHtml: string;
}

export interface ShellController {
  update(next: ShellState): void;
  afterUpdate(callback: () => void): void;
}

export function mountShell(element: HTMLElement, initial: ShellState): ShellController {
  const state = reactive<ShellState>({ ...initial });
  createApp(AppShell, { state }).use(i18n).mount(element);
  return {
    update(next) { Object.assign(state, next); },
    afterUpdate(callback) { void nextTick(callback); },
  };
}
