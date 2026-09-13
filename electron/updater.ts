import { autoUpdater, type ProgressInfo, type UpdateInfo } from "electron-updater";

export type UpdateChannel = "stable" | "nightly";

export type UpdaterState =
  | { status: "idle"; channel: UpdateChannel }
  | { status: "checking"; channel: UpdateChannel }
  | { status: "available"; channel: UpdateChannel; version: string }
  | { status: "downloading"; channel: UpdateChannel; transferred: number; total: number }
  | { status: "ready"; channel: UpdateChannel; version: string; restartRequired: true }
  | { status: "restarting"; channel: UpdateChannel }
  | { status: "error"; channel: UpdateChannel; message: string };

export interface UpdaterPort {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  channel: string;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: "checking-for-update", listener: () => void): this;
  on(event: "update-available", listener: (info: UpdateInfo) => void): this;
  on(event: "update-not-available", listener: () => void): this;
  on(event: "download-progress", listener: (progress: ProgressInfo) => void): this;
  on(event: "update-downloaded", listener: (info: UpdateInfo) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export interface ElectronUpdaterOptions {
  channel?: UpdateChannel;
  onState?: (state: UpdaterState) => void;
  updater?: UpdaterPort;
}

/** Coordinates an automatic check, download, and explicit restart in the Electron main process. */
export class ElectronUpdater {
  private readonly updater: UpdaterPort;
  private readonly onState: (state: UpdaterState) => void;
  private channel: UpdateChannel;
  private started = false;

  constructor({ channel = "stable", onState = () => undefined, updater = autoUpdater }: ElectronUpdaterOptions = {}) {
    this.channel = channel;
    this.onState = onState;
    this.updater = updater;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.configure();
    this.bindEvents();
    void this.check();
  }

  async check(): Promise<void> {
    this.publish({ status: "checking", channel: this.channel });
    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      this.publishError(error);
    }
  }

  restart(): void {
    this.publish({ status: "restarting", channel: this.channel });
    this.updater.quitAndInstall(false, true);
  }

  private configure(): void {
    this.updater.channel = this.channel;
    this.updater.allowPrerelease = this.channel === "nightly";
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = true;
  }

  private bindEvents(): void {
    this.updater.on("checking-for-update", () => this.publish({ status: "checking", channel: this.channel }));
    this.updater.on("update-not-available", () => this.publish({ status: "idle", channel: this.channel }));
    this.updater.on("update-available", (info) => {
      this.publish({ status: "available", channel: this.channel, version: info.version });
      void this.download();
    });
    this.updater.on("download-progress", (progress) => {
      this.publish({ status: "downloading", channel: this.channel, transferred: progress.transferred, total: progress.total });
    });
    this.updater.on("update-downloaded", (info) => {
      this.publish({ status: "ready", channel: this.channel, version: info.version, restartRequired: true });
    });
    this.updater.on("error", (error) => this.publishError(error));
  }

  private async download(): Promise<void> {
    try {
      await this.updater.downloadUpdate();
    } catch (error) {
      this.publishError(error);
    }
  }

  private publish(state: UpdaterState): void {
    this.onState(state);
  }

  private publishError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.publish({ status: "error", channel: this.channel, message });
  }
}
