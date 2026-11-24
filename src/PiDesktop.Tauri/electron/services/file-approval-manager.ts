import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const AUTO_EXTENSIONS = new Set(["svp", "svprj", "mid", "midi", "wav", "flac", "mp3", "m4a", "aac", "ogg", "opus", "aiff", "aif", "caf", "alac", "mp4", "webm", "mkv", "mov", "avi", "mpeg", "mpg", "musicxml", "mxl", "lrc", "klrc", "srt", "vtt", "lab", "ust", "ustx", "vsq", "vsqx"]);
const MAX_PENDING = 64;
const MAX_DECISIONS = 128;

export interface AgentFileApproval { id: string; path: string; purpose: string; createdAtUtc: string; }
export interface AgentFileEntry { path: string; fileType: string; size: number; decision: "pass" | "human-approval-required"; }
export interface FileAccessDecision { decision: "pass" | "human-approval-required"; requestId?: string; }
interface Fingerprint { size: number; modifiedMs: number; }
interface PendingApproval extends AgentFileApproval { sessionId: string; fingerprint: Fingerprint; }

export class FileApprovalManager {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly grants = new Map<string, Fingerprint>();
  private readonly denied = new Map<string, Fingerprint>();
  private readonly home: string;
  private readonly sensitiveRoots: string[];
  constructor(options: { home?: string; managedCreativeRoot?: string } = {}) {
    this.home = resolve(options.home ?? homedir());
    const home = this.home;
    this.sensitiveRoots = [join(home, ".ssh"), join(home, ".gnupg"), join(home, "Library", "Keychains"), join(home, "Library", "Safari"), join(home, "Library", "Application Support", "Google"), join(home, "Library", "Application Support", "Firefox"), join(home, "AppData", "Roaming", "Microsoft", "Credentials"), join(home, "AppData", "Roaming", "Microsoft", "Protect"), join(home, "AppData", "Local", "Google", "Chrome", "User Data"), join(home, "AppData", "Roaming", "Mozilla", "Firefox", "Profiles")].map(root => resolve(root));
    if (options.managedCreativeRoot) this.sensitiveRoots.push(join(resolve(options.managedCreativeRoot), "credentials"));
  }

  async list(rawPath: string, solo = false): Promise<AgentFileEntry[]> {
    const path = await this.safePath(rawPath);
    if (!(await stat(path)).isDirectory()) throw new Error("The listing target must be a directory.");
    const entries = await readdir(path, { withFileTypes: true });
    return Promise.all(entries.map(async entry => {
      const child = join(path, entry.name);
      const meta = await lstat(child);
      return { path: child, fileType: meta.isDirectory() ? "directory" : extname(child).slice(1).toLowerCase(), size: meta.size, decision: entry.isDirectory() || solo || this.autoAllowed(child) ? "pass" : "human-approval-required" };
    }));
  }

  async admitOrRequest(rawPath: string, purpose: string, solo: boolean, sessionId: string): Promise<FileAccessDecision> {
    if (!sessionId.trim()) throw new Error("A file approval requires an active agent session.");
    if (!purpose.trim() || Array.from(purpose.trim()).length > 240) throw new Error("File access purpose must contain 1 to 240 non-whitespace characters.");
    const path = await this.safePath(rawPath);
    if (solo || this.autoAllowed(path)) return { decision: "pass" };
    const fingerprint = await this.fingerprint(path);
    const key = this.key(sessionId, path);
    if (this.same(this.denied.get(key), fingerprint)) throw new Error("Human access to this file was denied.");
    if (this.same(this.grants.get(key), fingerprint)) return { decision: "pass" };
    const existing = [...this.pending.values()].find(request => request.sessionId === sessionId && request.path === path && this.same(request.fingerprint, fingerprint));
    if (existing) return { decision: "human-approval-required", requestId: existing.id };
    if (this.pending.size >= MAX_PENDING) this.pending.clear();
    const request: PendingApproval = { id: randomUUID(), path, purpose: purpose.trim(), createdAtUtc: new Date().toISOString(), sessionId, fingerprint };
    for (const [id, pending] of this.pending) if (pending.sessionId === sessionId && pending.path === path) this.pending.delete(id);
    this.pending.set(request.id, request);
    return { decision: "human-approval-required", requestId: request.id };
  }

  pendingFor(sessionId: string): AgentFileApproval[] { return [...this.pending.values()].filter(request => request.sessionId === sessionId).sort((a, b) => a.createdAtUtc.localeCompare(b.createdAtUtc) || a.id.localeCompare(b.id)).map(({ sessionId: _sessionId, fingerprint: _fingerprint, ...request }) => request); }
  decide(id: string, approve: boolean, sessionId: string): void {
    const request = this.pending.get(id);
    if (!request) throw new Error("The file approval request does not exist or was already handled.");
    if (request.sessionId !== sessionId) throw new Error("A session cannot decide another session's file approval.");
    this.pending.delete(id);
    const decisions = approve ? this.grants : this.denied;
    if (decisions.size >= MAX_DECISIONS) decisions.clear();
    decisions.set(this.key(sessionId, request.path), request.fingerprint);
  }

  private async safePath(raw: string): Promise<string> {
    if (!raw || raw.includes("\0") || raw.includes("://") || !isAbsolute(raw) || raw.split(/[\\/]/).includes("..")) throw new Error("Only absolute local paths without traversal are allowed.");
    if (process.platform === "win32" && (raw.startsWith("\\\\") || raw.startsWith("\\\\?\\") || raw.startsWith("\\\\.\\") || raw.split(/[\\/]/).some(part => part.includes(":") && part.length !== 2))) throw new Error("UNC, device, and ADS paths are not allowed.");
    const path = resolve(raw);
    let walked = process.platform === "win32" ? path.slice(0, 3) : "/";
    for (const segment of relative(walked, path).split(delimiter === ";" ? /[\\/]/ : "/").filter(Boolean)) { walked = join(walked, segment); if ((await lstat(walked)).isSymbolicLink()) throw new Error("Symbolic-link paths are not allowed."); }
    const canonical = await realpath(path);
    if (!inside(this.home, canonical) || this.sensitiveRoots.some(root => inside(root, canonical))) throw new Error("The path is outside the allowed user area or inside a sensitive root.");
    return canonical;
  }
  private autoAllowed(path: string): boolean { return AUTO_EXTENSIONS.has(extname(path).slice(1).toLowerCase()); }
  private async fingerprint(path: string): Promise<Fingerprint> { const metadata = await stat(path); return { size: metadata.size, modifiedMs: metadata.mtimeMs }; }
  private key(sessionId: string, path: string): string { return `${sessionId}:${path}`; }
  private same(left: Fingerprint | undefined, right: Fingerprint): boolean { return Boolean(left && left.size === right.size && left.modifiedMs === right.modifiedMs); }
}
function inside(root: string, path: string): boolean { const value = relative(root, path); return value === "" || (!value.startsWith("..") && !isAbsolute(value)); }
