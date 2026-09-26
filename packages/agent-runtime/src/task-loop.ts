import { Type } from "typebox";
import {
  AGENT_EFFORT_PROFILES,
  AGENT_PLAN_LIMITS,
  checkAgentPlan,
  type AgentEffortProfile,
  type AgentPlan,
  type AgentRunBudget,
  type AgentRunOutcome,
  type AgentTodo,
} from "@synthv-toolbox/runtime-protocol";

/** Minimal shape of the extension API surface the task loop needs; kept structural so tests can inject a fake. */
export interface PiToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  terminate?: boolean;
}

export interface PiToolDefinition<TParams = Record<string, unknown>> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute(toolCallId: string, params: TParams): Promise<PiToolResult>;
}

export interface PiBeforeAgentStartEvent {
  systemPrompt: string;
}

export interface PiBeforeAgentStartResult {
  systemPrompt?: string;
  message?: { customType: string; content: string; display?: boolean };
}

export interface PiTurnEndAssistantMessage {
  role: string;
  usage?: { input: number; output: number; cacheWrite: number };
  stopReason?: string;
  errorMessage?: string;
  content?: unknown[];
}

export interface PiTurnEndEvent {
  message: PiTurnEndAssistantMessage;
}

export interface PiToolCallEvent {
  toolName: string;
}

export interface PiToolExecutionEndEvent {
  toolName: string;
  isError: boolean;
}

export interface PiSessionCompactEvent {
  compactionEntry: { usage?: { input: number; output: number; cacheWrite: number } };
}

export interface PiExtensionApi {
  on(event: "before_agent_start", handler: (event: PiBeforeAgentStartEvent) => PiBeforeAgentStartResult | void): void;
  on(event: "turn_end", handler: (event: PiTurnEndEvent) => void): void;
  on(event: "tool_call", handler: (event: PiToolCallEvent) => { block?: boolean; reason?: string; terminate?: boolean } | void): void;
  on(event: "tool_execution_end", handler: (event: PiToolExecutionEndEvent) => void): void;
  on(event: "session_compact", handler: (event: PiSessionCompactEvent) => void): void;
  registerTool(definition: PiToolDefinition<any>): void;
}

export type TaskLoopSignal =
  | { kind: "completed"; summary: string; evidence: string[] }
  | { kind: "needs_input"; question: string; missing: string[] };

/** A pending request_input question restored from a seeded needs_input outcome; delivered once, then cleared. */
export interface TaskLoopPendingInput {
  question: string;
  missing: string[];
}

/** Mutable per-session state the inline extension closes over; persists across prompt() calls except for run-scoped fields, which prompt() resets. */
export interface TaskLoopState {
  plan: AgentPlan | null;
  budget: AgentRunBudget;
  turns: number;
  tokens: number;
  signal: TaskLoopSignal | null;
  roundProgress: number;
  roundError: { message: string; aborted: boolean } | null;
  finishAttemptUsed: boolean;
  cancelled: boolean;
  lastAssistantText: string;
  firstRound: boolean;
  pendingInput: TaskLoopPendingInput | null;
}

export function createTaskLoopState(plan: AgentPlan | null, budget: AgentRunBudget, pendingInput: TaskLoopPendingInput | null = null): TaskLoopState {
  return {
    plan,
    budget,
    turns: 0,
    tokens: 0,
    signal: null,
    roundProgress: 0,
    roundError: null,
    finishAttemptUsed: false,
    cancelled: false,
    lastAssistantText: "",
    firstRound: true,
    pendingInput,
  };
}

/** Resets the fields prompt() must reset for a fresh run; the plan carries over. */
export function resetRun(state: TaskLoopState, budget: AgentRunBudget): void {
  state.budget = budget;
  state.turns = 0;
  state.tokens = 0;
  state.signal = null;
  state.roundProgress = 0;
  state.roundError = null;
  state.finishAttemptUsed = false;
  state.cancelled = false;
  state.lastAssistantText = "";
  state.firstRound = true;
}

export function isBudgetExhausted(state: TaskLoopState): boolean {
  const { maxTurns, maxTokens } = state.budget;
  return (maxTurns !== null && state.turns >= maxTurns) || (maxTokens !== null && state.tokens >= maxTokens);
}

function budgetProgressLong(state: TaskLoopState): string {
  const { maxTurns, maxTokens } = state.budget;
  if (maxTurns === null || maxTokens === null) return "no budget limit";
  return `${state.turns} of ${maxTurns} turns, ${state.tokens} of ${maxTokens} tokens used`;
}

export function continuationPrompt(state: TaskLoopState): string {
  const goal = state.plan ? state.plan.goal : "the request";
  return [
    `Keep working toward the current plan's goal (${goal}). Call complete_task once every done criterion is met, or request_input if core information is missing. Budget used: ${budgetProgressLong(state)}.`,
    state.plan ? formatPlan(state.plan) : "No plan has been recorded yet.",
  ].join("\n\n");
}

function formatTodo(todo: AgentTodo): string {
  return `- [${todo.status}] ${todo.id}: ${todo.title}${todo.note ? ` (${todo.note})` : ""}`;
}

function formatPlan(plan: AgentPlan): string {
  const criteria = plan.doneCriteria.map((criterion) => `- ${criterion}`).join("\n");
  const todos = plan.todos.map(formatTodo).join("\n");
  return `Current plan:\nGoal: ${plan.goal}\nDone criteria:\n${criteria}\nTodos:\n${todos}`;
}

/** Static task protocol text; never carries run counters or the plan, so it is byte-identical across every round and run. */
const TASK_PROTOCOL_SECTION = [
  "",
  "## Task protocol",
  "Every request is a goal driven to an explicit end.",
  "Call update_plan first with the goal restated in one sentence, verifiable done criteria, and ordered todos (at most one in_progress).",
  "Update the plan as steps start, finish, or are cancelled; note rounds of iterative work (for example repeated parameter tuning) in a todo's note.",
  "End with complete_task (one evidence entry per done criterion, in order) or request_input when core information (a source file, target song, or a required decision) is missing.",
  "Todos never prevent completion.",
  "The runtime enforces a turn and token budget for this request and stops automatically once it is exhausted.",
  "Write plan text, summaries and questions in the user's language.",
].join("\n");

export function taskProtocolSection(): string {
  return TASK_PROTOCOL_SECTION;
}

/** Dynamic, per-run context delivered once via the before_agent_start message on the first round only. */
function firstRoundContext(state: TaskLoopState): string {
  const parts = [
    `Run budget for this request: ${budgetProgressLong(state)}.`,
    state.plan ? formatPlan(state.plan) : "No plan has been recorded yet.",
  ];
  if (state.pendingInput) {
    parts.push(
      `The previous run stopped to ask the user: ${state.pendingInput.question} Missing: ${state.pendingInput.missing.join(", ")}. The next message answers it.`,
    );
  }
  return parts.join("\n\n");
}

function extractText(message: PiTurnEndAssistantMessage): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is { type: string; text: string } =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("");
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= maxLength ? text : undefined;
}

function boundedTextList(values: unknown, maxLength: number): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const texts = values.map((value) => boundedText(value, maxLength));
  return texts.every((text): text is string => text !== undefined) ? texts : undefined;
}

const TodoStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
  Type.Literal("cancelled"),
]);

const UpdatePlanParams = Type.Object({
  goal: Type.String({ description: "The user's goal, restated in one sentence." }),
  doneCriteria: Type.Array(Type.String(), { description: "Verifiable criteria that together define done." }),
  todos: Type.Array(
    Type.Object({
      id: Type.String(),
      title: Type.String(),
      status: TodoStatus,
      note: Type.Optional(Type.String({ description: "Progress notes, e.g. rounds of iterative tuning." })),
    }),
    { description: "Ordered steps toward the goal. At most one may be in_progress." },
  ),
});

const CompleteTaskParams = Type.Object({
  summary: Type.String({ description: "Short summary of what was done." }),
  evidence: Type.Array(Type.String(), { description: "One entry per done criterion, in the same order." }),
});

const RequestInputParams = Type.Object({
  question: Type.String({ description: "What to ask the user." }),
  missing: Type.Array(Type.String(), { description: "The core information items that are missing." }),
});

/** Builds the per-session inline extension: the update_plan/complete_task/request_input tools plus the loop hooks. */
export function createTaskLoopExtension(state: TaskLoopState): { name: string; factory: (pi: PiExtensionApi) => void } {
  return {
    name: "synthv-task-loop",
    factory: (pi: PiExtensionApi) => {
      pi.registerTool({
        name: "update_plan",
        label: "Update plan",
        description: "Restate the user's goal, its verifiable done criteria, and the ordered todos tracking progress toward it. Call first, and again whenever the plan or a todo's status changes. Todos track progress only and never block completion.",
        promptSnippet: "Restate the goal, done criteria and todo list; call first and whenever they change",
        promptGuidelines: [
          "Call update_plan before any other action to restate the goal in one sentence, list verifiable done criteria, and lay out ordered todos.",
          "Call update_plan again whenever a todo starts, finishes, or is cancelled, or after a round of iterative work; record that in the todo's note.",
          "Todos track progress only; they never block calling complete_task.",
        ],
        parameters: UpdatePlanParams,
        async execute(_toolCallId, params) {
          const checked = checkAgentPlan(params);
          if ("error" in checked) throw new Error(checked.error);
          state.plan = checked.plan;
          return {
            content: [{ type: "text", text: `Plan updated: ${planProgress(state.plan)}.` }],
            details: checked.plan,
          };
        },
      });

      pi.registerTool({
        name: "complete_task",
        label: "Complete task",
        description: "End the run: every done criterion from the current plan is met. Requires update_plan to have been called first, with one evidence entry per done criterion, in order.",
        promptSnippet: "End the run once every done criterion is met, with one evidence entry each",
        promptGuidelines: [
          "Call complete_task only after update_plan has recorded done criteria, and only once every criterion is met.",
          "Give complete_task exactly one evidence entry per done criterion, in the same order, plus a short summary.",
          "Pending or cancelled todos never block complete_task.",
        ],
        parameters: CompleteTaskParams,
        async execute(_toolCallId, params: { summary: string; evidence: string[] }) {
          if (!state.plan) throw new Error("Call update_plan with the goal and done criteria first.");
          if (params.evidence.length !== state.plan.doneCriteria.length) {
            throw new Error(`evidence must have exactly ${state.plan.doneCriteria.length} entries, one per done criterion.`);
          }
          const summary = boundedText(params.summary, AGENT_PLAN_LIMITS.summaryLength);
          if (!summary) throw new Error(`summary must be non-empty text of at most ${AGENT_PLAN_LIMITS.summaryLength} characters.`);
          const evidence = boundedTextList(params.evidence, AGENT_PLAN_LIMITS.evidenceLength);
          if (!evidence) throw new Error(`Each evidence entry must be non-empty text of at most ${AGENT_PLAN_LIMITS.evidenceLength} characters.`);
          state.signal = { kind: "completed", summary, evidence };
          return {
            content: [{ type: "text", text: `Marked complete: ${summary}` }],
            details: { summary, evidence },
            terminate: true,
          };
        },
      });

      pi.registerTool({
        name: "request_input",
        label: "Request input",
        description: "End the run: ask the user for core information that is missing (for example a source file, target song, or a required decision).",
        promptSnippet: "End the run and ask when core information is missing",
        promptGuidelines: [
          "Call request_input when core information such as a source file, target song, or a required decision is missing, instead of guessing.",
          "List every missing item in request_input's missing array; question is what you are asking the user.",
        ],
        parameters: RequestInputParams,
        async execute(_toolCallId, params: { question: string; missing: string[] }) {
          const question = boundedText(params.question, AGENT_PLAN_LIMITS.summaryLength);
          if (!question) throw new Error(`question must be non-empty text of at most ${AGENT_PLAN_LIMITS.summaryLength} characters.`);
          if (!Array.isArray(params.missing) || params.missing.length === 0 || params.missing.length > AGENT_PLAN_LIMITS.missing) {
            throw new Error(`missing must list 1 to ${AGENT_PLAN_LIMITS.missing} items.`);
          }
          const missing = boundedTextList(params.missing, AGENT_PLAN_LIMITS.missingLength);
          if (!missing) throw new Error(`Each missing item must be non-empty text of at most ${AGENT_PLAN_LIMITS.missingLength} characters.`);
          state.signal = { kind: "needs_input", question, missing };
          return {
            content: [{ type: "text", text: `Requesting input: ${question}` }],
            details: { question, missing },
            terminate: true,
          };
        },
      });

      pi.on("before_agent_start", (event) => {
        const systemPrompt = `${event.systemPrompt}\n${taskProtocolSection()}`;
        if (!state.firstRound) return { systemPrompt };
        state.firstRound = false;
        const content = firstRoundContext(state);
        state.pendingInput = null;
        return {
          systemPrompt,
          message: { customType: "synthv-task-context", content, display: false },
        };
      });

      pi.on("turn_end", (event) => {
        const message = event.message;
        if (message.role !== "assistant") return;
        if (message.usage) state.tokens += message.usage.input + message.usage.output + message.usage.cacheWrite;
        if (message.stopReason === "error") {
          state.roundError = { message: message.errorMessage || "Model request failed.", aborted: false };
          return;
        }
        if (message.stopReason === "aborted") {
          state.roundError = { message: message.errorMessage || "Model request aborted.", aborted: true };
          return;
        }
        state.turns += 1;
        const text = extractText(message);
        if (text) state.lastAssistantText = text;
      });

      pi.on("tool_execution_end", (event) => {
        if (event.isError) return;
        if (event.toolName === "update_plan" || event.toolName === "complete_task" || event.toolName === "request_input") return;
        state.roundProgress += 1;
      });

      pi.on("session_compact", (event) => {
        const usage = event.compactionEntry?.usage;
        if (usage) state.tokens += usage.input + usage.output + usage.cacheWrite;
      });

      pi.on("tool_call", (event) => {
        if (state.signal) return { block: true, reason: "Run already ended.", terminate: true };
        if (!isBudgetExhausted(state)) return;
        if ((event.toolName === "complete_task" || event.toolName === "request_input") && !state.finishAttemptUsed) {
          state.finishAttemptUsed = true;
          return;
        }
        return { block: true, reason: "Run budget exhausted.", terminate: true };
      });
    },
  };
}

function planProgress(plan: AgentPlan | null): string {
  if (!plan) return "no plan yet";
  const completed = plan.todos.filter((todo) => todo.status === "completed").length;
  return `${completed}/${plan.todos.length} todos`;
}

async function runRound(state: TaskLoopState, runPrompt: (text: string) => Promise<void>, text: string): Promise<void> {
  state.roundProgress = 0;
  // Cast defeats TS narrowing the property to the null literal across the await below.
  state.roundError = null as TaskLoopState["roundError"];
  await runPrompt(text);
  const error = state.roundError;
  if (error && !error.aborted) throw new Error(error.message);
}

/** Runs the outer prompt/continuation loop and produces the run outcome. `runPrompt` sends one round to the session. */
export async function runTaskLoop(
  state: TaskLoopState,
  profile: AgentEffortProfile,
  input: string,
  runPrompt: (text: string) => Promise<void>,
): Promise<{ status: AgentRunOutcome["status"] }> {
  await runRound(state, runPrompt, input);
  let stopped = Boolean(state.roundError?.aborted);
  let idleStreak = !stopped && state.roundProgress === 0 ? 1 : 0;

  while (!stopped && !state.signal && !isBudgetExhausted(state)) {
    if (idleStreak > profile.maxIdleContinuations) break;
    await runRound(state, runPrompt, continuationPrompt(state));
    if (state.roundError?.aborted) {
      stopped = true;
      break;
    }
    idleStreak = state.roundProgress === 0 ? idleStreak + 1 : 0;
  }

  const status: AgentRunOutcome["status"] = state.cancelled
    ? "cancelled"
    : state.signal
      ? state.signal.kind === "completed" ? "completed" : "needs_input"
      : isBudgetExhausted(state) ? "budget_exhausted" : "incomplete";
  return { status };
}

export function buildOutcome(state: TaskLoopState, status: AgentRunOutcome["status"]): AgentRunOutcome {
  const budget = { ...state.budget, turns: state.turns, tokens: state.tokens };
  if (status === "completed" && state.signal?.kind === "completed") {
    return { status, summary: state.signal.summary, evidence: state.signal.evidence, missing: [], plan: state.plan, budget };
  }
  if (status === "needs_input" && state.signal?.kind === "needs_input") {
    return { status, summary: state.signal.question, evidence: [], missing: state.signal.missing, plan: state.plan, budget };
  }
  return { status, summary: "", evidence: [], missing: [], plan: state.plan, budget };
}

export function effortProfileFor(level: AgentRunBudget["level"]): AgentEffortProfile {
  return AGENT_EFFORT_PROFILES[level];
}
