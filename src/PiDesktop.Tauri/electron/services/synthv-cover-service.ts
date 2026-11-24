import { createHash } from "node:crypto";
import { access, lstat, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import type { SynthVCoverPort } from "./media-workflow-port.js";
import type { ProcessInfo, SynthVService } from "./synthv-service.js";

type Data = Record<string, unknown>;
type BridgeStatus = { connected: boolean; status?: { sessionToken?: string; projectFile?: string }; reason?: string };
type BridgeClient = { getStatus(): Promise<BridgeStatus>; send<T = unknown>(action: string, payload?: Data): Promise<T> };
type ScoreModule = {
  readLocalScoreSnapshot(path: string): Promise<unknown>;
  inspectScoreSnapshot(snapshot: unknown): { format: string; fileFingerprint: string; tracks: Array<{ trackIndex: number; noteCount: number; channels: Array<{ channel: number }> }> };
  importScoreSnapshotMonophonic(snapshot: unknown, selection: { trackIndex: number; channel: number }, fingerprint: string, options: { defaultLyric: string }): { sourcePath: string; fileFingerprint: string; notes: Data[]; tempoMap?: unknown; warnings?: unknown };
};
type ExportAutomation = (processId: number, outputPath: string, signal: AbortSignal) => Promise<void>;

export interface SynthVCoverServiceOptions {
  bridgeClient?: BridgeClient;
  scoreModule?: ScoreModule;
  exportAutomation?: ExportAutomation;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class SynthVCoverService implements SynthVCoverPort {
  private bridgeClient?: BridgeClient;
  private scoreModule?: ScoreModule;
  private readonly automateExport: ExportAutomation;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly synthv: SynthVService, private readonly bridgeDirectory: string, options: SynthVCoverServiceOptions = {}) {
    this.bridgeClient = options.bridgeClient;
    this.scoreModule = options.scoreModule;
    this.automateExport = options.exportAutomation ?? automateExport;
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds)));
  }

  async importScore(input: { midiPath: string; voiceName: string; processId: number | null; trackIndex: number; groupName: string; rightsConfirmed: true; taskId: string }, signal: AbortSignal): Promise<Data> {
    if (input.rightsConfirmed !== true) throw new Error("导入曲谱前必须确认拥有来源内容或已取得足够授权。");
    const midiPath = resolve(input.midiPath);
    const metadata = await lstat(midiPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > 64 * 1024 * 1024 || ![".mid", ".midi"].includes(extname(midiPath).toLowerCase())) throw new Error("Cover MIDI 必须是非符号链接且不超过 64 MiB 的本地 MIDI 文件。");
    const process = await this.selectProcess(input.processId);
    const client = await this.connectedClient(process, signal);
    const score = await this.loadScoreModule();
    throwIfAborted(signal);
    const snapshot = await score.readLocalScoreSnapshot(midiPath);
    const inspection = score.inspectScoreSnapshot(snapshot);
    if (inspection.format !== "midi") throw new Error("Cover 曲谱不是标准 MIDI 文件。");
    const tracks = inspection.tracks.filter(track => track.noteCount > 0);
    if (tracks.length !== 1 || tracks[0].channels.length !== 1) throw new Error("Cover MIDI 必须只有一个非空轨道和一个活动通道。");
    const imported = score.importScoreSnapshotMonophonic(snapshot, { trackIndex: tracks[0].trackIndex, channel: tracks[0].channels[0].channel }, inspection.fileFingerprint, { defaultLyric: "la" });
    if (!imported.notes.length || imported.notes.length > 512) throw new Error("Cover MIDI 必须包含 1–512 个可导入单声部音符。");
    const hostResult = await client.send<Data>("add_notes", { trackIndex: input.trackIndex, groupIndex: 1, notes: imported.notes, grouping: "ensureNonMain", groupName: input.groupName });
    const status = await client.getStatus();
    return {
      ...hostResult,
      processId: process.processId,
      processIdentity: process.processIdentity,
      projectPath: status.status?.projectFile ?? null,
      midiPath,
      scoreFingerprint: imported.fileFingerprint,
      noteCount: imported.notes.length,
      warnings: imported.warnings ?? [],
      requestedVoice: input.voiceName,
      voiceAssignment: { assigned: false, inheritedFromTargetGroup: true, requiresHostSelection: true, reason: "SV2 scripting cannot select a singer identity; the created group inherits the target group voice." },
    };
  }

  async saveProject(input: { processId: number | null; taskId: string; importResult: Data }, signal: AbortSignal): Promise<Data> {
    const process = await this.selectProcess(input.processId ?? integer(input.importResult.processId));
    const client = await this.connectedClient(process, signal);
    const status = await client.getStatus();
    const projectPath = text(input.importResult.projectPath) ?? status.status?.projectFile;
    if (!projectPath || extname(projectPath).toLowerCase() !== ".svp") throw new Error("当前 SynthV 工程尚未保存为 .svp；无人值守写入前必须先选择一次工程路径。");
    const before = await fileHash(projectPath);
    await this.synthv.sendShortcut(process.processId, process.processIdentity, "save");
    for (let attempt = 0; attempt < 40; attempt += 1) {
      throwIfAborted(signal);
      await this.sleep(250);
      if (await fileHash(projectPath).catch(() => "") !== before) return { projectPath, saveVerified: true, processId: process.processId };
    }
    throw new Error("已发送保存指令，但 .svp 内容在 10 秒内没有变化。");
  }

  async exportRender(input: { processId: number | null; outputPath: string; iteration: number; taskId: string; importResult: Data }, signal: AbortSignal): Promise<Data> {
    const outputPath = resolve(input.outputPath);
    if (extname(outputPath).toLowerCase() !== ".wav") throw new Error("Cover 导出路径必须使用 .wav 扩展名。");
    await mkdir(dirname(outputPath), { recursive: true });
    try { await access(outputPath); throw new Error("Cover 导出拒绝覆盖已有文件。"); } catch (reason) { if ((reason as NodeJS.ErrnoException).code !== "ENOENT") throw reason; }
    const process = await this.selectProcess(input.processId ?? integer(input.importResult.processId));
    await this.connectedClient(process, signal);
    await this.automateExport(process.processId, outputPath, signal);
    for (let attempt = 0; attempt < 480; attempt += 1) {
      throwIfAborted(signal);
      await this.sleep(250);
      const metadata = await lstat(outputPath).catch(() => null);
      if (metadata?.isFile() && !metadata.isSymbolicLink() && metadata.size > 44) return { outputPath, renderPath: outputPath, byteLength: metadata.size, sha256: await fileHash(outputPath), iteration: input.iteration };
    }
    throw new Error("SynthV 导出在 120 秒内没有生成有效 WAV。");
  }

  async applyTuning(input: { voiceName: string; processId: number | null; trackIndex: number; iteration: number; parameters: Data; importResult: Data; taskId: string }, signal: AbortSignal): Promise<Data> {
    const process = await this.selectProcess(input.processId ?? integer(input.importResult.processId));
    const client = await this.connectedClient(process, signal);
    const groupIndex = positiveInteger(input.importResult.groupIndex, "groupIndex");
    const referenceFingerprint = requiredText(input.importResult.referenceFingerprint, "referenceFingerprint");
    const parameters = pickVoiceParameters(input.parameters);
    const result = await client.send<Data>("set_group_voice", { trackIndex: input.trackIndex, groupIndex, referenceFingerprint, parameters, requireCurrentEditorGroup: false });
    await this.synthv.sendShortcut(process.processId, process.processIdentity, "save");
    return { ...result, parameters, processId: process.processId, requestedVoice: input.voiceName, iteration: input.iteration };
  }

  private async connectedClient(process: ProcessInfo, signal: AbortSignal): Promise<BridgeClient> {
    const client = await this.loadBridgeClient();
    let status = await client.getStatus();
    if (!status.connected) {
      await this.synthv.sendShortcut(process.processId, process.processIdentity, "start");
      for (let attempt = 0; attempt < 40; attempt += 1) {
        throwIfAborted(signal);
        await this.sleep(250);
        status = await client.getStatus();
        if (status.connected) break;
      }
    }
    if (!status.connected) throw new Error(status.reason ?? "SynthV Bridge 在 10 秒内没有上线。");
    return client;
  }

  private async selectProcess(requested: number | null | undefined): Promise<ProcessInfo> {
    const running = (await this.synthv.listProcesses()).filter(process => process.isSv2);
    if (requested) {
      const selected = running.find(process => process.processId === requested);
      if (!selected) throw new Error(`没有找到 PID ${requested} 对应的 SV2 进程。`);
      return selected;
    }
    if (running.length !== 1) throw new Error(running.length ? "发现多个 SV2 进程，必须指定 processId。" : "没有发现正在运行的 SV2 进程。");
    return running[0];
  }

  private async loadBridgeClient(): Promise<BridgeClient> {
    if (this.bridgeClient) return this.bridgeClient;
    const [{ loadConfig }, { FileIpcClient }] = await Promise.all([
      import(pathToFileURL(join(this.bridgeDirectory, "dist", "src", "config.js")).href),
      import(pathToFileURL(join(this.bridgeDirectory, "dist", "src", "ipc", "file-ipc-client.js")).href),
    ]);
    this.bridgeClient = new FileIpcClient(loadConfig()) as BridgeClient;
    return this.bridgeClient;
  }

  private async loadScoreModule(): Promise<ScoreModule> {
    if (!this.scoreModule) this.scoreModule = await import(pathToFileURL(join(this.bridgeDirectory, "dist", "src", "score-import.js")).href) as ScoreModule;
    return this.scoreModule;
  }
}

async function automateExport(processId: number, outputPath: string, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (process.platform !== "darwin") throw new Error("当前 Electron 构建尚未提供此平台的 SV2 导出自动化。");
  const script = `on run argv
set pidValue to item 1 of argv as integer
set outputFolder to item 2 of argv
set outputName to item 3 of argv
tell application "System Events"
  set targetProcess to first process whose unix id is pidValue
  set frontmost of targetProcess to true
  tell targetProcess
    set targetWindow to front window
    set exportToggle to missing value
    repeat with candidate in entire contents of targetWindow
      try
        if role of candidate is "AXButton" then
          set helper to value of attribute "AXHelp" of candidate
          if helper contains "导出为音频文件" or helper contains "export" or helper contains "Export" then
            set exportToggle to candidate
            exit repeat
          end if
        end if
      end try
    end repeat
    if exportToggle is missing value then error "SV2 export panel button was not found"
    perform action "AXPress" of exportToggle
    delay 0.3
    set fields to every text field of entire contents of targetWindow
    if (count of fields) < 2 then error "SV2 export fields were not found"
    set value of item ((count of fields) - 1) of fields to outputFolder
    set value of item (count of fields) of fields to outputName
    set exportButton to missing value
    repeat with candidate in entire contents of targetWindow
      try
        if role of candidate is "AXButton" and ((name of candidate is "导出为文件") or (name of candidate is "Export to File")) then
          set exportButton to candidate
          exit repeat
        end if
      end try
    end repeat
    if exportButton is missing value then error "SV2 export action was not found"
    perform action "AXPress" of exportButton
  end tell
end tell
end run`;
  await run("osascript", ["-e", script, String(processId), dirname(outputPath), basename(outputPath, extname(outputPath))], signal);
}

function run(file: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((done, reject) => {
    const child = spawn(file, args, { shell: false, windowsHide: true, signal });
    let error = "";
    child.stderr?.on("data", chunk => { if (error.length < 16_000) error += String(chunk); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? done() : reject(new Error(error || `${file} exited with ${code}`)));
  });
}

function pickVoiceParameters(value: Data): Data {
  const result: Data = {};
  for (const [key, minimum, maximum] of [["loudness", -48, 12], ["tension", -1, 1], ["breathiness", -1, 1], ["gender", -1, 1], ["toneShift", -1, 1]] as const) {
    const candidate = value[key];
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < minimum || candidate > maximum) throw new Error(`调声参数 ${key} 超出安全范围。`);
    result[key] = candidate;
  }
  if (!Object.keys(result).length) throw new Error("没有可应用的 SynthV Group Voice 参数。");
  return result;
}

async function fileHash(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Task cancelled."); }
function text(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function requiredText(value: unknown, name: string): string { const result = text(value); if (!result) throw new Error(`${name} is required.`); return result; }
function integer(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null; }
function positiveInteger(value: unknown, name: string): number { const result = integer(value); if (!result) throw new Error(`${name} must be a positive integer.`); return result; }
