import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import type { ComponentService } from "./component-service.js";
import type { ComponentExecutor } from "./component-executor.js";
import type { CreativeServicePorts } from "./creative-service.js";
import type { SynthVService } from "./synthv-service.js";

type Data = Record<string, unknown>;
type ScoreModule = {
  readLocalScoreSnapshot(path: string): Promise<unknown>;
  inspectScoreSnapshot(snapshot: unknown): Data;
  importScoreSnapshotMonophonic(snapshot: unknown, selection: Data, fingerprint: string, options: { defaultLyric: string }): Data & { notes: Data[] };
};
type SelectionNote = { noteIndex: number; lyrics: string; onset: number | null; duration: number | null; pitch: number | null; fingerprint: string };
type StoredSelection = { sessionToken: string; selectionRevision: unknown; target: { trackIndex: number; groupIndex: number }; notes: SelectionNote[]; expiresAt: number };
type StoredPreview = { selection: StoredSelection; slots: Array<{ text: string; phoneme?: string }>; expiresAt: number };

const PREVIEW_LIFETIME_MS = 5 * 60 * 1000;
const MAX_NOTES = 512;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const SCORE_EXTENSIONS = new Set([".xml", ".musicxml", ".mxl", ".mid", ".midi"]);
const AUDIO_EXTENSIONS = new Set([".wav", ".flac", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".aif", ".aiff"]);
const MEDIA_HOSTS = new Set(["youtube.com", "www.youtube.com", "youtu.be", "bilibili.com", "www.bilibili.com", "b23.tv"]);

export interface CreativeWorkflowPortOptions {
  dataRoot: string;
  bridgeDirectory: string;
  synthv: Pick<SynthVService, "bridgeRequest" | "bridgeStatus">;
  components: Pick<ComponentService, "executable">;
  execute: ComponentExecutor;
  runJson?: (file: string, args: string[]) => Promise<Data>;
  now?: () => number;
}

export function createCreativeWorkflowPorts(options: CreativeWorkflowPortOptions): CreativeServicePorts {
  const dataRoot = resolve(options.dataRoot);
  const runJson = options.runJson ?? runJsonProcess;
  const now = options.now ?? Date.now;
  const selections = new Map<string, StoredSelection>();
  const previews = new Map<string, StoredPreview>();
  let scoreModule: ScoreModule | undefined;

  const cleanExpired = () => {
    const current = now();
    for (const [token, value] of selections) if (value.expiresAt <= current) selections.delete(token);
    for (const [token, value] of previews) if (value.expiresAt <= current) previews.delete(token);
    if (selections.size > 128) selections.clear();
    if (previews.size > 128) previews.clear();
  };

  const bridgeSession = async (): Promise<string> => {
    const status = await options.synthv.bridgeStatus();
    const token = text(status.sessionToken);
    if (status.connected !== true || !token) throw new Error(String(status.detail ?? "SynthV Bridge is unavailable."));
    return token;
  };

  const readSelection = async (): Promise<StoredSelection> => {
    const result = await options.synthv.bridgeRequest<Data>("get_selection", {});
    const sessionToken = await bridgeSession();
    if (result.pianoRollHasUnfinishedEdits === true || result.arrangementHasUnfinishedEdits === true) throw new Error("SynthV 有未完成的编辑；请先完成或取消编辑后再填词。");
    const current = record(result.current, "Bridge 没有返回当前音符组。");
    const target = { trackIndex: positiveInteger(current.trackIndex, "trackIndex"), groupIndex: positiveInteger(current.groupIndex, "groupIndex") };
    const rawNotes = Array.isArray(result.selectedNotes) ? result.selectedNotes : [];
    if (!rawNotes.length || rawNotes.length > MAX_NOTES) throw new Error("请选择 1–512 个可写入的音符。");
    const notes = rawNotes.map((item, index) => {
      const note = record(item, `selectedNotes[${index}]`);
      return {
        noteIndex: positiveInteger(note.noteIndex, "noteIndex"),
        lyrics: typeof note.lyrics === "string" ? note.lyrics : "",
        onset: finiteOrNull(note.onset), duration: finiteOrNull(note.duration), pitch: finiteOrNull(note.pitch),
        fingerprint: requiredText(note.fingerprint, "fingerprint"),
      };
    }).sort((left, right) => (left.onset ?? Number.MAX_SAFE_INTEGER) - (right.onset ?? Number.MAX_SAFE_INTEGER) || left.noteIndex - right.noteIndex);
    if (new Set(notes.map(note => note.noteIndex)).size !== notes.length) throw new Error("Bridge 返回了重复的选中音符。");
    return { sessionToken, selectionRevision: result.selectionRevision ?? null, target, notes, expiresAt: now() + PREVIEW_LIFETIME_MS };
  };

  const importScore = async (args: Data): Promise<Data> => {
    if (args.rightsConfirmed !== true) throw new Error("导入 SynthV 前必须确认你有权使用该本地曲谱。");
    const scorePath = await regularLocalFile(requiredText(args.scorePath, "scorePath"), SCORE_EXTENSIONS, 64 * 1024 * 1024);
    const trackIndex = positiveInteger(args.trackIndex, "trackIndex");
    const groupName = requiredText(args.groupName, "groupName");
    scoreModule ??= await import(pathToFileURL(join(options.bridgeDirectory, "dist", "src", "score-import.js")).href) as ScoreModule;
    const snapshot = await scoreModule.readLocalScoreSnapshot(scorePath);
    const inspection = scoreModule.inspectScoreSnapshot(snapshot);
    const selection = unambiguousScoreSelection(inspection);
    const fingerprint = requiredText(inspection.fileFingerprint, "fileFingerprint");
    const imported = scoreModule.importScoreSnapshotMonophonic(snapshot, selection, fingerprint, { defaultLyric: "la" });
    if (!Array.isArray(imported.notes) || !imported.notes.length || imported.notes.length > MAX_NOTES) throw new Error("曲谱必须包含 1–512 个可导入的单声部音符。");
    const bridge = await options.synthv.bridgeRequest<Data>("add_notes", { trackIndex, groupIndex: 1, notes: imported.notes, grouping: "ensureNonMain", groupName });
    return { kind: "score-to-synthv", succeeded: true, summary: "曲谱中的单声部音符已通过 Bridge 导入当前 SynthV 工程；源速度未自动应用，请在 SynthV 中检查并保存工程。", data: { inspection, import: imported, bridge } };
  };

  return {
    async readLyricBridgeSelection() {
      cleanExpired();
      const selection = await readSelection();
      const token = randomUUID();
      selections.set(token, selection);
      return { selectionToken: token, sessionToken: selection.sessionToken, target: selection.target, notes: selection.notes.map(({ fingerprint: _fingerprint, ...note }) => ({ noteIndex: note.noteIndex, lyric: note.lyrics, onset: note.onset, duration: note.duration, pitch: note.pitch })), noteCount: selection.notes.length };
    },
    async previewLyricBridgeFit(args) {
      cleanExpired();
      const request = record(args.request, "request");
      const selectionToken = requiredText(request.selectionToken, "selectionToken");
      const selection = selections.get(selectionToken);
      if (!selection || selection.expiresAt <= now()) throw new Error("选区身份已失效；请重新读取选中的音符。");
      if (requiredText(request.sessionToken, "sessionToken") !== selection.sessionToken) throw new Error("当前 SynthV 会话已变化；请重新读取选中的音符。");
      const slots = normalizeSlots(request.slots, selection.notes.length);
      const previewToken = randomUUID();
      previews.set(previewToken, { selection, slots, expiresAt: now() + PREVIEW_LIFETIME_MS });
      return { previewToken, sessionToken: selection.sessionToken, target: selection.target, notes: selection.notes.map((note, index) => ({ noteIndex: note.noteIndex, currentLyric: note.lyrics, text: slots[index].text, ...(slots[index].phoneme ? { phoneme: slots[index].phoneme } : {}), onset: note.onset, duration: note.duration, pitch: note.pitch })), slotCount: slots.length, expiresInSeconds: PREVIEW_LIFETIME_MS / 1000 };
    },
    async confirmLyricBridgeFit(args) {
      cleanExpired();
      const request = record(args.request, "request");
      const token = requiredText(request.previewToken, "previewToken");
      const preview = previews.get(token);
      previews.delete(token);
      if (!preview || preview.expiresAt <= now()) throw new Error("预览已失效；请重新预览后再确认。");
      if (await bridgeSession() !== preview.selection.sessionToken) throw new Error("当前 SynthV 会话已变化；预览已失效。");
      const current = await readSelection();
      if (!sameSelection(preview.selection, current)) throw new Error("SynthV 选区或音符已变化；预览已失效。");
      const phonemes = preview.slots.map(slot => slot.phoneme).filter((value): value is string => Boolean(value));
      await options.synthv.bridgeRequest("fit_lyrics", {
        ...preview.selection.target,
        notes: preview.selection.notes.map(note => ({ noteIndex: note.noteIndex, fingerprint: note.fingerprint })),
        syllables: preview.slots.map(slot => slot.text),
        ...(phonemes.length ? { phonemes } : {}),
        fillRemainder: "reject",
      });
      return { applied: true, target: preview.selection.target, noteCount: preview.selection.notes.length };
    },
    async previewMediaSource(args) {
      const source = normalizeHttpsSource(requiredText(args.source, "source"));
      if (!MEDIA_HOSTS.has(source.hostname.toLowerCase())) {
        const title = decodeURIComponent(basename(source.pathname)) || source.hostname;
        return { sourceUrl: source.href, canonicalUrl: source.href, platform: source.hostname, mediaId: createHash("sha256").update(source.href).digest("hex").slice(0, 24), title, uploader: source.hostname, durationSeconds: null, thumbnailUrl: null };
      }
      const executable = await options.components.executable("media-fetcher");
      const metadata = await runJson(executable, ["--ignore-config", "--no-playlist", "--no-remote-components", "--dump-single-json", source.href]);
      if (metadata.is_live === true) throw new Error("当前不支持直播或进行中的媒体。");
      return {
        sourceUrl: source.href,
        canonicalUrl: text(metadata.webpage_url) ?? source.href,
        platform: text(metadata.extractor_key) ?? text(metadata.extractor) ?? source.hostname,
        mediaId: requiredText(metadata.id, "media id"), title: requiredText(metadata.title, "title"),
        uploader: text(metadata.uploader) ?? text(metadata.channel) ?? "未知作者",
        durationSeconds: finiteOrNull(metadata.duration), thumbnailUrl: text(metadata.thumbnail) ?? null,
      };
    },
    async runAudioToProject(args) {
      const vocalPath = await regularLocalFile(requiredText(args.vocalPath, "vocalPath"), AUDIO_EXTENSIONS, 2 * 1024 * 1024 * 1024);
      const instrumentalPath = text(args.instrumentalPath) ? await regularLocalFile(String(args.instrumentalPath), AUDIO_EXTENSIONS, 2 * 1024 * 1024 * 1024) : null;
      const outputDirectory = args.outputDirectory == null ? join(dataRoot, "audio-to-project") : resolve(requiredText(args.outputDirectory, "outputDirectory"));
      await safeOutputDirectory(outputDirectory);
      const requestedName = basename(requiredText(args.outputName, "outputName"));
      const outputPath = join(outputDirectory, extname(requestedName).toLowerCase() === ".mid" ? requestedName : `${requestedName}.mid`);
      const extraction = await options.execute("run_game_to_midi", { vocalPath, instrumentalPath, outputPath, tolerance: finite(args.tolerance, "tolerance"), advanced: args.advanced === true });
      let bridge: Data | null = null;
      if (args.importToSynthv === true) {
        if (args.rightsConfirmed !== true) throw new Error("导入 SynthV 前必须确认你有权使用该本地音频及生成的 MIDI。");
        bridge = await importScore({ scorePath: outputPath, trackIndex: args.trackIndex, groupName: args.groupName, rightsConfirmed: true });
      }
      return { kind: "audio-to-project", succeeded: true, summary: bridge ? "音频旋律已写入 MIDI 并通过 Bridge 导入当前 SynthV 工程。" : "音频旋律已写入 MIDI；连接 Bridge 后可继续导入当前工程。", outputPath, data: { stages: [{ id: "pairDiff", status: "completed" }, { id: "midi", status: "completed" }, { id: "synthvImport", status: bridge ? "completed" : "ready" }], extraction, bridge } };
    },
    runScoreToSynthv: importScore,
    async runRetakeWorkbench(args) {
      const trackIndex = positiveInteger(args.trackIndex, "trackIndex");
      const groupIndex = positiveInteger(args.groupIndex, "groupIndex");
      const noteIndex = positiveInteger(args.noteIndex, "noteIndex");
      const operation = requiredText(args.operation, "operation");
      const target = { trackIndex, groupIndex, noteIndex };
      const before = await options.synthv.bridgeRequest<Data>("get_note_retakes", target);
      if (operation === "refresh") return { kind: "retake-workbench", succeeded: true, summary: "已读取该音符的 Retake 候选。", data: { state: before } };
      const fingerprint = requiredText(before.noteFingerprint, "noteFingerprint");
      let action: string;
      let payload: Data;
      if (operation === "generate") {
        if (args.newDuration !== true && args.newPitch !== true && args.newTimbre !== true) throw new Error("至少选择一种 Retake 变化维度。");
        action = "generate_note_retake";
        payload = { ...target, fingerprint, newDuration: args.newDuration === true, newPitch: args.newPitch === true, newTimbre: args.newTimbre === true, activate: args.activate === true };
      } else if (operation === "activate") {
        action = "activate_note_retake";
        payload = { ...target, fingerprint, takeId: nonnegativeInteger(args.takeId, "takeId") };
      } else if (operation === "delete") {
        action = "delete_note_retake";
        payload = { ...target, fingerprint, takeId: positiveInteger(args.takeId, "takeId") };
      } else throw new Error("不支持的 Retake 操作。");
      const command = await options.synthv.bridgeRequest<Data>(action, payload);
      const state = await options.synthv.bridgeRequest<Data>("get_note_retakes", target);
      return { kind: "retake-workbench", succeeded: true, summary: `Retake 操作“${operation}”已由 SynthV 验证完成。`, data: { before, command, state } };
    },
    async applyTuningProfile(args) {
      const profile = record(args.profile, "profile");
      const parameters = record(profile.parameters, "profile.parameters");
      const trackIndex = positiveInteger(args.trackIndex, "trackIndex");
      const groupIndex = positiveInteger(args.groupIndex, "groupIndex");
      const voice = await options.synthv.bridgeRequest<Data>("get_group_voice", { trackIndex, groupIndex });
      const referenceFingerprint = requiredText(voice.referenceFingerprint, "referenceFingerprint");
      const notesResult = await options.synthv.bridgeRequest<Data>("get_track_notes", { trackIndex, groupIndex, offset: 0, limit: MAX_NOTES, includeComputedPhonemes: false, includeComputedAttributes: false });
      const notes = collectNotes(notesResult).slice(0, MAX_NOTES);
      const result = await options.synthv.bridgeRequest<Data>("apply_group_tuning", {
        trackIndex, groupIndex, referenceFingerprint,
        summary: `Apply local tuning profile for ${requiredText(profile.voiceName, "voiceName")}`,
        voice: { parameters: { loudness: bounded(parameters.loudness, -48, 12, "loudness"), tension: bounded(parameters.tension, -1, 1, "tension"), breathiness: bounded(parameters.breathiness, -1, 1, "breathiness"), gender: bounded(parameters.gender, -1, 1, "gender"), toneShift: bounded(parameters.toneShift, -1, 1, "toneShift") } },
        ...(notes.length ? { noteEdits: notes.map(note => ({ noteIndex: note.noteIndex, fingerprint: note.fingerprint, changes: { attributes: { dF0VbrMod: bounded(parameters.vibratoStrength, 0, 2, "vibratoStrength") } } })) } : {}),
      });
      return { kind: "learned-tuning-apply", succeeded: true, summary: `已应用声库 ${String(profile.voiceName)} 的本地学习调声参数。`, data: { profile, applied: result, vibratoNoteCount: notes.length } };
    },
    async runSoloTuning() {
      return { succeeded: false, status: "unavailable", command: "run_solo_tuning", summary: "run_solo_tuning 当前不可用。", blocker: "system_audio_capture_unavailable", detail: "当前 Electron 构建没有可验证的进程级系统音频捕获组件，不能伪造 A/B 调声闭环。" };
    },
  };
}

function normalizeSlots(value: unknown, expected: number): Array<{ text: string; phoneme?: string }> {
  if (!Array.isArray(value) || value.length !== expected || !value.length || value.length > MAX_NOTES) throw new Error(`歌词槽位数量必须与选中的 ${expected} 个音符完全一致。`);
  const slots = value.map((item, index) => {
    const slot = record(item, `slots[${index}]`);
    const textValue = requiredText(slot.text, `slots[${index}].text`);
    if ([...textValue].length > 1000) throw new Error("歌词槽位文本不能超过 1000 个字符。");
    const phoneme = text(slot.phoneme);
    if (phoneme && [...phoneme].length > 4000) throw new Error("音素不能超过 4000 个字符。");
    return { text: textValue, ...(phoneme ? { phoneme } : {}) };
  });
  const count = slots.filter(slot => slot.phoneme).length;
  if (count !== 0 && count !== slots.length) throw new Error("音素必须为所有歌词槽位同时提供，或全部留空。");
  return slots;
}

function sameSelection(left: StoredSelection, right: StoredSelection): boolean {
  return left.sessionToken === right.sessionToken && left.target.trackIndex === right.target.trackIndex && left.target.groupIndex === right.target.groupIndex && JSON.stringify(left.selectionRevision) === JSON.stringify(right.selectionRevision) && left.notes.length === right.notes.length && left.notes.every((note, index) => JSON.stringify(note) === JSON.stringify(right.notes[index]));
}

function unambiguousScoreSelection(inspection: Data): Data {
  if (inspection.format === "midi") {
    const tracks = (Array.isArray(inspection.tracks) ? inspection.tracks : []).map(item => record(item, "track")).filter(track => Number(track.noteCount) > 0);
    if (tracks.length !== 1) throw new Error("MIDI 必须只有一个非空轨道。");
    const channels = (Array.isArray(tracks[0].channels) ? tracks[0].channels : []).map(item => record(item, "channel")).filter(channel => Number(channel.noteCount) > 0);
    if (channels.length !== 1) throw new Error("MIDI 的目标轨道必须只有一个活动通道。");
    return { trackIndex: positiveInteger(tracks[0].trackIndex, "midiTrackIndex"), channel: positiveInteger(channels[0].channel, "midiChannel") };
  }
  if (inspection.format === "musicxml") {
    const parts = (Array.isArray(inspection.parts) ? inspection.parts : []).map(item => record(item, "part")).filter(part => Number(part.noteCount) > 0);
    if (parts.length !== 1) throw new Error("MusicXML 必须只有一个非空声部。");
    const voices = (Array.isArray(parts[0].voices) ? parts[0].voices : []).map(item => record(item, "voice")).filter(voice => Number(voice.noteCount) > 0);
    if (voices.length !== 1) throw new Error("MusicXML 声部必须只有一个活动 voice。");
    const staffs = Array.isArray(voices[0].staffs) ? voices[0].staffs : [];
    if (staffs.length !== 1) throw new Error("MusicXML voice 必须只有一个活动 staff。");
    return { partIndex: positiveInteger(parts[0].partIndex, "partIndex"), voice: requiredText(voices[0].voice, "voice"), staff: positiveInteger(staffs[0], "staff") };
  }
  throw new Error("曲谱格式不受支持。");
}

async function regularLocalFile(value: string, extensions: Set<string>, maximum: number): Promise<string> {
  if (!isAbsolute(value)) throw new Error("输入必须是绝对本地路径。");
  const path = resolve(value);
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > maximum || !extensions.has(extname(path).toLowerCase())) throw new Error("输入文件的类型或大小无效。");
  return path;
}

async function safeOutputDirectory(path: string): Promise<void> {
  const metadata = await lstat(path).catch(() => null);
  if (metadata?.isSymbolicLink() || (metadata && !metadata.isDirectory())) throw new Error("输出目录必须是普通目录而非符号链接。");
  await mkdir(path, { recursive: true });
}

function normalizeHttpsSource(value: string): URL {
  if (value.length > 2048) throw new Error("媒体 URL 过长。");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("媒体来源必须是无凭据的标准 HTTPS URL。");
  return url;
}

function runJsonProcess(file: string, args: string[]): Promise<Data> {
  return new Promise((done, reject) => {
    const child = spawn(file, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { if (stdout.length < MAX_METADATA_BYTES) stdout += String(chunk); });
    child.stderr.on("data", chunk => { if (stderr.length < 16_000) stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", code => {
      if (code !== 0) { reject(new Error(stderr || `${file} exited with ${code}`)); return; }
      try { done(JSON.parse(stdout) as Data); } catch { reject(new Error("媒体获取组件返回了无效 JSON。")); }
    });
  });
}

function collectNotes(value: unknown, output: Array<{ noteIndex: number; fingerprint: string }> = []): Array<{ noteIndex: number; fingerprint: string }> {
  if (Array.isArray(value)) for (const item of value) collectNotes(item, output);
  else if (value && typeof value === "object") {
    const item = value as Data;
    if (Number.isSafeInteger(item.noteIndex) && Number(item.noteIndex) > 0 && typeof item.fingerprint === "string" && item.fingerprint) output.push({ noteIndex: Number(item.noteIndex), fingerprint: item.fingerprint });
    for (const child of Object.values(item)) if (child && typeof child === "object") collectNotes(child, output);
  }
  return [...new Map(output.map(note => [note.noteIndex, note])).values()];
}

function record(value: unknown, name: string): Data { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} 必须是对象。`); return value as Data; }
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function requiredText(value: unknown, name: string): string { const result = text(value); if (!result) throw new Error(`${name} 必须是非空字符串。`); return result; }
function finite(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} 必须是有限数值。`); return value; }
function finiteOrNull(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function bounded(value: unknown, minimum: number, maximum: number, name: string): number { const result = finite(value, name); if (result < minimum || result > maximum) throw new Error(`${name} 超出安全范围。`); return result; }
function positiveInteger(value: unknown, name: string): number { if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${name} 必须是正整数。`); return Number(value); }
function nonnegativeInteger(value: unknown, name: string): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${name} 必须是非负整数。`); return Number(value); }
