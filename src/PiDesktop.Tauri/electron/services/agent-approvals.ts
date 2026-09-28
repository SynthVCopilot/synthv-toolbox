import { randomUUID } from "node:crypto";
import {
  AGENT_APPROVAL_LIMITS,
  type AgentApproval,
  type AgentApprovalCategory,
  type AgentApprovalOutcome,
  type AgentApprovalResolution,
  type AgentApprovalsSnapshot,
  type AgentApprovalTool,
} from "@synthv-toolbox/runtime-protocol";

export type { AgentApproval, AgentApprovalCategory, AgentApprovalOutcome, AgentApprovalResolution, AgentApprovalsSnapshot, AgentApprovalTool };

export interface AgentApprovalItem {
  conversationId: string;
  runId: string;
  toolCallId: string;
  tool: AgentApprovalTool;
  action: string;
  category: AgentApprovalCategory;
  preview: string;
  params: unknown;
}

export interface AgentApprovalExecuted {
  text: string;
  isError: boolean;
}

export interface AgentApprovalBrokerOptions {
  timeoutMs?: number;
  execute: (item: AgentApprovalItem) => Promise<AgentApprovalExecuted>;
  deliver: (resolution: AgentApprovalResolution) => void;
}

interface WaitingRecord {
  approval: AgentApproval;
  waiters: Array<(resolution: AgentApprovalResolution) => void>;
}

interface PendingApproval extends WaitingRecord {
  item: AgentApprovalItem;
  timer: ReturnType<typeof setTimeout>;
}

type ExecutingApproval = WaitingRecord;

// Outlives typical polling/delivery so a late sv_await_approval still finds its resolution.
const RESOLVED_RETENTION_MS = 5 * 60_000;

export class AgentApprovalBroker {
  private readonly timeoutMs: number;
  private readonly execute: (item: AgentApprovalItem) => Promise<AgentApprovalExecuted>;
  private readonly deliver: (resolution: AgentApprovalResolution) => void;
  private readonly pending = new Map<string, PendingApproval>();
  // Decided (approved) but not yet settled: the bridge call is in flight. wait() still finds these.
  private readonly executing = new Map<string, ExecutingApproval>();
  private readonly resolved = new Map<string, { resolution: AgentApprovalResolution; at: number }>();
  private recent: AgentApprovalResolution[] = [];

  constructor(
    private readonly emit: (snapshot: AgentApprovalsSnapshot) => void,
    options: AgentApprovalBrokerOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? AGENT_APPROVAL_LIMITS.timeoutMs;
    this.execute = options.execute;
    this.deliver = options.deliver;
  }

  submit(item: AgentApprovalItem): AgentApproval {
    const id = randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.timeoutMs);
    const approval: AgentApproval = {
      id,
      conversationId: item.conversationId,
      runId: item.runId,
      toolCallId: item.toolCallId,
      tool: item.tool,
      action: item.action,
      category: item.category,
      risk: "high",
      preview: bounded(item.preview, AGENT_APPROVAL_LIMITS.preview),
      createdAtUtc: createdAt.toISOString(),
      expiresAtUtc: expiresAt.toISOString(),
    };
    const timer = setTimeout(() => this.settle(id, "expired"), this.timeoutMs);
    this.pending.set(id, { approval, item, timer, waiters: [] });
    this.emitSnapshot();
    return approval;
  }

  list(): AgentApproval[] {
    return [...this.pending.values()].map((record) => record.approval);
  }

  /** Pending plus already-approved-but-executing approvals: still "not done" for a completion guard or a default wait list. */
  activeIds(conversationId: string): string[] {
    const active = [...this.pending.values(), ...this.executing.values()];
    return active.filter((record) => record.approval.conversationId === conversationId).map((record) => record.approval.id);
  }

  /** The still-pending or still-executing approval's expiry, for a caller reporting a timed-out wait; undefined once it has settled or for a foreign id. */
  expiresAtUtc(id: string, conversationId: string): string | null {
    const record = this.pending.get(id) ?? this.executing.get(id);
    return record && record.approval.conversationId === conversationId ? record.approval.expiresAtUtc : null;
  }

  /** Whether `id` belongs to this conversation and has neither resolved nor been evicted: distinguishes a genuinely still-open wait from an unknown, foreign, or long-resolved id. */
  isActive(id: string, conversationId: string): boolean {
    const record = this.pending.get(id) ?? this.executing.get(id);
    return record !== undefined && record.approval.conversationId === conversationId;
  }

  snapshot(): AgentApprovalsSnapshot {
    return { pending: this.list(), recent: this.recent };
  }

  /**
   * Resolves once the approval settles for this conversation; undefined for an id this conversation
   * does not own (unknown, foreign, or still pending/executing when the caller stops waiting).
   * A caller that stops waiting (its own timeout or the abort signal) removes its own waiter so a
   * later resolution is never lost to a stale entry.
   */
  wait(id: string, conversationId: string, signal?: AbortSignal): Promise<AgentApprovalResolution | undefined> {
    const already = this.resolved.get(id)?.resolution;
    if (already) return Promise.resolve(already.conversationId === conversationId ? already : undefined);
    const record: WaitingRecord | undefined = this.pending.get(id) ?? this.executing.get(id);
    if (!record || record.approval.conversationId !== conversationId) return Promise.resolve(undefined);
    if (signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const waiter = (resolution: AgentApprovalResolution): void => { cleanup(); resolve(resolution); };
      const onAbort = (): void => { cleanup(); resolve(undefined); };
      const cleanup = (): void => {
        const index = record.waiters.indexOf(waiter);
        if (index >= 0) record.waiters.splice(index, 1);
        signal?.removeEventListener("abort", onAbort);
      };
      record.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  decide(id: string, approve: boolean): void {
    const record = this.pending.get(id);
    if (!record) throw new Error("Approval request is no longer pending.");
    if (!approve) { this.settle(id, "denied"); return; }
    clearTimeout(record.timer);
    this.pending.delete(id);
    this.executing.set(id, { approval: record.approval, waiters: record.waiters });
    this.emitSnapshot();
    void this.execute(record.item)
      .then((executed) => this.finishExecuting(id, executed))
      .catch((error) => this.finishExecuting(id, { text: executionErrorText(error), isError: true }));
  }

  cancelConversation(conversationId: string): void {
    for (const id of [...this.pending.keys()]) {
      if (this.pending.get(id)?.approval.conversationId === conversationId) this.settle(id, "cancelled");
    }
  }

  dispose(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, "cancelled");
  }

  private settle(id: string, outcome: AgentApprovalOutcome): void {
    const record = this.pending.get(id);
    if (!record) return;
    clearTimeout(record.timer);
    this.pending.delete(id);
    this.emitSnapshot();
    this.finish(record, outcome);
  }

  private finishExecuting(id: string, executed: AgentApprovalExecuted): void {
    const record = this.executing.get(id);
    if (!record) return;
    this.executing.delete(id);
    this.finish(record, "executed", executed);
  }

  private finish(record: WaitingRecord, outcome: AgentApprovalOutcome, executed?: AgentApprovalExecuted): void {
    // A failed execution keeps the bridge's own envelope (phase/wrote/undoRequired/retry/error.code): the timeout
    // and undo rules the model follows depend on those, not on the synthetic "nothing was written" text below.
    const summary = outcome === "executed" && executed?.isError
      ? bridgeFailureSummary(executed.text, AGENT_APPROVAL_LIMITS.summary)
      : bounded(executed?.text ?? defaultSummary(outcome), AGENT_APPROVAL_LIMITS.summary);
    const resolution: AgentApprovalResolution = {
      id: record.approval.id,
      conversationId: record.approval.conversationId,
      runId: record.approval.runId,
      toolCallId: record.approval.toolCallId,
      tool: record.approval.tool,
      action: record.approval.action,
      outcome,
      ok: outcome === "executed" && executed !== undefined && !executed.isError,
      summary,
      resolvedAtUtc: new Date().toISOString(),
    };
    const now = Date.now();
    this.resolved.set(resolution.id, { resolution, at: now });
    this.recent = [resolution, ...this.recent].slice(0, AGENT_APPROVAL_LIMITS.recent);
    this.evictResolved(now);
    // Stale (timed-out/aborted) waiters remove themselves from `waiters` (see wait()), so this only counts callers still actually listening.
    const liveCount = record.waiters.length;
    // Snapshot before firing: each waiter's cleanup() splices itself out of the live array as it runs.
    for (const waiter of [...record.waiters]) waiter(resolution);
    // A waiter already hands this resolution to the model as its tool result; deliver() would duplicate it.
    if (liveCount === 0) this.deliver(resolution);
    // recent changed here, after settle()'s or finishExecuting()'s own pending-list emit; without this
    // the UI never learns the resolution beyond a pending card disappearing.
    this.emitSnapshot();
  }

  private evictResolved(now: number): void {
    for (const [id, entry] of this.resolved) {
      if (now - entry.at > RESOLVED_RETENTION_MS) this.resolved.delete(id);
    }
  }

  private emitSnapshot(): void { this.emit(this.snapshot()); }
}

function bounded(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function defaultSummary(outcome: AgentApprovalOutcome): string {
  if (outcome === "denied") return "The user denied this call.";
  if (outcome === "expired") return "The approval expired after 2 minutes without a decision.";
  if (outcome === "cancelled") return "The run was cancelled before this approval was decided.";
  return "";
}

function executionErrorText(error: unknown): string {
  return error instanceof Error ? error.message : "The approved call failed.";
}

/** Parses the bridge's failure JSON and keeps only the fields the SynthV timeout/undo rules depend on, so truncation never cuts them off mid-object. Falls back to a bounded copy of the raw text when it does not parse as that shape. */
function bridgeFailureSummary(text: string, maxLength: number): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const errorField = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : undefined;
      const envelope = {
        ...(typeof record.phase === "string" ? { phase: record.phase } : {}),
        ...(typeof record.wrote === "boolean" ? { wrote: record.wrote } : {}),
        ...(typeof record.undoRequired === "boolean" ? { undoRequired: record.undoRequired } : {}),
        ...(typeof record.retry === "string" ? { retry: record.retry } : {}),
        ...(errorField
          ? { error: { ...(typeof errorField.code === "string" ? { code: errorField.code } : {}), ...(typeof errorField.message === "string" ? { message: errorField.message } : {}) } }
          : {}),
      };
      return bounded(JSON.stringify(envelope), maxLength);
    }
  } catch { /* not the expected JSON shape; fall through to a bounded copy of the raw text */ }
  return bounded(text, maxLength);
}
