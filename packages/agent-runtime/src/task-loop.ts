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

export interface PiTurnEndEvent {
  message: { role: string; usage?: { input: number; output: number; cacheWrite: number } };
}

export interface PiToolCallEvent {
  toolName: string;
}

export interface PiExtensionApi {
  on(event: "before_agent_start", handler: (event: PiBeforeAgentStartEvent) => { systemPrompt?: string } | void): void;
  on(event: "turn_end", handler: (event: PiTurnEndEvent) => void): void;
  on(event: "tool_call", handler: (event: PiToolCallEvent) => { block?: boolean; reason?: string; terminate?: boolean } | void): void;
  registerTool(definition: PiToolDefinition<any>): void;
}

export type TaskLoopSignal =
  | { kind: "completed"; summary: string; evidence: string[] }
  | { kind: "needs_input"; question: string; missing: string[] };

/** Mutable per-session state the inline extension closes over; persists across prompt() calls except for run-scoped fields, which prompt() resets. */
export interface TaskLoopState {
  plan: AgentPlan | null;
  budget: AgentRunBudget;
  turns: number;
  tokens: number;
  signal: TaskLoopSignal | null;
  roundToolCalls: number;
}

export function createTaskLoopState(plan: AgentPlan | null, budget: AgentRunBudget): TaskLoopState {
  return { plan, budget, turns: 0, tokens: 0, signal: null, roundToolCalls: 0 };
}

/** Resets the fields prompt() must reset for a fresh run; the plan carries over. */
export function resetRun(state: TaskLoopState, budget: AgentRunBudget): void {
  state.budget = budget;
  state.turns = 0;
  state.tokens = 0;
  state.signal = null;
  state.roundToolCalls = 0;
}

export function isBudgetExhausted(state: TaskLoopState): boolean {
  const { maxTurns, maxTokens } = state.budget;
  return (maxTurns !== null && state.turns >= maxTurns) || (maxTokens !== null && state.tokens >= maxTokens);
}

function budgetProgressShort(state: TaskLoopState): string {
  const { maxTurns, maxTokens } = state.budget;
  if (maxTurns === null || maxTokens === null) return "unlimited";
  return `${state.turns}/${maxTurns} turns, ${state.tokens}/${maxTokens} tokens`;
}

function budgetProgressLong(state: TaskLoopState): string {
  const { maxTurns, maxTokens } = state.budget;
  if (maxTurns === null || maxTokens === null) return "no budget limit";
  return `${state.turns} of ${maxTurns} turns, ${state.tokens} of ${maxTokens} tokens used`;
}

function planProgress(plan: AgentPlan | null): string {
  if (!plan) return "no plan yet";
  const completed = plan.todos.filter((todo) => todo.status === "completed").length;
  return `${completed}/${plan.todos.length} todos`;
}

export function continuationPrompt(state: TaskLoopState): string {
  const goal = state.plan ? state.plan.goal : "the request";
  return `Keep working toward the current plan's goal (${goal}). Call complete_task once every done criterion is met, or request_input if core information is missing. Budget used: ${budgetProgressLong(state)}.`;
}

function formatTodo(todo: AgentTodo): string {
  return `- [${todo.status}] ${todo.id}: ${todo.title}${todo.note ? ` (${todo.note})` : ""}`;
}

function formatPlan(plan: AgentPlan): string {
  const criteria = plan.doneCriteria.map((criterion) => `- ${criterion}`).join("\n");
  const todos = plan.todos.map(formatTodo).join("\n");
  return `Current plan:\nGoal: ${plan.goal}\nDone criteria:\n${criteria}\nTodos:\n${todos}`;
}

/** Appends the task protocol section to the chained system prompt; called once per round (each session.prompt()). */
export function taskProtocolSection(state: TaskLoopState): string {
  return [
    "",
    "## Task protocol",
    "Every request is a goal driven to an explicit end.",
    "Call update_plan first with the goal restated in one sentence, verifiable done criteria, and ordered todos (at most one in_progress).",
    "Update the plan as steps start, finish, or are cancelled; note rounds of iterative work (for example repeated parameter tuning) in a todo's note.",
    "End with complete_task (one evidence entry per done criterion, in order) or request_input when core information (a source file, target song, or a required decision) is missing.",
    "Todos never prevent completion.",
    `Run budget for this request: ${budgetProgressLong(state)}. The runtime stops automatically once it is exhausted.`,
    "Write plan text, summaries and questions in the user's language.",
    state.plan ? formatPlan(state.plan) : "No plan has been recorded yet.",
  ].join("\n");
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
          state.signal = null;
          return {
            content: [{ type: "text", text: `Plan updated: ${planProgress(state.plan)}, ${budgetProgressShort(state)}.` }],
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

      pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n${taskProtocolSection(state)}` }));

      pi.on("turn_end", (event) => {
        state.turns += 1;
        const message = event.message;
        if (message.role === "assistant" && message.usage) {
          state.tokens += message.usage.input + message.usage.output + message.usage.cacheWrite;
        }
      });

      pi.on("tool_call", (event) => {
        if (!isBudgetExhausted(state)) {
          state.roundToolCalls += 1;
          return;
        }
        if (event.toolName === "complete_task" || event.toolName === "request_input") {
          state.roundToolCalls += 1;
          return;
        }
        return { block: true, reason: "Run budget exhausted.", terminate: true };
      });
    },
  };
}

/** Runs the outer prompt/continuation loop and produces the run outcome. `runPrompt` sends one round to the session. */
export async function runTaskLoop(
  state: TaskLoopState,
  profile: AgentEffortProfile,
  input: string,
  runPrompt: (text: string) => Promise<void>,
): Promise<{ status: AgentRunOutcome["status"] }> {
  state.roundToolCalls = 0;
  await runPrompt(input);
  let idleStreak = state.roundToolCalls === 0 ? 1 : 0;

  while (!state.signal && !isBudgetExhausted(state)) {
    if (idleStreak > profile.maxIdleContinuations) break;
    state.roundToolCalls = 0;
    await runPrompt(continuationPrompt(state));
    idleStreak = state.roundToolCalls === 0 ? idleStreak + 1 : 0;
  }

  const status: AgentRunOutcome["status"] = state.signal
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
