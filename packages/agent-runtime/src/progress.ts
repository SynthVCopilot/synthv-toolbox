import {
  AGENT_PROGRESS_LIMITS,
  type AgentBudgetUsage,
  type AgentRunPhase,
  type AgentRunProgress,
  type AgentToolActivity,
} from "@synthv-toolbox/runtime-protocol";
import { extractText, TASK_LOOP_TOOL_NAMES, type PiTurnEndAssistantMessage, type TaskLoopState } from "./task-loop.js";

/** AgentRunProgress without the routing fields a session's caller already knows. */
export type AgentRunView = Omit<AgentRunProgress, "sessionId" | "runId">;

/** Trailing debounce window for text_delta/thinking_delta coalescing. */
export const PROGRESS_FLUSH_MS = 100;

export interface RunProgressProjector {
  /** Begins a run: seq 1, phase starting, the seeded plan, zero usage. */
  start(): void;
  /** Marks the start of one session.prompt() round (the initial call and every continuation). */
  round(): void;
  /** Routes one raw Pi agent-session event; never throws. */
  handle(event: unknown): void;
  /** Immediate flush with phase cancelling, called before abort(). */
  cancelling(): void;
  /** Clears any pending debounce timer and flushes exactly one final phase-ended snapshot. */
  end(): void;
}

/**
 * Projects Pi's raw agent-session events (received through PiAgentSession.subscribe, which fires after
 * extensions) into the AgentRunProgress view the host streams to callers.
 */
export function createRunProgress(state: TaskLoopState, report: (view: AgentRunView) => void): RunProgressProjector {
  let seq = 0;
  let phase: AgentRunPhase = "starting";
  let round = 0;
  let text = "";
  let retry: { attempt: number; maxAttempts: number } | null = null;
  const tools: AgentToolActivity[] = [];
  let toolCount = 0;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  function boundedSummary(value: unknown): string {
    const source = typeof value === "string" ? value : "";
    return source.length > AGENT_PROGRESS_LIMITS.summary ? source.slice(0, AGENT_PROGRESS_LIMITS.summary) : source;
  }

  function boundedTail(value: string): string {
    if (value.length <= AGENT_PROGRESS_LIMITS.text) return value;
    return `…${value.slice(-(AGENT_PROGRESS_LIMITS.text - 1))}`;
  }

  function currentBudget(): AgentBudgetUsage {
    return { ...state.budget, turns: state.turns, tokens: state.tokens };
  }

  function pendingInputView(): AgentRunView["pendingInput"] {
    return state.signal?.kind === "needs_input" ? { question: state.signal.question, missing: state.signal.missing } : null;
  }

  function flush(): void {
    seq += 1;
    report({
      seq,
      phase,
      round,
      text,
      plan: state.plan,
      // Snapshot each activity: tool objects are mutated in place as later events arrive, and a
      // reported view must freeze at the moment it was sent, not reflect a later status retroactively.
      tools: tools.slice(-AGENT_PROGRESS_LIMITS.tools).map((activity) => ({ ...activity })),
      toolCount,
      budget: currentBudget(),
      retry,
      pendingInput: pendingInputView(),
    });
  }

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      flush();
    }, PROGRESS_FLUSH_MS);
  }

  function clearFlushTimer(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  }

  function findActivity(toolCallId: string): AgentToolActivity | undefined {
    return tools.find((activity) => activity.id === toolCallId);
  }

  function upsertActivity(toolCallId: string, name: string, summary: string): void {
    const existing = findActivity(toolCallId);
    if (existing) return;
    tools.push({ id: toolCallId, name, status: "running", round, summary });
    toolCount += 1;
  }

  function dispatch(rawEvent: unknown): void {
    if (!isRecord(rawEvent) || typeof rawEvent.type !== "string") return;
    switch (rawEvent.type) {
      case "message_start": {
        const message = rawEvent.message;
        if (!isRecord(message) || message.role !== "assistant") return;
        // Keep the prior message's text until this one produces its own; a tool-only final
        // message must still converge to the last non-empty text, matching state.lastAssistantText.
        phase = "waiting_model";
        flush();
        return;
      }
      case "message_update": {
        const assistantEvent = rawEvent.assistantMessageEvent;
        const deltaType = isRecord(assistantEvent) ? assistantEvent.type : undefined;
        if (deltaType === "text_delta") {
          text = boundedTail(extractText(rawEvent.message as PiTurnEndAssistantMessage));
          phase = "writing";
          scheduleFlush();
        } else if (deltaType === "thinking_delta") {
          phase = "thinking";
          scheduleFlush();
        }
        return;
      }
      case "message_end": {
        const message = rawEvent.message;
        if (!isRecord(message) || message.role !== "assistant") return;
        const extracted = extractText(message as unknown as PiTurnEndAssistantMessage);
        if (extracted) text = boundedTail(extracted);
        flush();
        return;
      }
      case "tool_execution_start": {
        const toolCallId = asString(rawEvent.toolCallId);
        const toolName = asString(rawEvent.toolName);
        if (!toolCallId || isTaskLoopTool(toolName)) return;
        const args = rawEvent.args;
        const summarySource = isRecord(args) ? args.action ?? args.operation : undefined;
        upsertActivity(toolCallId, toolName, boundedSummary(summarySource));
        phase = "running_tools";
        flush();
        return;
      }
      case "tool_execution_update": {
        const toolCallId = asString(rawEvent.toolCallId);
        const activity = findActivity(toolCallId);
        if (!activity) return;
        const activityDetails = activityDetailsOf(rawEvent.partialResult);
        if (!activityDetails) return;
        if (isLiveActivityStatus(activityDetails.status)) activity.status = activityDetails.status;
        if (typeof activityDetails.summary === "string") activity.summary = boundedSummary(activityDetails.summary);
        flush();
        return;
      }
      case "tool_execution_end": {
        const toolName = asString(rawEvent.toolName);
        if (isTaskLoopTool(toolName)) {
          flush();
          return;
        }
        const toolCallId = asString(rawEvent.toolCallId);
        const activity = findActivity(toolCallId);
        if (activity) {
          const isError = Boolean(rawEvent.isError);
          const activityDetails = activityDetailsOf(rawEvent.result);
          // A gated call can finish without erroring or succeeding: it hands off to the approval broker.
          activity.status = isError ? "failed" : isLiveActivityStatus(activityDetails?.status) ? activityDetails.status : "succeeded";
          if (typeof activityDetails?.summary === "string") activity.summary = boundedSummary(activityDetails.summary);
          else if (isError) activity.summary = errorSummary(rawEvent.result);
        }
        flush();
        return;
      }
      case "turn_end":
        flush();
        return;
      case "compaction_start":
        phase = "compacting";
        flush();
        return;
      case "compaction_end":
        phase = "waiting_model";
        flush();
        return;
      case "auto_retry_start":
        retry = { attempt: Number(rawEvent.attempt) || 0, maxAttempts: Number(rawEvent.maxAttempts) || 0 };
        phase = "retrying";
        flush();
        return;
      case "auto_retry_end":
        retry = null;
        phase = "waiting_model";
        flush();
        return;
      default:
        return;
    }
  }

  function errorSummary(result: unknown): string {
    const errorText = firstResultText(result);
    const parsed = tryParseJsonObject(errorText);
    const code = isRecord(parsed?.error) ? parsed.error.code : undefined;
    if (typeof code === "string") return boundedSummary(code);
    return boundedSummary(errorText.split("\n")[0] ?? "");
  }

  return {
    start() {
      phase = "starting";
      round = 0;
      text = "";
      retry = null;
      tools.length = 0;
      toolCount = 0;
      flush();
    },
    round() {
      round += 1;
      flush();
    },
    handle(rawEvent: unknown) {
      try {
        dispatch(rawEvent);
      } catch {
        // Never let a projector failure break Pi's own event dispatch.
      }
    },
    cancelling() {
      phase = "cancelling";
      flush();
    },
    end() {
      clearFlushTimer();
      phase = "ended";
      flush();
    },
  };
}

function isTaskLoopTool(name: string): boolean {
  return (TASK_LOOP_TOOL_NAMES as readonly string[]).includes(name);
}

/** AgentToolDetails.activity only ever declares these two statuses; anything else (typo or otherwise) is ignored. */
function isLiveActivityStatus(value: unknown): value is "running" | "awaiting_approval" {
  return value === "running" || value === "awaiting_approval";
}

function activityDetailsOf(value: unknown): { status?: unknown; summary?: unknown } | undefined {
  const details = isRecord(value) ? value.details : undefined;
  const activity = isRecord(details) ? details.activity : undefined;
  return isRecord(activity) ? activity : undefined;
}

function firstResultText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return "";
  const block = result.content.find((item) => isRecord(item) && item.type === "text");
  return isRecord(block) && typeof block.text === "string" ? block.text : "";
}

function tryParseJsonObject(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
