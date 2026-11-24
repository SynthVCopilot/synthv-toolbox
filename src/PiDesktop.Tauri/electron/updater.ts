import electronUpdater from "electron-updater";
import type { AppUpdater, ProgressInfo, UpdateInfo } from "electron-updater";

const { autoUpdater } = electronUpdater;

export type UpdaterPhase = "idle" | "checking" | "available" | "downloading" | "ready" | "error";

export interface UpdaterState {
  phase: UpdaterPhase;
  version?: string;
  progress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  error?: string;
}

export interface UpdaterService {
  check(): Promise<UpdaterState>;
  download(): Promise<UpdaterState>;
  cancel(): UpdaterState;
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

  client.autoDownload = false;
  client.autoInstallOnAppQuit = false;
  client.on("checking-for-update", () => setState({ phase: "checking" }));
  client.on("update-available", (info) => setState({ phase: "available", version: version(info) }));
  client.on("update-not-available", () => setState({ phase: "idle" }));
  client.on("download-progress", (progress: ProgressInfo) => setState({ phase: "downloading", progress: progress.percent, downloadedBytes: progress.transferred, totalBytes: progress.total }));
  client.on("update-downloaded", (info) => {
    setState({ phase: "ready", version: version(info) });
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
    async download() {
      if (state.phase !== "available") throw new Error("No update is available to download.");
      setState({ ...state, phase: "downloading", progress: 0, downloadedBytes: 0 });
      await client.downloadUpdate();
      return state;
    },
    cancel() {
      if (state.phase === "downloading") {
        (client as AppUpdater & { cancelDownload(): void }).cancelDownload();
        setState({ phase: "available", version: state.version });
      }
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
