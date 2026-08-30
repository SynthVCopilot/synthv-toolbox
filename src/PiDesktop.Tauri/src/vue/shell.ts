import { createApp, nextTick, reactive } from "vue";
import AppShell from "./AppShell.vue";

export type ShellPage = "home" | "accounts" | "toolbox" | "lyrics" | "history" | "copilot" | "components" | "bridge" | "mcp" | "settings";

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
  createApp(AppShell, { state }).mount(element);
  return {
    update(next) { Object.assign(state, next); },
    afterUpdate(callback) { void nextTick(callback); },
  };
}
