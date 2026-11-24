import { createHash } from "node:crypto";
import { access, lstat, mkdir, readFile, rename } from "node:fs/promises";
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

  async preflightCover(input: { processId: number | null; trackIndex: number; projectPath: string | null; requireEmpty: boolean }, signal: AbortSignal): Promise<Data> {
    const requestedProject = input.projectPath ? await coverProject(input.projectPath) : null;
    const process = await this.selectProcess(input.processId, requestedProject, signal);
    const client = await this.connectedClient(process, signal);
    if (requestedProject) await this.waitForProject(client, requestedProject, signal);
    const target = await readMainGroup(client, input.trackIndex);
    if (input.requireEmpty && target.noteCount !== 0) throw new Error("无人值守 Cover 要求目标音轨的主音符组为空，以保留当前已选择声库并避免覆盖已有音符。");
    const status = await this.bridgeStatus(client);
    if (!status.connected) throw new Error(status.reason ?? "SynthV Bridge 在 Cover 前置检查时离线。");
    return {
      processId: process.processId,
      processIdentity: process.processIdentity,
      projectPath: status.status?.projectFile ?? null,
      trackIndex: target.trackIndex,
      groupIndex: target.groupIndex,
      groupUuid: target.groupUuid,
      referenceFingerprint: target.referenceFingerprint,
      targetNoteCount: target.noteCount,
      bridgeConnected: true,
    };
  }

  async importScore(input: { midiPath: string; voiceName: string; processId: number | null; trackIndex: number; groupName: string; rightsConfirmed: true; taskId: string; projectPath: string | null }, signal: AbortSignal): Promise<Data> {
    if (input.rightsConfirmed !== true) throw new Error("导入曲谱前必须确认拥有来源内容或已取得足够授权。");
    const midiPath = resolve(input.midiPath);
    const metadata = await lstat(midiPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > 64 * 1024 * 1024 || ![".mid", ".midi"].includes(extname(midiPath).toLowerCase())) throw new Error("Cover MIDI 必须是非符号链接且不超过 64 MiB 的本地 MIDI 文件。");
    const requestedProject = input.projectPath ? await coverProject(input.projectPath) : null;
    const process = await this.selectProcess(input.processId, requestedProject, signal);
    const client = await this.connectedClient(process, signal);
    if (requestedProject) await this.waitForProject(client, requestedProject, signal);
    const score = await this.loadScoreModule();
    throwIfAborted(signal);
    const snapshot = await score.readLocalScoreSnapshot(midiPath);
    const inspection = score.inspectScoreSnapshot(snapshot);
    if (inspection.format !== "midi") throw new Error("Cover 曲谱不是标准 MIDI 文件。");
    const tracks = inspection.tracks.filter(track => track.noteCount > 0);
    if (tracks.length !== 1 || tracks[0].channels.length !== 1) throw new Error("Cover MIDI 必须只有一个非空轨道和一个活动通道。");
    const imported = score.importScoreSnapshotMonophonic(snapshot, { trackIndex: tracks[0].trackIndex, channel: tracks[0].channels[0].channel }, inspection.fileFingerprint, { defaultLyric: "la" });
    if (!imported.notes.length || imported.notes.length > 512) throw new Error("Cover MIDI 必须包含 1–512 个可导入单声部音符。");
    const preparedNotes = withPronunciationLanguage(imported.notes);
    const before = await readMainGroup(client, input.trackIndex);
    if (before.noteCount !== 0) throw new Error("无人值守 Cover 要求目标音轨的主音符组为空，以保留当前已选择声库并避免覆盖已有音符。");
    const expectedNotes = noteMultiset(preparedNotes);
    const hostResult = await client.send<Data>("add_notes", { trackIndex: input.trackIndex, groupIndex: 1, notes: preparedNotes, grouping: "target" });
    const host = validateAddNotesResult(hostResult, before, preparedNotes.length);
    const after = await readMainGroup(client, input.trackIndex);
    if (after.groupUuid !== before.groupUuid || after.noteCount !== preparedNotes.length || noteMultiset(after.notes) !== expectedNotes) {
      throw new Error("SynthV 写入后的音符回读与 MIDI 不一致，拒绝继续保存或导出。");
    }
    const pronunciation = await this.waitForPronunciation(client, input.trackIndex, after.groupIndex, preparedNotes.length, signal);
    const status = await this.bridgeStatus(client);
    if (!status.connected) throw new Error(status.reason ?? "SynthV Bridge 在音符写入后离线。");
    return {
      ...host,
      processId: process.processId,
      processIdentity: process.processIdentity,
      projectPath: status.status?.projectFile ?? null,
      midiPath,
      scoreFingerprint: imported.fileFingerprint,
      noteCount: imported.notes.length,
      writeVerified: true,
      pronunciationVerified: true,
      writeVerification: {
        trackIndex: after.trackIndex,
        groupIndex: after.groupIndex,
        groupUuid: after.groupUuid,
        referenceFingerprint: after.referenceFingerprint,
        noteCount: after.noteCount,
        noteDigest: createHash("sha256").update(expectedNotes).digest("hex"),
        noteLanguageOverrides: preparedNotes.map((note, index) => requiredText(note.languageOverride, `notes[${index}].languageOverride`)),
        computedPhonemeCount: pronunciation.computedPhonemeCount,
        computedAttributeCount: pronunciation.computedAttributeCount,
        pronunciationDigest: pronunciation.pronunciationDigest,
      },
      warnings: imported.warnings ?? [],
      requestedVoice: input.voiceName,
      requestedGroupName: input.groupName,
      voiceAssignment: { assigned: false, inheritedFromTargetGroup: true, requiresHostSelection: true, reason: "SV2 scripting cannot select a singer identity; notes are written into the empty main group that already carries the host-selected voice." },
    };
  }

  async saveProject(input: { processId: number | null; taskId: string; importResult: Data }, signal: AbortSignal): Promise<Data> {
    const process = await this.selectProcess(input.processId ?? integer(input.importResult.processId));
    const client = await this.connectedClient(process, signal);
    const status = await client.getStatus();
    const projectPath = text(input.importResult.projectPath) ?? status.status?.projectFile;
    if (!projectPath || extname(projectPath).toLowerCase() !== ".svp") throw new Error("当前 SynthV 工程尚未保存为 .svp；无人值守写入前必须先选择一次工程路径。");
    const verifiedImport = await hydrateSavedLanguageVerification(input.importResult, client, positiveInteger(input.importResult.trackIndex, "trackIndex"));
    const before = await fileHash(projectPath);
    await this.synthv.sendShortcut(process.processId, process.processIdentity, "save");
    for (let attempt = 0; attempt < 40; attempt += 1) {
      throwIfAborted(signal);
      await this.sleep(250);
      if (await fileHash(projectPath).catch(() => "") !== before) {
        const persisted = await verifySavedNotes(projectPath, verifiedImport);
        return { projectPath, saveVerified: true, notesPersisted: true, ...persisted, processId: process.processId };
      }
    }
    throw new Error("已发送保存指令，但 .svp 内容在 10 秒内没有变化。");
  }

  async exportRender(input: { processId: number | null; outputPath: string; iteration: number; taskId: string; importResult: Data }, signal: AbortSignal): Promise<Data> {
    const outputPath = resolve(input.outputPath);
    if (extname(outputPath).toLowerCase() !== ".wav") throw new Error("Cover 导出路径必须使用 .wav 扩展名。");
    await mkdir(dirname(outputPath), { recursive: true });
    const candidates = [outputPath, join(dirname(outputPath), `${basename(outputPath, extname(outputPath))}_MixDown${extname(outputPath)}`)];
    for (const candidate of candidates) try { await access(candidate); throw new Error("Cover 导出拒绝覆盖已有文件。"); } catch (reason) { if ((reason as NodeJS.ErrnoException).code !== "ENOENT") throw reason; }
    const process = await this.selectProcess(input.processId ?? integer(input.importResult.processId));
    await this.connectedClient(process, signal);
    await this.synthv.assertMacAutomationReady();
    await this.automateExport(process.processId, outputPath, signal);
    let observedPath = "";
    let observedSize = -1;
    for (let attempt = 0; attempt < 480; attempt += 1) {
      throwIfAborted(signal);
      await this.sleep(250);
      const ready = (await Promise.all(candidates.map(async path => ({ path, metadata: await lstat(path).catch(() => null) })))).filter(item => item.metadata?.isFile() && !item.metadata.isSymbolicLink() && item.metadata.size > 44);
      if (ready.length > 1) throw new Error("SynthV 导出生成了多个候选 WAV，拒绝猜测目标文件。");
      if (ready.length === 1) {
        const item = ready[0];
        if (item.path === observedPath && item.metadata!.size === observedSize) {
          if (item.path !== outputPath) await rename(item.path, outputPath);
          return { outputPath, renderPath: outputPath, byteLength: item.metadata!.size, sha256: await fileHash(outputPath), iteration: input.iteration };
        }
        observedPath = item.path;
        observedSize = item.metadata!.size;
      }
    }
    throw new Error("SynthV 导出在 120 秒内没有生成有效 WAV。");
  }

  async applyTuning(input: { voiceName: string; processId: number | null; trackIndex: number; iteration: number; parameters: Data; importResult: Data; taskId: string }, signal: AbortSignal): Promise<Data> {
    const process = await this.selectProcess(input.processId ?? integer(input.importResult.processId));
    const client = await this.connectedClient(process, signal);
    const groupIndex = positiveInteger(input.importResult.groupIndex, "groupIndex");
    const referenceFingerprint = requiredText(input.importResult.referenceFingerprint, "referenceFingerprint");
    const deltas = pickVoiceParameters(input.parameters);
    const current = await client.send<Data>("get_group_voice", { trackIndex: input.trackIndex, groupIndex });
    const parameters = addVoiceParameters(current.parameters, deltas);
    const result = await client.send<Data>("set_group_voice", { trackIndex: input.trackIndex, groupIndex, referenceFingerprint, parameters, requireCurrentEditorGroup: false });
    await this.synthv.sendShortcut(process.processId, process.processIdentity, "save");
    await this.waitForGroupRender(client, input.trackIndex, groupIndex, input.importResult, signal);
    return { ...result, parameters, parameterDeltas: deltas, processId: process.processId, requestedVoice: input.voiceName, iteration: input.iteration };
  }

  private async waitForGroupRender(client: BridgeClient, trackIndex: number, groupIndex: number, importResult: Data, signal: AbortSignal): Promise<void> {
    const noteCount = Math.max(1, Math.min(512, integer(importResult.noteCount) ?? 64));
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      throwIfAborted(signal);
      const computed = await client.send<Data>("get_computed_group_data", { trackIndex, groupIndex, includeAttributes: true, offset: 0, limit: noteCount });
      if (computed.phonemesPending !== true && computed.attributesPending !== true && Number(computed.returnedNoteCount ?? 0) >= Math.min(noteCount, Number(computed.noteCount ?? noteCount))) {
        ready = true;
        break;
      }
      await this.sleep(250);
    }
    if (!ready) throw new Error("SynthV 在 20 秒内没有完成音符组计算，拒绝导出旧渲染缓存。");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      throwIfAborted(signal);
      await this.sleep(250);
    }
  }

  private async waitForPronunciation(client: BridgeClient, trackIndex: number, groupIndex: number, noteCount: number, signal: AbortSignal): Promise<{ computedPhonemeCount: number; computedAttributeCount: number; pronunciationDigest: string }> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      throwIfAborted(signal);
      const computed = await client.send<Data>("get_computed_group_data", { trackIndex, groupIndex, includeAttributes: true, offset: 0, limit: noteCount });
      const phonemes = Array.isArray(computed.computedPhonemes) ? computed.computedPhonemes : [];
      const attributes = Array.isArray(computed.computedAttributes) ? computed.computedAttributes : [];
      const ready = computed.phonemesPending === false
        && computed.attributesPending === false
        && integer(computed.noteCount) === noteCount
        && integer(computed.returnedNoteCount) === noteCount
        && phonemes.length === noteCount
        && attributes.length === noteCount
        && phonemes.every(value => typeof value === "string" && value.trim().length > 0);
      if (ready) {
        return {
          computedPhonemeCount: phonemes.length,
          computedAttributeCount: attributes.length,
          pronunciationDigest: createHash("sha256").update(JSON.stringify(phonemes)).digest("hex"),
        };
      }
      await this.sleep(250);
    }
    throw new Error("SynthV 在 30 秒内没有为全部写入音符生成可回读的发音和计算属性。");
  }

  private async connectedClient(process: ProcessInfo, signal: AbortSignal): Promise<BridgeClient> {
    const client = await this.loadBridgeClient();
    let status = await this.bridgeStatus(client);
    if (!status.connected) {
      throwIfAborted(signal);
      const started = await this.synthv.startBridge(process.processId, process.processIdentity);
      if (!started.succeeded) throw new Error(started.detail || started.summary);
      status = await this.bridgeStatus(client);
    }
    if (!status.connected) throw new Error(status.reason ?? "SynthV Bridge 在 10 秒内没有上线。");
    return client;
  }

  private async selectProcess(requested: number | null | undefined, projectPath: string | null = null, signal?: AbortSignal): Promise<ProcessInfo> {
    let running = (await this.synthv.listProcesses()).filter(process => process.isSv2);
    if (requested) {
      const selected = running.find(process => process.processId === requested);
      if (!selected) throw new Error(`没有找到 PID ${requested} 对应的 SV2 进程。`);
      return selected;
    }
    if (projectPath && running.length === 0) {
      const launched = await this.synthv.launchInstalledProject(projectPath);
      if (!launched.succeeded) throw new Error(launched.detail || launched.summary);
      for (let attempt = 0; attempt < 120 && running.length === 0; attempt += 1) {
        if (signal) throwIfAborted(signal);
        await this.sleep(250);
        running = (await this.synthv.listProcesses()).filter(process => process.isSv2);
      }
    }
    if (running.length !== 1) throw new Error(running.length ? "发现多个 SV2 进程，必须指定 processId。" : "没有发现正在运行的 SV2 进程。");
    return running[0];
  }

  private async waitForProject(client: BridgeClient, projectPath: string, signal: AbortSignal): Promise<void> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      throwIfAborted(signal);
      const status = await this.bridgeStatus(client);
      if (status.connected && status.status?.projectFile && resolve(status.status.projectFile) === projectPath) return;
      await this.sleep(250);
    }
    throw new Error("SynthV 在 30 秒内没有打开指定的 .svp 工程。");
  }

  private async bridgeStatus(client: BridgeClient): Promise<BridgeStatus> {
    try { return await client.getStatus(); }
    catch (reason) { return { connected: false, reason: reason instanceof Error ? reason.message : String(reason) }; }
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
    set targetWindow to first window whose name contains "Synthesizer V Studio"
    set fields to every text area of targetWindow
    if (count of fields) < 3 then
      set exportToggle to missing value
      repeat with candidate in buttons of targetWindow
        try
          set helper to value of attribute "AXHelp" of candidate
          if helper contains "导出为音频文件" or helper contains "export" or helper contains "Export" then
            set exportToggle to candidate
            exit repeat
          end if
        end try
      end repeat
      if exportToggle is missing value then error "SV2 export panel button was not found"
      perform action "AXPress" of exportToggle
      delay 0.5
      set fields to every text area of targetWindow
    end if
    if (count of fields) < 3 then error "SV2 export fields were not found"
    set value of item ((count of fields) - 1) of fields to outputFolder
    set value of item (count of fields) of fields to outputName
    set exportButton to missing value
    repeat with candidate in buttons of targetWindow
      try
        if (name of candidate is "导出为文件") or (name of candidate is "Export to File") then
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

function addVoiceParameters(currentValue: unknown, deltas: Data): Data {
  if (!currentValue || typeof currentValue !== "object" || Array.isArray(currentValue)) throw new Error("SynthV 没有返回当前音符组的 Voice 参数。");
  const current = currentValue as Data;
  const result: Data = {};
  for (const [key, minimum, maximum] of [["loudness", -48, 12], ["tension", -1, 1], ["breathiness", -1, 1], ["gender", -1, 1], ["toneShift", -1, 1]] as const) {
    const base = current[key] == null ? 0 : current[key];
    const delta = deltas[key];
    if (typeof base !== "number" || !Number.isFinite(base) || typeof delta !== "number" || !Number.isFinite(delta)) throw new Error(`SynthV 当前调声参数 ${key} 无效。`);
    result[key] = Math.max(minimum, Math.min(maximum, base + delta));
  }
  return result;
}

type GroupReadback = {
  trackIndex: number;
  groupIndex: number;
  groupUuid: string;
  referenceFingerprint: string;
  main: boolean;
  noteCount: number;
  notes: Data[];
};

async function readMainGroup(client: BridgeClient, trackIndex: number): Promise<GroupReadback> {
  const value = await client.send<Data>("get_track_notes", { trackIndex, groupIndex: 1, offset: 0, limit: 512 });
  if (!Array.isArray(value.groups) || value.groups.length !== 1 || !isRecord(value.groups[0])) throw new Error("SynthV 没有返回唯一的目标主音符组。");
  const group = value.groups[0];
  const resolvedTrack = positiveInteger(value.trackIndex, "trackIndex");
  const groupIndex = positiveInteger(group.groupIndex, "groupIndex");
  const noteCount = nonNegativeInteger(group.noteCount, "noteCount");
  const notes = Array.isArray(group.notes) && group.notes.every(isRecord) ? group.notes : [];
  if (resolvedTrack !== trackIndex || groupIndex !== 1 || group.main !== true || group.instrumental === true || notes.length !== noteCount || group.hasMore === true) {
    throw new Error("Cover 目标必须是可完整读取的空白主音符组。");
  }
  return {
    trackIndex: resolvedTrack,
    groupIndex,
    groupUuid: requiredText(group.groupUuid, "groupUuid"),
    referenceFingerprint: requiredText(group.referenceFingerprint, "referenceFingerprint"),
    main: true,
    noteCount,
    notes,
  };
}

function validateAddNotesResult(value: Data, target: GroupReadback, expectedCount: number): Data {
  if (positiveInteger(value.trackIndex, "trackIndex") !== target.trackIndex
    || positiveInteger(value.groupIndex, "groupIndex") !== target.groupIndex
    || requiredText(value.groupUuid, "groupUuid") !== target.groupUuid
    || requiredText(value.referenceFingerprint, "referenceFingerprint").length === 0
    || positiveInteger(value.addedCount, "addedCount") !== expectedCount
    || value.grouping !== "target"
    || value.createdGroup === true) {
    throw new Error("SynthV add_notes 返回的目标或写入数量与请求不一致。");
  }
  return value;
}

function noteMultiset(values: Data[], languageFallbacks?: string[]): string {
  if (languageFallbacks && languageFallbacks.length !== values.length) throw new Error("音符语言回退数量与保存音符数量不一致。");
  return values.map((value, index) => {
    const onset = nonNegativeInteger(value.onset, `notes[${index}].onset`);
    const duration = positiveInteger(value.duration, `notes[${index}].duration`);
    const pitch = nonNegativeInteger(value.pitch, `notes[${index}].pitch`);
    if (pitch > 127) throw new Error(`notes[${index}].pitch must be at most 127.`);
    const lyrics = requiredText(value.lyrics, `notes[${index}].lyrics`);
    const languageOverride = text(value.languageOverride) ?? languageFallbacks?.[index] ?? requiredText(value.languageOverride, `notes[${index}].languageOverride`);
    return JSON.stringify([onset, duration, pitch, lyrics, languageOverride]);
  }).sort().join("\n");
}

function withPronunciationLanguage(notes: Data[]): Data[] {
  let previous = "english";
  return notes.map((note, index) => {
    const lyrics = requiredText(note.lyrics, `notes[${index}].lyrics`);
    const explicit = text(note.languageOverride);
    const inferred = explicit ?? inferLanguage(lyrics, previous);
    previous = inferred;
    return { ...note, languageOverride: inferred };
  });
}

function inferLanguage(lyrics: string, fallback: string): string {
  if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(lyrics)) return "japanese";
  if (/\p{Script=Hangul}/u.test(lyrics)) return "korean";
  if (/\p{Script=Han}/u.test(lyrics)) return "mandarin";
  if (/\p{Script=Latin}/u.test(lyrics)) return "english";
  return fallback;
}

async function verifySavedNotes(projectPath: string, importResult: Data): Promise<{ savedNoteCount: number; savedNoteDigest: string }> {
  if (importResult.writeVerified !== true || importResult.pronunciationVerified !== true || !isRecord(importResult.writeVerification)) {
    throw new Error("Cover 保存前缺少音符和发音写后验证。");
  }
  const verification = importResult.writeVerification;
  const groupUuid = requiredText(verification.groupUuid, "writeVerification.groupUuid");
  const expectedCount = positiveInteger(verification.noteCount, "writeVerification.noteCount");
  const expectedDigest = requiredText(verification.noteDigest, "writeVerification.noteDigest");
  const languages = Array.isArray(verification.noteLanguageOverrides) && verification.noteLanguageOverrides.every(value => typeof value === "string" && value.length > 0)
    ? verification.noteLanguageOverrides
    : null;
  const document: unknown = JSON.parse(await readFile(projectPath, "utf8"));
  const groups: Data[] = [];
  collectNoteGroups(document, groupUuid, groups);
  if (groups.length !== 1 || !Array.isArray(groups[0].notes) || !groups[0].notes.every(isRecord)) throw new Error("保存后的 SVP 中没有找到唯一的已验证音符组。");
  const notes = groups[0].notes;
  if (!languages || languages.length !== expectedCount) throw new Error("保存后的 SVP 缺少已验证的音符语言信息。");
  const digest = createHash("sha256").update(noteMultiset(notes, languages)).digest("hex");
  if (notes.length !== expectedCount || digest !== expectedDigest) throw new Error("保存后的 SVP 音符与 SynthV 写后回读不一致。");
  return { savedNoteCount: notes.length, savedNoteDigest: digest };
}

async function hydrateSavedLanguageVerification(importResult: Data, client: BridgeClient, trackIndex: number): Promise<Data> {
  if (!isRecord(importResult.writeVerification)) throw new Error("Cover 保存前缺少音符语言验证信息。");
  const verification = importResult.writeVerification;
  if (Array.isArray(verification.noteLanguageOverrides) && verification.noteLanguageOverrides.every(value => typeof value === "string" && value.length > 0)) return importResult;
  const group = await readMainGroup(client, trackIndex);
  const expectedUuid = requiredText(verification.groupUuid, "writeVerification.groupUuid");
  const expectedCount = positiveInteger(verification.noteCount, "writeVerification.noteCount");
  const languages = group.notes.map((note, index) => requiredText(note.languageOverride, `saved notes[${index}].languageOverride`));
  if (group.groupUuid !== expectedUuid || group.noteCount !== expectedCount || languages.length !== expectedCount) throw new Error("SynthV 保存前的音符语言回读与已验证写入不一致。");
  return { ...importResult, writeVerification: { ...verification, noteLanguageOverrides: languages } };
}

function collectNoteGroups(value: unknown, groupUuid: string, output: Data[]): void {
  if (Array.isArray(value)) { for (const item of value) collectNoteGroups(item, groupUuid, output); return; }
  if (!isRecord(value)) return;
  if (value.uuid === groupUuid && Array.isArray(value.notes)) output.push(value);
  for (const item of Object.values(value)) collectNoteGroups(item, groupUuid, output);
}

async function fileHash(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
async function coverProject(path: string): Promise<string> { const absolute = resolve(path); const metadata = await lstat(absolute).catch(() => null); if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > 256 * 1024 * 1024 || extname(absolute).toLowerCase() !== ".svp") throw new Error("Cover 工程必须是非符号链接且不超过 256 MiB 的本地 .svp 文件。"); return absolute; }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Task cancelled."); }
function text(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function requiredText(value: unknown, name: string): string { const result = text(value); if (!result) throw new Error(`${name} is required.`); return result; }
function integer(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null; }
function positiveInteger(value: unknown, name: string): number { const result = integer(value); if (!result) throw new Error(`${name} must be a positive integer.`); return result; }
function nonNegativeInteger(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`); return value; }
function isRecord(value: unknown): value is Data { return value !== null && typeof value === "object" && !Array.isArray(value); }
