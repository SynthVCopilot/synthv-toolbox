/** A JSON-compatible value that can safely travel in an RPC envelope. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ApiVersion = `${number}.${number}`;

export const PROTOCOL_VERSION: ApiVersion = "1.0";

export const HOST_API_VERSION: ApiVersion = "1.0";

export interface VersionRange {
  min: ApiVersion;
  max: ApiVersion;
}

export const PROTOCOL_VERSION_RANGE: VersionRange = {
  min: PROTOCOL_VERSION,
  max: PROTOCOL_VERSION,
};

export interface CapabilityDescriptor {
  id: string;
  version: ApiVersion;
  operations: string[];
}

export interface RuntimeHello {
  runtimeId: string;
  protocol: VersionRange;
  capabilities: CapabilityDescriptor[];
}

export interface HostHello {
  hostId: string;
  protocol: VersionRange;
  capabilities: CapabilityDescriptor[];
}

export type Sv2SessionReadParams = {
  path: string;
};

export type Sv2SessionDocument = {
  path: string;
  encryptedSha256: string;
  encryptedBytes: number;
  plaintext: string;
};

export type Sv2SessionWriteParams = {
  path: string;
  expectedSha256: string;
  plaintext: string;
};

export type Sv2SessionWriteResult = {
  path: string;
  encryptedSha256: string;
  encryptedBytes: number;
  backupPath: string;
};

export type AgentTodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface AgentTodo {
  id: string;
  title: string;
  status: AgentTodoStatus;
  note?: string;
}

/** The agent's restatement of the user goal, its verifiable done criteria and the ordered steps toward it. */
export interface AgentPlan {
  goal: string;
  doneCriteria: string[];
  todos: AgentTodo[];
}

export type AgentEffortLevel = "low" | "mid" | "high" | "max";

export type AgentThinkingLevel = "low" | "medium" | "high" | "xhigh";

/**
 * Per-level loop policy. Each budget limit sits `sigmas` log-space deviations above the fitted mean of that
 * level's runs, so by the union bound over turns and tokens at least `coverage` of runs (the 1σ/2σ/3σ
 * empirical rule) finish on their own; `null` means unlimited. `compactionTrigger` is the share of the
 * model context window after which Pi compacts; `null` keeps Pi's default reserve.
 */
export interface AgentEffortProfile {
  coverage: number | null;
  sigmas: number | null;
  thinking: AgentThinkingLevel;
  compactionTrigger: number | null;
  keepRecentTokens: number;
  maxIdleContinuations: number;
}

export const AGENT_EFFORT_LEVELS: readonly AgentEffortLevel[] = ["low", "mid", "high", "max"];

export const DEFAULT_AGENT_EFFORT: AgentEffortLevel = "mid";

export const AGENT_EFFORT_PROFILES: Readonly<Record<AgentEffortLevel, AgentEffortProfile>> = {
  low: { coverage: 0.6827, sigmas: 1, thinking: "low", compactionTrigger: 0.5, keepRecentTokens: 12_000, maxIdleContinuations: 1 },
  mid: { coverage: 0.9545, sigmas: 2, thinking: "medium", compactionTrigger: 0.7, keepRecentTokens: 20_000, maxIdleContinuations: 2 },
  high: { coverage: 0.9973, sigmas: 3, thinking: "high", compactionTrigger: 0.85, keepRecentTokens: 32_000, maxIdleContinuations: 3 },
  max: { coverage: null, sigmas: null, thinking: "xhigh", compactionTrigger: null, keepRecentTokens: 48_000, maxIdleContinuations: 4 },
};

/** Log-normal prior used until enough finished runs exist; medians and log-space deviations per metric. */
export const AGENT_BUDGET_PRIOR = {
  turns: { median: 4, logSigma: 0.9 },
  tokens: { median: 60_000, logSigma: 1 },
} as const;

export const AGENT_BUDGET_MIN_SAMPLES = 20;

export const AGENT_BUDGET_WINDOW = 200;

export const AGENT_BUDGET_FLOOR = { turns: 2, tokens: 20_000 } as const;

/** One finished run; `censored` marks runs stopped by their budget, whose true need is at least the recorded usage. */
export interface AgentUsageSample {
  level: AgentEffortLevel;
  turns: number;
  tokens: number;
  censored: boolean;
}

/** Budget tokens count uncached input, cache writes and output; cache reads are excluded. `null` limits are unlimited. */
export interface AgentRunBudget {
  level: AgentEffortLevel;
  maxTurns: number | null;
  maxTokens: number | null;
}

export interface AgentBudgetUsage extends AgentRunBudget {
  turns: number;
  tokens: number;
}

/**
 * How one agent run ended.
 * - `completed`: the agent called the completion tool.
 * - `needs_input`: the agent stopped the loop because core information is missing.
 * - `budget_exhausted`: the effort budget ran out before either signal.
 * - `incomplete`: the agent stopped advancing without a signal while budget remained.
 * - `cancelled`: the user stopped the run.
 */
export type AgentRunStatus = "completed" | "needs_input" | "budget_exhausted" | "incomplete" | "cancelled";

export interface AgentRunOutcome {
  status: AgentRunStatus;
  summary: string;
  evidence: string[];
  missing: string[];
  plan: AgentPlan | null;
  budget: AgentBudgetUsage;
}

/** `outcome` is the conversation's latest run outcome, used to restore the plan and any pending question when a session is recreated. */
export interface AgentSessionInitializeParams {
  sessionId: string;
  cwd?: string;
  systemPrompt?: string;
  outcome?: AgentRunOutcome;
}

export interface AgentSessionCancelParams {
  sessionId: string;
}

export interface AgentSessionSendParams {
  sessionId: string;
  input: string;
  budget?: AgentRunBudget;
}

export interface AgentSessionSendResult {
  sessionId: string;
  accepted: true;
  message: string;
  outcome: AgentRunOutcome;
}

export const AGENT_PLAN_LIMITS = {
  goalLength: 500,
  criteria: 10,
  criterionLength: 300,
  todos: 30,
  todoIdLength: 40,
  todoTitleLength: 200,
  todoNoteLength: 300,
  summaryLength: 4000,
  evidenceLength: 300,
  missing: 10,
  missingLength: 300,
} as const;

export interface RpcRequest {
  kind: "request";
  id: string;
  protocolVersion: ApiVersion;
  method: string;
  params: JsonValue;
}

export interface RpcResponseSuccess {
  kind: "response";
  id: string;
  protocolVersion: ApiVersion;
  ok: true;
  result: JsonValue;
}

export interface RpcError {
  code: string;
  message: string;
  data?: JsonValue;
}

export interface RpcResponseFailure {
  kind: "response";
  id: string;
  protocolVersion: ApiVersion;
  ok: false;
  error: RpcError;
}

export interface RpcNotification {
  kind: "notification";
  protocolVersion: ApiVersion;
  event: string;
  params: JsonValue;
}

export type RpcMessage = RpcRequest | RpcResponseSuccess | RpcResponseFailure | RpcNotification;

export const HOST_HELLO_METHOD = "host.hello";
export const RUNTIME_HELLO_METHOD = "runtime.hello";

export type PluginPermission =
  | "agent.tools"
  | "host.advanced"
  | "host.internal"
  | "host.read"
  | "host.execute"
  | "project.read"
  | "project.write";

export type PluginPermissionLevel = "none" | "optional" | "required";

export type PluginPermissions = Partial<Record<PluginPermission, PluginPermissionLevel>>;

export type PluginActionLocation =
  | "home.toolbar"
  | "project.toolbar"
  | "project.context"
  | "conversation.toolbar";

export interface PluginBackend {
  entry: string;
}

export interface PluginPageContribution {
  id: string;
  title: string;
  entry: string;
  icon?: string;
}

export interface PluginActionContribution {
  id: string;
  location: PluginActionLocation;
  title: string;
  icon?: string;
  whenCapability?: string;
}

export interface PluginManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  hostApi: VersionRange;
  backend?: PluginBackend;
  pages?: PluginPageContribution[];
  actions?: PluginActionContribution[];
  permissions: PluginPermissions;
}

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const identifierPattern = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const contributionIdPattern = /^[a-z][a-z0-9-]*$/;
const permittedActions = new Set<PluginActionLocation>([
  "home.toolbar",
  "project.toolbar",
  "project.context",
  "conversation.toolbar",
]);
const permittedPermissions = new Set<PluginPermission>([
  "agent.tools",
  "host.advanced",
  "host.internal",
  "host.read",
  "host.execute",
  "project.read",
  "project.write",
]);

export function parseApiVersion(value: string): ApiVersion | undefined {
  return versionPattern.test(value) ? value as ApiVersion : undefined;
}

export function compareApiVersions(left: ApiVersion, right: ApiVersion): number {
  const [leftMajor, leftMinor] = left.split(".").map(Number);
  const [rightMajor, rightMinor] = right.split(".").map(Number);
  if (leftMajor !== rightMajor) return leftMajor - rightMajor;
  return leftMinor - rightMinor;
}

export function negotiateProtocolVersion(left: VersionRange, right: VersionRange): ApiVersion | undefined {
  const lower = compareApiVersions(left.min, right.min) >= 0 ? left.min : right.min;
  const upper = compareApiVersions(left.max, right.max) <= 0 ? left.max : right.max;
  return compareApiVersions(lower, upper) <= 0 ? upper : undefined;
}

export function isHostApiCompatible(manifest: PluginManifest, hostApiVersion: ApiVersion = HOST_API_VERSION): boolean {
  return compareApiVersions(manifest.hostApi.min, hostApiVersion) <= 0
    && compareApiVersions(hostApiVersion, manifest.hostApi.max) <= 0;
}

export function encodeJsonl(message: RpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseJsonl(line: string): RpcMessage {
  if (line.includes("\n") || line.includes("\r")) {
    throw new Error("JSONL input must contain exactly one line.");
  }

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("JSONL input is not valid JSON.");
  }

  const message = validateRpcMessage(value);
  if (!message) throw new Error("JSONL input is not a valid RPC message.");
  return message;
}

export function validateRpcMessage(value: unknown): RpcMessage | undefined {
  if (!isRecord(value) || !isApiVersion(value.protocolVersion) || typeof value.kind !== "string") return undefined;

  if (value.kind === "request") {
    if (isNonEmptyString(value.id) && isNonEmptyString(value.method) && isJsonValue(value.params)) {
      return { kind: "request", id: value.id, protocolVersion: value.protocolVersion, method: value.method, params: value.params };
    }
    return undefined;
  }

  if (value.kind === "notification") {
    if (isNonEmptyString(value.event) && isJsonValue(value.params)) {
      return { kind: "notification", protocolVersion: value.protocolVersion, event: value.event, params: value.params };
    }
    return undefined;
  }

  if (value.kind === "response" && isNonEmptyString(value.id) && typeof value.ok === "boolean") {
    if (value.ok && isJsonValue(value.result)) {
      return { kind: "response", id: value.id, protocolVersion: value.protocolVersion, ok: true, result: value.result };
    }
    if (!value.ok && isRpcError(value.error)) {
      return { kind: "response", id: value.id, protocolVersion: value.protocolVersion, ok: false, error: value.error };
    }
  }

  return undefined;
}

export function validatePluginManifest(value: unknown): PluginManifest | undefined {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !isPluginIdentifier(value.id)
    || !isNonEmptyString(value.name)
    || typeof value.version !== "string"
    || !semverPattern.test(value.version)
    || !isVersionRange(value.hostApi)
    || (value.permissions !== undefined && !isPluginPermissions(value.permissions))) return undefined;

  const permissions = value.permissions === undefined ? {} : value.permissions;

  const backend = validatePluginBackend(value.backend);
  if (value.backend !== undefined && !backend) return undefined;
  const pages = validatePluginPages(value.pages);
  if (value.pages !== undefined && !pages) return undefined;
  const actions = validatePluginActions(value.actions);
  if (value.actions !== undefined && !actions) return undefined;

  return {
    schemaVersion: 1,
    id: value.id,
    name: value.name,
    version: value.version,
    hostApi: value.hostApi,
    ...(backend ? { backend } : {}),
    ...(pages ? { pages } : {}),
    ...(actions ? { actions } : {}),
    permissions,
  };
}

export function pluginPermissionLevel(manifest: PluginManifest, permission: PluginPermission): PluginPermissionLevel {
  return manifest.permissions[permission] ?? "none";
}

/** Returns a trimmed plan, or a reason the plan violates the protocol. */
export function checkAgentPlan(value: unknown): { plan: AgentPlan } | { error: string } {
  if (!isRecord(value)) return { error: "plan must be an object." };
  const goal = boundedText(value.goal, AGENT_PLAN_LIMITS.goalLength);
  if (!goal) return { error: `goal must be non-empty text of at most ${AGENT_PLAN_LIMITS.goalLength} characters.` };
  if (!Array.isArray(value.doneCriteria) || value.doneCriteria.length === 0 || value.doneCriteria.length > AGENT_PLAN_LIMITS.criteria) {
    return { error: `doneCriteria must list 1 to ${AGENT_PLAN_LIMITS.criteria} criteria.` };
  }
  const doneCriteria: string[] = [];
  for (const criterion of value.doneCriteria) {
    const text = boundedText(criterion, AGENT_PLAN_LIMITS.criterionLength);
    if (!text) return { error: `Each done criterion must be non-empty text of at most ${AGENT_PLAN_LIMITS.criterionLength} characters.` };
    doneCriteria.push(text);
  }
  if (!Array.isArray(value.todos) || value.todos.length === 0 || value.todos.length > AGENT_PLAN_LIMITS.todos) {
    return { error: `todos must list 1 to ${AGENT_PLAN_LIMITS.todos} steps.` };
  }
  const todos: AgentTodo[] = [];
  for (const todo of value.todos) {
    if (!isRecord(todo)) return { error: "Each todo must be an object." };
    const id = boundedText(todo.id, AGENT_PLAN_LIMITS.todoIdLength);
    const title = boundedText(todo.title, AGENT_PLAN_LIMITS.todoTitleLength);
    if (!id || !title) return { error: `Each todo needs an id of at most ${AGENT_PLAN_LIMITS.todoIdLength} characters and a title of at most ${AGENT_PLAN_LIMITS.todoTitleLength} characters.` };
    if (!isAgentTodoStatus(todo.status)) return { error: `Todo ${id} has an invalid status.` };
    const note = todo.note === undefined ? undefined : boundedText(todo.note, AGENT_PLAN_LIMITS.todoNoteLength);
    if (todo.note !== undefined && !note) return { error: `Todo ${id} note must be non-empty text of at most ${AGENT_PLAN_LIMITS.todoNoteLength} characters.` };
    todos.push({ id, title, status: todo.status, ...(note ? { note } : {}) });
  }
  if (!hasUniqueIds(todos)) return { error: "Todo ids must be unique." };
  if (todos.filter((todo) => todo.status === "in_progress").length > 1) return { error: "At most one todo can be in_progress." };
  return { plan: { goal, doneCriteria, todos } };
}

export function validateAgentPlan(value: unknown): AgentPlan | undefined {
  const checked = checkAgentPlan(value);
  return "plan" in checked ? checked.plan : undefined;
}

export function isAgentEffortLevel(value: unknown): value is AgentEffortLevel {
  return typeof value === "string" && AGENT_EFFORT_LEVELS.includes(value as AgentEffortLevel);
}

export function validateAgentRunOutcome(value: unknown): AgentRunOutcome | undefined {
  if (!isRecord(value) || !isAgentRunStatus(value.status) || typeof value.summary !== "string"
    || value.summary.length > AGENT_PLAN_LIMITS.summaryLength || !Array.isArray(value.evidence) || !Array.isArray(value.missing)) return undefined;
  const plan = value.plan === null ? null : validateAgentPlan(value.plan);
  const budget = validateAgentBudgetUsage(value.budget);
  if (plan === undefined || !budget) return undefined;
  const summary = value.summary.trim();
  const evidence = boundedTextList(value.evidence, AGENT_PLAN_LIMITS.evidenceLength);
  const missing = boundedTextList(value.missing, AGENT_PLAN_LIMITS.missingLength);
  if (!evidence || !missing || missing.length > AGENT_PLAN_LIMITS.missing) return undefined;
  if (value.status === "completed" && (!summary || !plan || evidence.length !== plan.doneCriteria.length || missing.length)) return undefined;
  if (value.status === "needs_input" && (!summary || !missing.length || evidence.length)) return undefined;
  if ((value.status === "budget_exhausted" || value.status === "incomplete" || value.status === "cancelled") && (summary || evidence.length || missing.length)) return undefined;
  return { status: value.status, summary, evidence, missing, plan, budget };
}

export function validateAgentRunBudget(value: unknown): AgentRunBudget | undefined {
  if (!isRecord(value) || !isAgentEffortLevel(value.level)) return undefined;
  if (!isBudgetLimit(value.maxTurns) || !isBudgetLimit(value.maxTokens)) return undefined;
  const unlimited = AGENT_EFFORT_PROFILES[value.level].coverage === null;
  if (unlimited !== (value.maxTurns === null) || unlimited !== (value.maxTokens === null)) return undefined;
  return { level: value.level, maxTurns: value.maxTurns, maxTokens: value.maxTokens };
}

/** Sizes a run budget at the level's coverage quantile of recent finished runs, falling back to the prior. */
export function estimateAgentRunBudget(level: AgentEffortLevel, samples: readonly AgentUsageSample[]): AgentRunBudget {
  const coverage = AGENT_EFFORT_PROFILES[level].coverage;
  if (coverage === null) return { level, maxTurns: null, maxTokens: null };
  const recent = samples.slice(-AGENT_BUDGET_WINDOW);
  const metric = (key: "turns" | "tokens"): number => {
    const prior = AGENT_BUDGET_PRIOR[key];
    const priorQuantile = prior.median * Math.exp(prior.logSigma * inverseNormal(coverage));
    if (recent.filter((sample) => !sample.censored).length < AGENT_BUDGET_MIN_SAMPLES) return Math.max(AGENT_BUDGET_FLOOR[key], Math.ceil(priorQuantile));
    const empirical = survivalQuantile(recent.map((sample) => ({ value: sample[key], event: !sample.censored })), coverage)
      ?? Math.max(priorQuantile, ...recent.map((sample) => sample[key]));
    return Math.max(AGENT_BUDGET_FLOOR[key], Math.ceil(empirical));
  };
  return { level, maxTurns: metric("turns"), maxTokens: metric("tokens") };
}

/** Kaplan–Meier quantile under right censoring; `undefined` when censoring hides the requested quantile. */
function survivalQuantile(observations: Array<{ value: number; event: boolean }>, quantile: number): number | undefined {
  const sorted = [...observations].sort((left, right) => left.value - right.value || Number(right.event) - Number(left.event));
  let atRisk = sorted.length;
  let survival = 1;
  for (let index = 0; index < sorted.length;) {
    const value = sorted[index].value;
    let events = 0;
    let leaving = 0;
    while (index < sorted.length && sorted[index].value === value) {
      if (sorted[index].event) events++;
      leaving++;
      index++;
    }
    if (events) survival *= 1 - events / atRisk;
    if (1 - survival >= quantile) return value;
    atRisk -= leaving;
  }
  return undefined;
}

/** Acklam's rational approximation of the standard normal quantile. */
function inverseNormal(probability: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (probability > 1 - low) return -inverseNormal(1 - probability);
  const q = probability - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function validateAgentBudgetUsage(value: unknown): AgentBudgetUsage | undefined {
  const budget = validateAgentRunBudget(value);
  if (!budget || !isRecord(value) || !isCount(value.turns) || !isCount(value.tokens)) return undefined;
  return { ...budget, turns: value.turns, tokens: value.tokens };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isBudgetLimit(value: unknown): value is number | null {
  return value === null || (isCount(value) && value > 0);
}

function validatePluginBackend(value: unknown): PluginBackend | undefined {
  if (!isRecord(value) || !isSafeRelativePath(value.entry)) return undefined;
  return { entry: value.entry };
}

function validatePluginPages(value: unknown): PluginPageContribution[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const pages: PluginPageContribution[] = [];
  for (const page of value) {
    if (!isRecord(page) || !isContributionId(page.id) || !isNonEmptyString(page.title) || !isSafeRelativePath(page.entry)
      || (page.icon !== undefined && !isNonEmptyString(page.icon))) return undefined;
    pages.push({ id: page.id, title: page.title, entry: page.entry, ...(page.icon ? { icon: page.icon } : {}) });
  }
  return hasUniqueIds(pages) ? pages : undefined;
}

function validatePluginActions(value: unknown): PluginActionContribution[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions: PluginActionContribution[] = [];
  for (const action of value) {
    if (!isRecord(action) || !isContributionId(action.id) || !isPluginActionLocation(action.location)
      || !isNonEmptyString(action.title)
      || (action.icon !== undefined && !isNonEmptyString(action.icon))
      || (action.whenCapability !== undefined && !isNonEmptyString(action.whenCapability))) return undefined;
    actions.push({
      id: action.id,
      location: action.location,
      title: action.title,
      ...(action.icon ? { icon: action.icon } : {}),
      ...(action.whenCapability ? { whenCapability: action.whenCapability } : {}),
    });
  }
  return hasUniqueIds(actions) ? actions : undefined;
}

function isVersionRange(value: unknown): value is VersionRange {
  return isRecord(value) && isApiVersion(value.min) && isApiVersion(value.max)
    && compareApiVersions(value.min, value.max) <= 0;
}

function isRpcError(value: unknown): value is RpcError {
  return isRecord(value) && isNonEmptyString(value.code) && isNonEmptyString(value.message)
    && (value.data === undefined || isJsonValue(value.data));
}

function isPluginPermission(value: unknown): value is PluginPermission {
  return typeof value === "string" && permittedPermissions.has(value as PluginPermission);
}

function isPluginPermissions(value: unknown): value is PluginPermissions {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([permission, level]) => isPluginPermission(permission) && isPluginPermissionLevel(level));
}

function isPluginPermissionLevel(value: unknown): value is PluginPermissionLevel {
  return value === "none" || value === "optional" || value === "required";
}

function isAgentTodoStatus(value: unknown): value is AgentTodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled";
}

function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return value === "completed" || value === "needs_input" || value === "budget_exhausted" || value === "incomplete" || value === "cancelled";
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= maxLength ? text : undefined;
}

function boundedTextList(values: unknown[], maxLength: number): string[] | undefined {
  const texts = values.map((value) => boundedText(value, maxLength));
  return texts.every((text) => text !== undefined) ? texts as string[] : undefined;
}

function isPluginActionLocation(value: unknown): value is PluginActionLocation {
  return typeof value === "string" && permittedActions.has(value as PluginActionLocation);
}

function isPluginIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifierPattern.test(value);
}

function isContributionId(value: unknown): value is string {
  return typeof value === "string" && contributionIdPattern.test(value);
}

function isSafeRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.startsWith("\\")
    && !value.includes("\\") && !value.split("/").includes("..");
}

function hasUniqueIds(items: Array<{ id: string }>): boolean {
  return new Set(items.map((item) => item.id)).size === items.length;
}

function isApiVersion(value: unknown): value is ApiVersion {
  return typeof value === "string" && parseApiVersion(value) !== undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}
