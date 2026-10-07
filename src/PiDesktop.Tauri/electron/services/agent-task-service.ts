import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEffortLevel, AgentRunOutcome, AgentRunProgress } from "@synthv-toolbox/runtime-protocol";
import type { AiService } from "./ai-service.js";

type AiTaskPort = Pick<AiService, "new_conversation" | "open_conversation" | "send_message" | "cancel_agent_run">;
export type AgentTaskStatus = "running" | "cancelling" | "completed" | "needs_input" | "budget_exhausted" | "incomplete" | "cancelled" | "failed" | "interrupted" | "unknown";

export interface AgentTaskSnapshot {
  taskId: string;
  conversationId: string;
  runId: string;
  status: AgentTaskStatus;
  startedAt: string;
  updatedAt: string;
  ageMs: number;
  progress: AgentRunProgress | null;
  outcome: AgentRunOutcome | null;
  error: string | null;
  missing: string[];
  pendingApprovals: unknown[];
  children: unknown[];
}

export interface AgentTaskServiceOptions {
  dataRoot: string;
  ai: () => AiTaskPort;
  effort: () => AgentEffortLevel;
  children?: (conversationId: string) => Promise<unknown[]>;
  approvals?: (conversationId: string) => unknown[];
  now?: () => Date;
  id?: () => string;
}

export type AgentTaskRequest =
  | { action: "start"; input: string }
  | { action: "continue"; input: string; conversationId: string; taskId?: string }
  | { action: "status" | "cancel"; taskId?: string; conversationId?: string }
  | { action: "list" };

interface StoredTask extends Omit<AgentTaskSnapshot, "ageMs" | "pendingApprovals" | "children"> {
  cancelRequested?: boolean;
}

export function createAgentTaskService(options: AgentTaskServiceOptions) {
  const file = join(options.dataRoot, "agent-tasks.json");
  const tasks: StoredTask[] = [];
  const activeByConversation = new Map<string, string>();
  const latestProgress = new Map<string, AgentRunProgress>();
  const now = options.now ?? (() => new Date());
  const id = options.id ?? randomUUID;
  let progressFlush: ReturnType<typeof setTimeout> | undefined;
  let ready = load();

  async function load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!Array.isArray(parsed)) return;
      for (const item of parsed.slice(-100)) {
        if (!isStoredTask(item)) continue;
        if (item.status === "running" || item.status === "cancelling") {
          item.status = "interrupted";
          item.error = "The application exited before this agent run finished.";
          item.updatedAt = now().toISOString();
        }
        tasks.push(item);
      }
      await persist();
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  async function persist(): Promise<void> {
    await mkdir(options.dataRoot, { recursive: true });
    const temporary = `${file}.${id()}.tmp`;
    await writeFile(temporary, JSON.stringify(tasks.slice(-100)), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
    if (tasks.length > 100) tasks.splice(0, tasks.length - 100);
  }

  function snapshot(task: StoredTask): AgentTaskSnapshot {
    const elapsed = Math.max(0, now().getTime() - new Date(task.startedAt).getTime());
    return {
      ...task,
      ageMs: elapsed,
      pendingApprovals: options.approvals?.(task.conversationId) ?? [],
      children: [],
    };
  }

  async function enriched(task: StoredTask): Promise<AgentTaskSnapshot> {
    const result = snapshot(task);
    result.children = await options.children?.(task.conversationId) ?? [];
    return result;
  }

  async function begin(input: string): Promise<AgentTaskSnapshot> {
    if (typeof input !== "string" || !input.trim()) throw new Error("Agent task input is required.");
    if (input.length > 32_000) throw new Error("Agent task input exceeds the 32,000 character limit.");
    const conversation = await options.ai().new_conversation();
    const current = now().toISOString();
    const task: StoredTask = {
      taskId: id(), conversationId: conversation.id, runId: id(), status: "running",
      startedAt: current, updatedAt: current, progress: null, outcome: null, error: null, missing: [],
    };
    tasks.push(task);
    activeByConversation.set(conversation.id, task.taskId);
    await persist();
    void run(task, input);
    return enriched(task);
  }

  async function continueTask(input: string, conversationId: string, taskId?: string): Promise<AgentTaskSnapshot> {
    if (typeof input !== "string" || !input.trim()) throw new Error("Agent task input is required.");
    if (input.length > 32_000) throw new Error("Agent task input exceeds the 32,000 character limit.");
    const task = findTask(taskId, conversationId);
    if (!task || task.conversationId !== conversationId) throw new Error("Agent task was not found for this conversation.");
    if (activeByConversation.has(conversationId)) throw new Error("An agent task is already running for this conversation.");
    if (task.status === "interrupted") throw new Error("Interrupted agent tasks cannot be continued automatically.");
    await options.ai().open_conversation(conversationId);
    task.runId = id();
    task.status = "running";
    task.updatedAt = now().toISOString();
    task.progress = null;
    task.outcome = null;
    task.error = null;
    task.missing = [];
    delete task.cancelRequested;
    latestProgress.delete(conversationId);
    activeByConversation.set(conversationId, task.taskId);
    await persist();
    void run(task, input);
    return enriched(task);
  }

  async function run(task: StoredTask, input: string): Promise<void> {
    try {
      const messages = await options.ai().send_message(task.conversationId, input, { runId: task.runId, effort: options.effort() });
      const assistant = [...messages].reverse().find((message) => message.role === "assistant");
      task.outcome = assistant?.outcome ?? null;
      task.missing = task.outcome?.missing ?? task.progress?.pendingInput?.missing ?? [];
      task.status = task.outcome?.status === "cancelled" ? "cancelled"
        : task.outcome?.status === "needs_input" ? "needs_input"
        : task.outcome?.status ?? "unknown";
      task.error = null;
    } catch (error) {
      task.status = "failed";
      task.error = errorMessage(error);
    } finally {
      task.updatedAt = now().toISOString();
      activeByConversation.delete(task.conversationId);
      if (progressFlush) { clearTimeout(progressFlush); progressFlush = undefined; }
      await persist();
    }
  }

  async function invoke(value: unknown): Promise<unknown> {
    const args = validateRequest(value);
    await ready;
    switch (args.action) {
      case "start": return begin(requiredInput(args.input));
      case "continue": return continueTask(requiredInput(args.input), requiredString(args.conversationId, "conversationId"), args.taskId);
      case "list": return Promise.all(tasks.slice(-100).reverse().map(enriched));
      case "status": {
        const task = findTask(args.taskId, args.conversationId);
        if (!task) throw new Error("Agent task was not found.");
        return enriched(task);
      }
      case "cancel": {
        const task = findTask(args.taskId, args.conversationId);
        if (!task) throw new Error("Agent task was not found.");
        if (task.status !== "running" && task.status !== "cancelling") return enriched(task);
        task.cancelRequested = true;
        task.status = "cancelling";
        task.updatedAt = now().toISOString();
        await persist();
        try { await options.ai().cancel_agent_run(task.conversationId); }
        catch (error) { task.error = errorMessage(error); await persist(); }
        return enriched(task);
      }
    }
  }

  function findTask(taskId?: string, conversationId?: string): StoredTask | undefined {
    return [...tasks].reverse().find((task) => taskId ? task.taskId === taskId : task.conversationId === conversationId);
  }

  function recordProgress(progress: AgentRunProgress): void {
    latestProgress.set(progress.sessionId, progress);
    const task = [...tasks].reverse().find((item) => item.conversationId === progress.sessionId && item.runId === progress.runId);
    if (!task) return;
    task.progress = progress;
    task.missing = progress.pendingInput?.missing ?? task.outcome?.missing ?? [];
    task.updatedAt = now().toISOString();
    if (!progressFlush) {
      progressFlush = setTimeout(() => {
        progressFlush = undefined;
        void persist().catch(() => undefined);
      }, 750);
      progressFlush.unref?.();
    }
  }

  function sessionProgress(sessionId: string): AgentRunProgress | undefined { return latestProgress.get(sessionId); }

  return {
    invoke,
    recordProgress,
    sessionProgress,
    dispose: async () => {
      await ready;
      if (progressFlush) { clearTimeout(progressFlush); progressFlush = undefined; await persist(); }
    },
  };
}

function requiredInput(value: string | undefined): string { if (typeof value !== "string") throw new Error("Agent task input is required."); return value; }
function requiredString(value: string | undefined, name: string): string { if (typeof value !== "string" || !value) throw new Error(`${name} is required.`); return value; }
function validateRequest(value: unknown): AgentTaskRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Agent task request must be an object.");
  const request = value as Record<string, unknown>;
  const action = request.action;
  const allowed = action === "start" ? ["action", "input"]
    : action === "continue" ? ["action", "input", "conversationId", "taskId"]
    : action === "status" || action === "cancel" ? ["action", "taskId", "conversationId"]
    : action === "list" ? ["action"] : [];
  if (allowed.length === 0) throw new Error("Agent task action is invalid.");
  if (Object.keys(request).some((key) => !allowed.includes(key))) throw new Error("Agent task request contains an unsupported field.");
  if (action === "start" && typeof request.input !== "string") throw new Error("Agent task input is required.");
  if (action === "continue" && (typeof request.input !== "string" || typeof request.conversationId !== "string" || (request.taskId !== undefined && typeof request.taskId !== "string"))) throw new Error("Continue requires input and conversationId.");
  if ((action === "status" || action === "cancel") && request.taskId !== undefined && typeof request.taskId !== "string") throw new Error("taskId must be a string.");
  if ((action === "status" || action === "cancel") && request.conversationId !== undefined && typeof request.conversationId !== "string") throw new Error("conversationId must be a string.");
  if ((action === "status" || action === "cancel") && !request.taskId && !request.conversationId) throw new Error("taskId or conversationId is required.");
  return request as AgentTaskRequest;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isMissingFile(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
function isStoredTask(value: unknown): value is StoredTask {
  return typeof value === "object" && value !== null && "taskId" in value && typeof value.taskId === "string" && "conversationId" in value && typeof value.conversationId === "string" && "runId" in value && typeof value.runId === "string" && "status" in value && typeof value.status === "string" && "startedAt" in value && typeof value.startedAt === "string" && "updatedAt" in value && typeof value.updatedAt === "string";
}
