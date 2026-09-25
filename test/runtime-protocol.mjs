import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(root, "packages", "runtime-protocol");
const outputDirectory = join(root, "test", ".tmp", "runtime-protocol");
const tsc = join(root, "src", "PiDesktop.Tauri", "node_modules", "typescript", "bin", "tsc");

if (!existsSync(tsc)) throw new Error("TypeScript compiler is unavailable. Install frontend dependencies before running this test.");
rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });
execFileSync(process.execPath, [tsc, "-p", join(packageRoot, "tsconfig.json"), "--outDir", outputDirectory], { stdio: "inherit" });
writeFileSync(join(outputDirectory, "package.json"), '{"type":"module"}\n');
const protocol = await import(`${pathToFileURL(join(outputDirectory, "index.js")).href}?contract=${Date.now()}`);

test("negotiates the highest protocol version in the shared range", () => {
  assert.equal(
    protocol.negotiateProtocolVersion({ min: "1.0", max: "1.3" }, { min: "1.2", max: "2.0" }),
    "1.3",
  );
  assert.equal(
    protocol.negotiateProtocolVersion({ min: "1.0", max: "1.1" }, { min: "1.2", max: "1.3" }),
    undefined,
  );
});

test("round trips a single JSONL request and rejects multiple lines", () => {
  const request = {
    kind: "request",
    id: "host-1",
    protocolVersion: "1.0",
    method: protocol.RUNTIME_HELLO_METHOD,
    params: { runtimeId: "pi", protocol: { min: "1.0", max: "1.0" } },
  };
  const line = protocol.encodeJsonl(request);
  assert.equal(line.endsWith("\n"), true);
  assert.deepEqual(protocol.parseJsonl(line.trimEnd()), request);
  assert.throws(() => protocol.parseJsonl(`${line}${line}`), /exactly one line/);
});

test("accepts a GUI-capable plugin manifest only when its contributions are safe", () => {
  const manifest = {
    schemaVersion: 1,
    id: "com.example.auto-tune",
    name: "Auto Tune",
    version: "1.2.3",
    hostApi: { min: "1.0", max: "1.1" },
    backend: { entry: "backend/index.js" },
    pages: [{ id: "workbench", title: "Tune Workbench", entry: "ui/index.html" }],
    actions: [{ id: "run", location: "project.toolbar", title: "Auto tune", whenCapability: "project.edit" }],
    permissions: { "agent.tools": "optional", "project.read": "required", "project.write": "required" },
  };
  const validated = protocol.validatePluginManifest(manifest);
  assert.deepEqual(validated, manifest);
  assert.equal(protocol.isHostApiCompatible(validated), true);
  assert.equal(protocol.validatePluginManifest({ ...manifest, pages: [{ ...manifest.pages[0], entry: "../ui/index.html" }] }), undefined);
  assert.equal(protocol.validatePluginManifest({ ...manifest, permissions: { "host.root": "required" } }), undefined);
  assert.equal(protocol.validatePluginManifest({ ...manifest, permissions: ["project.read"] }), undefined);
  assert.equal(protocol.pluginPermissionLevel(validated, "project.read"), "required");
  assert.equal(protocol.pluginPermissionLevel(validated, "host.execute"), "none");
});

test("recognizes explicit privileged plugin permissions", () => {
  const manifest = {
    schemaVersion: 1,
    id: "com.example.privileged",
    name: "Privileged plugin",
    version: "1.0.0",
    hostApi: { min: "1.0", max: "1.0" },
    permissions: { "host.internal": "required", "host.advanced": "optional" },
  };
  assert.deepEqual(protocol.validatePluginManifest(manifest), manifest);
  assert.equal(protocol.validatePluginManifest({ ...manifest, permissions: { "host.internal": "elevated" } }), undefined);
});

test("normalizes omitted permissions to none and preserves explicit none", () => {
  const manifest = {
    schemaVersion: 1,
    id: "com.example.no-permissions",
    name: "No permissions",
    version: "1.0.0",
    hostApi: { min: "1.0", max: "1.0" },
  };
  const validated = protocol.validatePluginManifest(manifest);
  assert.deepEqual(validated.permissions, {});
  assert.equal(protocol.pluginPermissionLevel(validated, "project.read"), "none");
  const explicit = protocol.validatePluginManifest({ ...manifest, permissions: { "project.read": "none" } });
  assert.equal(protocol.pluginPermissionLevel(explicit, "project.read"), "none");
});

const coverPlan = {
  goal: " Produce a SynthV cover of the requested song ",
  doneCriteria: ["Vocal stem separated", "Project imported into SynthV"],
  todos: [
    { id: "1", title: "Find the source audio", status: "completed" },
    { id: "2", title: "Separate vocals and instrumental", status: "in_progress", note: "Round 1" },
    { id: "3", title: "Tune parameters", status: "pending" },
  ],
};
const budget = { level: "mid", turns: 3, tokens: 12000, maxTurns: 19, maxTokens: 325_542 };

test("accepts a trimmed agent plan and reports why an invalid plan is rejected", () => {
  const checked = protocol.checkAgentPlan(coverPlan);
  assert.equal(checked.plan.goal, "Produce a SynthV cover of the requested song");
  assert.equal(checked.plan.todos[1].note, "Round 1");
  assert.match(protocol.checkAgentPlan({ ...coverPlan, doneCriteria: [] }).error, /doneCriteria/);
  assert.match(protocol.checkAgentPlan({ ...coverPlan, todos: [...coverPlan.todos, { id: "1", title: "Again", status: "pending" }] }).error, /unique/);
  assert.match(protocol.checkAgentPlan({ ...coverPlan, todos: coverPlan.todos.map((todo) => ({ ...todo, status: "in_progress" })) }).error, /in_progress/);
  assert.match(protocol.checkAgentPlan({ ...coverPlan, todos: [{ id: "1", title: "Step", status: "done" }] }).error, /invalid status/);
  assert.equal(protocol.validateAgentPlan({ ...coverPlan, goal: "" }), undefined);
});

test("effort levels widen coverage, thinking and compaction as the budget grows", () => {
  assert.deepEqual(protocol.AGENT_EFFORT_LEVELS, ["low", "mid", "high", "max"]);
  assert.equal(protocol.DEFAULT_AGENT_EFFORT, "mid");
  assert.equal(protocol.isAgentEffortLevel("medium"), false);
  const profiles = protocol.AGENT_EFFORT_LEVELS.map((level) => protocol.AGENT_EFFORT_PROFILES[level]);
  assert.deepEqual(profiles.map((profile) => profile.coverage), [0.6827, 0.9545, 0.9973, null]);
  assert.deepEqual(profiles.map((profile) => profile.thinking), ["low", "medium", "high", "xhigh"]);
  for (let index = 1; index < profiles.length; index++) {
    assert.ok(profiles[index].keepRecentTokens > profiles[index - 1].keepRecentTokens);
    assert.ok(profiles[index].maxIdleContinuations > profiles[index - 1].maxIdleContinuations);
  }
  assert.deepEqual(profiles.map((profile) => profile.compactionTrigger), [0.5, 0.7, 0.85, null]);
});

test("run budgets use the log-normal prior until enough finished runs exist", () => {
  const budgets = protocol.AGENT_EFFORT_LEVELS.map((level) => protocol.estimateAgentRunBudget(level, []));
  assert.deepEqual(budgets[3], { level: "max", maxTurns: null, maxTokens: null });
  assert.deepEqual(budgets.slice(0, 3).map((budget) => budget.maxTurns), [7, 19, 49]);
  assert.deepEqual(budgets.slice(0, 3).map((budget) => Math.round(budget.maxTokens / 1000)), [97, 325, 969]);
  const few = Array.from({ length: protocol.AGENT_BUDGET_MIN_SAMPLES - 1 }, () => ({ turns: 1, tokens: 1000, censored: false }));
  assert.deepEqual(protocol.estimateAgentRunBudget("mid", few), budgets[1]);
});

test("run budgets follow the empirical coverage quantile and account for censored runs", () => {
  const finished = Array.from({ length: 100 }, (_, index) => ({ turns: index + 1, tokens: (index + 1) * 10_000, censored: false }));
  assert.deepEqual(protocol.estimateAgentRunBudget("low", finished), { level: "low", maxTurns: 69, maxTokens: 690_000 });
  assert.deepEqual(protocol.estimateAgentRunBudget("mid", finished), { level: "mid", maxTurns: 96, maxTokens: 960_000 });
  assert.deepEqual(protocol.estimateAgentRunBudget("high", finished), { level: "high", maxTurns: 100, maxTokens: 1_000_000 });

  const small = Array.from({ length: 40 }, () => ({ turns: 1, tokens: 1000, censored: false }));
  assert.deepEqual(protocol.estimateAgentRunBudget("mid", small), { level: "mid", maxTurns: protocol.AGENT_BUDGET_FLOOR.turns, maxTokens: protocol.AGENT_BUDGET_FLOOR.tokens });

  const censored = [...Array.from({ length: 30 }, () => ({ turns: 3, tokens: 30_000, censored: false })), ...Array.from({ length: 70 }, () => ({ turns: 8, tokens: 90_000, censored: true }))];
  const naive = protocol.estimateAgentRunBudget("mid", censored.map((sample) => ({ ...sample, censored: false })));
  const corrected = protocol.estimateAgentRunBudget("mid", censored);
  assert.ok(corrected.maxTurns >= 19 && corrected.maxTurns > naive.maxTurns);
  assert.equal(protocol.validateAgentRunBudget({ level: "mid", maxTurns: null, maxTokens: 1000 }), undefined);
  assert.equal(protocol.validateAgentRunBudget({ level: "max", maxTurns: 10, maxTokens: null }), undefined);
  assert.deepEqual(protocol.validateAgentRunBudget({ level: "max", maxTurns: null, maxTokens: null }), { level: "max", maxTurns: null, maxTokens: null });
});

test("run outcomes carry the evidence, missing information and budget their status requires", () => {
  const plan = protocol.validateAgentPlan(coverPlan);
  const completed = { status: "completed", summary: "Cover ready", evidence: ["vocals.wav written", "Track 1 imported"], missing: [], plan, budget };
  assert.deepEqual(protocol.validateAgentRunOutcome(completed), completed);
  assert.equal(protocol.validateAgentRunOutcome({ ...completed, evidence: ["only one"] }), undefined);
  assert.equal(protocol.validateAgentRunOutcome({ ...completed, plan: null }), undefined);
  assert.equal(protocol.validateAgentRunOutcome({ ...completed, summary: " " }), undefined);

  const needsInput = { status: "needs_input", summary: "Which recording should I use?", evidence: [], missing: ["Source recording"], plan: null, budget };
  assert.deepEqual(protocol.validateAgentRunOutcome(needsInput), needsInput);
  assert.equal(protocol.validateAgentRunOutcome({ ...needsInput, missing: [] }), undefined);

  const exhausted = { status: "budget_exhausted", summary: "", evidence: [], missing: [], plan, budget: { ...budget, turns: 19 } };
  assert.deepEqual(protocol.validateAgentRunOutcome(exhausted), exhausted);
  assert.equal(protocol.validateAgentRunOutcome({ ...exhausted, summary: "Stopped" }), undefined);
  assert.equal(protocol.validateAgentRunOutcome({ ...exhausted, status: "incomplete" }).status, "incomplete");
  assert.equal(protocol.validateAgentRunOutcome({ ...exhausted, budget: { ...budget, level: "medium" } }), undefined);
  assert.equal(protocol.validateAgentRunOutcome({ ...exhausted, budget: { ...budget, turns: -1 } }), undefined);
  const unlimited = { level: "max", maxTurns: null, maxTokens: null, turns: 250, tokens: 9_000_000 };
  assert.deepEqual(protocol.validateAgentRunOutcome({ ...completed, budget: unlimited }).budget, unlimited);
});
