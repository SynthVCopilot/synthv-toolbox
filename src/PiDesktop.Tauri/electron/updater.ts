import electronUpdater from "electron-updater";
import type { AppUpdater, ProgressInfo, UpdateInfo } from "electron-updater";

const { autoUpdater } = electronUpdater;

export type UpdaterPhase = "idle" | "checking" | "available" | "downloading" | "ready" | "error";

export interface UpdaterState {
  phase: UpdaterPhase;
  version?: string;
  progress?: number;
  error?: string;
}

export interface UpdaterService {
  check(): Promise<UpdaterState>;
  setChannel(channel: "stable" | "nightly"): void;
  restart(): Promise<UpdaterState>;
  state(): UpdaterState;
  onState(listener: (state: UpdaterState) => void): () => void;
}

export function createUpdaterService(client: AppUpdater = autoUpdater): UpdaterService {
  let state: UpdaterState = { phase: "idle" };
  const listeners = new Set<(next: UpdaterState) => void>();
  const setState = (next: UpdaterState) => {
    state = next;
    for (const listener of listeners) listener(state);
  };
  const version = (info: UpdateInfo) => info.version;

  client.autoDownload = true;
  client.autoInstallOnAppQuit = true;
  client.on("checking-for-update", () => setState({ phase: "checking" }));
  client.on("update-available", (info) => setState({ phase: "available", version: version(info) }));
  client.on("update-not-available", () => setState({ phase: "idle" }));
  client.on("download-progress", (progress: ProgressInfo) => setState({ phase: "downloading", progress: progress.percent }));
  client.on("update-downloaded", (info) => {
    setState({ phase: "ready", version: version(info) });
    client.quitAndInstall(false, true);
  });
  client.on("error", (error) => setState({ phase: "error", error: error.message }));

  return {
    setChannel(channel) {
      client.channel = channel === "nightly" ? "nightly" : "latest";
      client.allowPrerelease = channel === "nightly";
    },
    async check() {
      setState({ phase: "checking" });
      await client.checkForUpdates();
      return state;
    },
    async restart() {
      if (state.phase !== "ready") throw new Error("No downloaded update is ready to install.");
      client.quitAndInstall();
      return state;
    },
    state: () => state,
    onState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
