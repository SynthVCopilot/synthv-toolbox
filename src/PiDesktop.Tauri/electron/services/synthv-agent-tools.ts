import type { AgentToolDetails, PiExtensionApi, PiInlineExtension, PiToolResult } from "@synthv-toolbox/agent-runtime";
import type { AgentApprovalBroker, AgentApprovalCategory, AgentApprovalResolution, AgentApprovalTool } from "./agent-approvals.js";
import type { EmbeddedBridge } from "./synthv-bridge.js";

const SEQUENTIAL_TOOLS = new Set(["sv_command", "sv_ui", "sv_status"]);
const NO_PROGRESS_TOOLS = new Set(["sv_status", "sv_describe", "sv_review"]);
const PROMPT_SNIPPETS: Record<string, string> = {
  sv_status: "Check bridge and SynthV connectivity before reading or writing",
  sv_describe: "Read the current SynthV UI and selection context",
  sv_query: "Read project data; pass contextMode writeIntent before a write",
  sv_command: "Apply a project edit; high-risk actions require Edit-mode approval",
  sv_ui: "Read or change SynthV UI state; some actions require Edit-mode approval",
  sv_review: "Summarize recent changes for the user",
};

const AWAIT_APPROVAL_TOOL = "sv_await_approval";
const AWAIT_APPROVAL_MAX_SECONDS = 120;

const APP_RULES = [
  "follow the sv_status -> sv_describe -> sv_query (contextMode writeIntent) -> sv_command loop",
  "do not change user state (selection, current group, playhead, viewport, note language) unless asked",
  "record a plan with update_plan before bulk or destructive edits",
  "on STALE_* or SYNTHV_SESSION_CHANGED, re-read and never blindly retry",
  "BRIDGE_TIMEOUT means the outcome is unknown: re-read and compare, and never resend the old payload",
  "on BRIDGE_BUSY, wait, re-read, then retry",
  "on BRIDGE_NOT_CONNECTED, call request_input asking the user to start SynthV Agent Bridge",
  "on APPROVAL_DENIED, do not repeat the same write; adapt or call request_input",
  "when a call returns approval_pending, continue independent work",
  "call sv_await_approval when nothing else can proceed",
  "never resubmit the same write while its approval is pending",
  "after an executed approval, re-read before further writes",
  "denied or expired means adapt or call request_input",
  "when writers.lastWriteByOtherClient is true, re-read before writing and tell the user",
];

/**
 * Routes an AgentApprovalBroker's single `deliver` callback to the Pi extension of whichever session owns the
 * resolved approval. The per-conversation queue and delivered-id set live here, not in the extension's closure,
 * so they outlive any one Pi session (a model switch or any other signature change disposes and recreates it).
 */
export interface SynthVDeliveryRegistry {
  deliver(resolution: AgentApprovalResolution): void;
  /** `handler` steers the resolution into an active run and returns whether it did; when it returns false (or no handler is registered), the resolution queues for the next run. */
  register(sessionId: string, handler: (resolution: AgentApprovalResolution) => boolean): () => void;
  /** Removes and returns this conversation's queued resolutions, for before_agent_start to fold into the next run's context. */
  drain(conversationId: string): AgentApprovalResolution[];
  /** Whether `deliver()` has already handed this id to this conversation, steered or queued. */
  isDelivered(conversationId: string, id: string): boolean;
}

export function createSynthVDeliveryRegistry(): SynthVDeliveryRegistry {
  const handlers = new Map<string, (resolution: AgentApprovalResolution) => boolean>();
  const queues = new Map<string, AgentApprovalResolution[]>();
  const deliveredIds = new Map<string, Set<string>>();

  function deliveredSet(conversationId: string): Set<string> {
    let set = deliveredIds.get(conversationId);
    if (!set) { set = new Set(); deliveredIds.set(conversationId, set); }
    return set;
  }

  return {
    deliver(resolution) {
      deliveredSet(resolution.conversationId).add(resolution.id);
      const steered = handlers.get(resolution.conversationId)?.(resolution) ?? false;
      if (!steered) {
        const queue = queues.get(resolution.conversationId) ?? [];
        queue.push(resolution);
        queues.set(resolution.conversationId, queue);
      }
    },
    register(sessionId, handler) {
      handlers.set(sessionId, handler);
      return () => { if (handlers.get(sessionId) === handler) handlers.delete(sessionId); };
    },
    drain(conversationId) {
      const queue = queues.get(conversationId) ?? [];
      queues.set(conversationId, []);
      return queue;
    },
    isDelivered(conversationId, id) { return deliveredIds.get(conversationId)?.has(id) ?? false; },
  };
}

export interface SynthVToolsExtensionOptions {
  readonly bridge: Pick<EmbeddedBridge, "tools" | "instructions" | "classify" | "status">;
  readonly approvals: AgentApprovalBroker;
  readonly workMode: () => "edit" | "solo";
  readonly sessionId: string;
  /** Whether this session currently has a run in flight; determines steer vs queued delivery of approval resolutions. */
  readonly runState: () => { active: boolean; runId: string | null };
  /** Registers the completion-blocking check for pending approvals of this session. */
  readonly guards: { completion(check: () => string | null): void };
  /** Shared across every session's extension instance so the broker's one `deliver` callback reaches the right session. */
  readonly registry: SynthVDeliveryRegistry;
}

function failedOutcome(code: string, message: string, phase: string, retry: string): string {
  return JSON.stringify({ outcome: "failed", phase, wrote: false, undoRequired: false, retry, error: { code, message } });
}

function toolResultError(code: string, message: string, phase: string, retry: string): Error {
  return new Error(failedOutcome(code, message, phase, retry));
}

function resolutionSummary(resolution: AgentApprovalResolution): string {
  const prefix = `SynthV approval ${resolution.id} (${resolution.action})`;
  if (resolution.outcome === "executed") {
    // resolution.summary is the bridge's own failure envelope on failure (see agent-approvals.ts's finish());
    // it is never re-wrapped, so phase/wrote/undoRequired/retry reach the model as the bridge reported them.
    return resolution.ok
      ? `${prefix} was approved and executed: ${resolution.summary}`
      : `${prefix}: ${resolution.summary}`;
  }
  if (resolution.outcome === "denied") return `${prefix}: ${failedOutcome("APPROVAL_DENIED", "The user denied this call.", "accepted", "correct_request")}`;
  if (resolution.outcome === "expired") return `${prefix}: ${failedOutcome("APPROVAL_EXPIRED", "The approval expired after 2 minutes without a decision.", "accepted", "correct_request")}`;
  return `${prefix}: ${failedOutcome("RUN_CANCELLED", "The run was cancelled before this approval was decided.", "accepted", "query_again")}`;
}

function actionOf(params: unknown): string {
  if (params && typeof params === "object") {
    const record = params as Record<string, unknown>;
    if (typeof record.action === "string") return record.action;
    if (typeof record.operation === "string") return record.operation;
  }
  return "unknown";
}

function previewText(action: string, params: unknown): string {
  return JSON.stringify({ action, params });
}

function buildSynthVSection(instructions: string): string {
  return ["## SynthV", instructions, ...APP_RULES.map((rule) => `- ${rule}`)].join("\n");
}

/** An AbortSignal that fires when `timeoutMs` elapses or `parent` aborts, whichever comes first. */
function timeoutSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  if (parent?.aborted) { controller.abort(); return controller.signal; }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onParentAbort = () => controller.abort();
  parent?.addEventListener("abort", onParentAbort, { once: true });
  controller.signal.addEventListener("abort", () => { clearTimeout(timer); parent?.removeEventListener("abort", onParentAbort); }, { once: true });
  return controller.signal;
}

/** A resolution the broker settled, a still-pending/executing approval a wait timed out or aborted on, or an id this conversation cannot find (unknown, foreign, or evicted after the 5-minute retention). */
type AwaitedApproval = AgentApprovalResolution | { id: string; resolution: "pending"; expiresAtUtc: string | null } | { id: string; resolution: "unknown" };

/**
 * Waits for each id via the broker, skipping ids already handed to the model through `deliver()` (the
 * steering/queued path): returning them again here would tell the model about the same resolution twice.
 */
async function waitForApprovals(approvals: AgentApprovalBroker, ids: readonly string[], conversationId: string, timeoutMs: number, isDelivered: (id: string) => boolean, signal?: AbortSignal): Promise<AwaitedApproval[]> {
  const targets = ids.filter((id) => !isDelivered(id));
  if (targets.length === 0) return [];
  return Promise.all(targets.map(async (id) => {
    const resolution = await approvals.wait(id, conversationId, timeoutSignal(timeoutMs, signal));
    if (resolution) return resolution;
    if (approvals.isActive(id, conversationId)) return { id, resolution: "pending" as const, expiresAtUtc: approvals.expiresAtUtc(id, conversationId) };
    return { id, resolution: "unknown" as const };
  }));
}

/** Registers the six SynthV bridge tools plus sv_await_approval as a Pi inline extension; Edit-mode gating and approval delivery live here. */
export function createSynthVToolsExtension(options: SynthVToolsExtensionOptions): PiInlineExtension {
  const { bridge, approvals, workMode, sessionId } = options;

  return {
    name: "synthv-bridge-tools",
    factory(pi: PiExtensionApi) {
      options.guards.completion(() => {
        const pendingCount = approvals.activeIds(sessionId).length;
        return pendingCount > 0 ? `${pendingCount} SynthV approvals are still pending; call sv_await_approval or request_input.` : null;
      });

      const unregister = options.registry.register(sessionId, (resolution) => {
        const active = options.runState().active;
        if (active) pi.sendMessage({ customType: "synthv-approvals", content: resolutionSummary(resolution), display: false }, { deliverAs: "steer" });
        return active;
      });
      pi.on("session_shutdown", unregister);

      for (const tool of bridge.tools) {
        pi.registerTool({
          name: tool.name,
          label: tool.title,
          description: tool.description,
          parameters: tool.inputSchema,
          promptSnippet: PROMPT_SNIPPETS[tool.name],
          executionMode: SEQUENTIAL_TOOLS.has(tool.name) ? "sequential" : "parallel",
          execute: async (toolCallId, params, signal): Promise<PiToolResult> => {
            const classification = bridge.classify(tool.name, params);
            const gated = workMode() === "edit" && classification.risk === "high";

            if (gated) {
              const status = await bridge.status();
              if (!status.connected) throw toolResultError("BRIDGE_NOT_CONNECTED", "SynthV Agent Bridge is not connected.", "freshRead", "start_bridge");
              const runId = options.runState().runId;
              if (!runId) throw toolResultError("RUN_CANCELLED", "The run was cancelled before the call was sent.", "accepted", "query_again");
              const action = actionOf(params);
              const approval = approvals.submit({
                conversationId: sessionId,
                runId,
                toolCallId,
                tool: tool.name as AgentApprovalTool,
                action,
                category: classification.category as AgentApprovalCategory,
                preview: previewText(action, params),
                params,
              });
              const details: AgentToolDetails = { activity: { status: "awaiting_approval", summary: approval.action }, progress: false };
              return {
                content: [{ type: "text", text: JSON.stringify({ outcome: "approval_pending", approvalId: approval.id, action: approval.action, expiresAtUtc: approval.expiresAtUtc }) }],
                details,
              };
            }

            if (signal?.aborted) throw toolResultError("RUN_CANCELLED", "The run was cancelled before the call was sent.", "accepted", "query_again");
            const result = await tool.call(params);
            if (result.isError) throw new Error(result.text);
            const details: AgentToolDetails = NO_PROGRESS_TOOLS.has(tool.name) ? { progress: false } : {};
            return { content: [{ type: "text", text: result.text }], details };
          },
        });
      }

      pi.registerTool({
        name: AWAIT_APPROVAL_TOOL,
        label: "Await SynthV approval",
        description: "Waits until the listed SynthV approvals, or all pending approvals of this conversation, resolve or time out.",
        promptSnippet: "Call when nothing else can proceed while a SynthV approval is pending",
        parameters: {
          type: "object",
          properties: {
            approvalIds: { type: "array", items: { type: "string" } },
            timeoutSec: { type: "number", minimum: 1, maximum: AWAIT_APPROVAL_MAX_SECONDS },
          },
          additionalProperties: false,
        },
        execute: async (_toolCallId, params, signal): Promise<PiToolResult> => {
          const requested = Array.isArray((params as { approvalIds?: unknown }).approvalIds) ? (params as { approvalIds: string[] }).approvalIds : undefined;
          const ids = requested ?? approvals.activeIds(sessionId);
          const timeoutSecRaw = (params as { timeoutSec?: unknown }).timeoutSec;
          const timeoutMs = Math.min(typeof timeoutSecRaw === "number" && timeoutSecRaw > 0 ? timeoutSecRaw : AWAIT_APPROVAL_MAX_SECONDS, AWAIT_APPROVAL_MAX_SECONDS) * 1000;
          const resolutions = await waitForApprovals(approvals, ids, sessionId, timeoutMs, (id) => options.registry.isDelivered(sessionId, id), signal);
          // A benign result here (even one already carrying a "cancelled" resolution) would need another
          // full round trip for the model to see it; an aborted run must end now instead, without one.
          if (signal?.aborted) {
            // This tool result is about to be discarded: hand any settled resolution the live wait already
            // received to the registry now, so it is not lost when the run had more than one approval pending.
            for (const resolution of resolutions) {
              if ("outcome" in resolution && !options.registry.isDelivered(sessionId, resolution.id)) options.registry.deliver(resolution);
            }
            throw toolResultError("RUN_CANCELLED", "The run was cancelled before this wait completed.", "accepted", "query_again");
          }
          const progressed = resolutions.some((resolution) => "outcome" in resolution && resolution.outcome === "executed" && resolution.ok);
          const details: AgentToolDetails = progressed ? {} : { progress: false };
          return { content: [{ type: "text", text: JSON.stringify({ resolutions }) }], details };
        },
      });

      pi.on("before_agent_start", (event) => {
        const queued = options.registry.drain(sessionId);
        const context = queued.length > 0 ? queued.map(resolutionSummary).join("\n") : undefined;
        return {
          systemPrompt: `${event.systemPrompt}\n${buildSynthVSection(bridge.instructions)}`,
          ...(context ? { message: { customType: "synthv-approvals", content: context, display: false } } : {}),
        };
      });
    },
  };
}
