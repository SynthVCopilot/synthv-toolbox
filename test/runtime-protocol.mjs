import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

function mulberry32(seed) {
  return function next() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededNormal(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Standard normal CDF via the Abramowitz & Stegun 7.1.26 erf approximation, independent of the runtime's own. */
function standardNormalCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const magnitude = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * magnitude);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = sign * (1 - poly * Math.exp(-magnitude * magnitude));
  return 0.5 * (1 + erf);
}

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

test("run budgets equal the prior at each level's own sigma when no runs exist", () => {
  const budgets = protocol.AGENT_EFFORT_LEVELS.map((level) => protocol.estimateAgentRunBudget(level, []));
  assert.deepEqual(budgets[3], { level: "max", maxTurns: null, maxTokens: null });
  assert.deepEqual(budgets.slice(0, 3).map((budget) => budget.maxTurns), [10, 25, 60]);
  assert.deepEqual(budgets.slice(0, 3).map((budget) => budget.maxTokens), [1, 2, 3].map((sigmas) => Math.ceil(60_000 * Math.exp(sigmas))));
  assert.equal(protocol.validateAgentRunBudget({ level: "mid", maxTurns: null, maxTokens: 1000 }), undefined);
  assert.equal(protocol.validateAgentRunBudget({ level: "max", maxTurns: 10, maxTokens: null }), undefined);
  assert.deepEqual(protocol.validateAgentRunBudget({ level: "max", maxTurns: null, maxTokens: null }), { level: "max", maxTurns: null, maxTokens: null });
});

test("fitted budgets converge to the sample's own log-normal mean plus sigma standard deviations", () => {
  const rng = mulberry32(12345);
  const trueMuTurns = Math.log(5), trueSigmaTurns = 0.6;
  const trueMuTokens = Math.log(50_000), trueSigmaTokens = 0.5;
  const samples = Array.from({ length: 5000 }, () => ({
    level: "low",
    turns: Math.exp(trueMuTurns + trueSigmaTurns * seededNormal(rng)),
    tokens: Math.exp(trueMuTokens + trueSigmaTokens * seededNormal(rng)),
    censored: false,
  }));
  const budget = protocol.estimateAgentRunBudget("low", samples);
  const sigmas = protocol.AGENT_EFFORT_PROFILES.low.sigmas;
  const expectedTurns = Math.exp(trueMuTurns + sigmas * trueSigmaTurns);
  const expectedTokens = Math.exp(trueMuTokens + sigmas * trueSigmaTokens);
  assert.ok(Math.abs(budget.maxTurns - expectedTurns) / expectedTurns < 0.1);
  assert.ok(Math.abs(budget.maxTokens - expectedTokens) / expectedTokens < 0.1);
});

test("heavy censoring at the current budget still raises the next Low budget", () => {
  const base = protocol.estimateAgentRunBudget("low", []);
  const samples = [
    ...Array.from({ length: 27 }, () => ({ level: "low", turns: 2, tokens: 20_000, censored: false })),
    ...Array.from({ length: 13 }, () => ({ level: "low", turns: base.maxTurns, tokens: base.maxTokens, censored: true })),
  ];
  assert.ok(samples.filter((sample) => sample.censored).length / samples.length > 0.32);
  const next = protocol.estimateAgentRunBudget("low", samples);
  assert.ok(next.maxTurns > base.maxTurns);
  assert.ok(next.maxTokens > base.maxTokens);
});

test("High stays above the window's sample maximum and stays separate from Mid", () => {
  const rng = mulberry32(777);
  const draw = (n) => Array.from({ length: n }, () => ({
    turns: Math.exp(Math.log(6) + 0.5 * seededNormal(rng)),
    tokens: Math.exp(Math.log(45_000) + 0.45 * seededNormal(rng)),
  }));
  for (const n of [20, 50, 100, 200]) {
    const raw = draw(n);
    const high = protocol.estimateAgentRunBudget("high", raw.map((sample) => ({ level: "high", ...sample, censored: false })));
    const mid = protocol.estimateAgentRunBudget("mid", raw.map((sample) => ({ level: "mid", ...sample, censored: false })));
    const maxTurns = Math.max(...raw.map((sample) => sample.turns));
    const maxTokens = Math.max(...raw.map((sample) => sample.tokens));
    assert.ok(high.maxTurns > maxTurns, `n=${n} turns`);
    assert.ok(high.maxTokens > maxTokens, `n=${n} tokens`);
    assert.notEqual(high.maxTurns, mid.maxTurns, `n=${n}`);
  }
});

test("one extra censored sample at the window maximum does not move High by an order of magnitude", () => {
  const rng = mulberry32(42);
  const raw = Array.from({ length: 100 }, () => ({
    turns: Math.exp(Math.log(6) + 0.5 * seededNormal(rng)),
    tokens: Math.exp(Math.log(45_000) + 0.45 * seededNormal(rng)),
  }));
  const samples = raw.map((sample) => ({ level: "high", ...sample, censored: false }));
  const before = protocol.estimateAgentRunBudget("high", samples);
  const maxTurns = Math.max(...raw.map((sample) => sample.turns));
  const maxTokens = Math.max(...raw.map((sample) => sample.tokens));
  const after = protocol.estimateAgentRunBudget("high", [...samples, { level: "high", turns: maxTurns, tokens: maxTokens, censored: true }]);
  assert.ok(after.maxTurns / before.maxTurns < 2);
  assert.ok(after.maxTokens / before.maxTokens < 2);
});

test("samples from other levels do not change a level's budget", () => {
  const rng = mulberry32(42);
  const midSamples = Array.from({ length: 100 }, () => ({
    level: "mid",
    turns: Math.exp(Math.log(6) + 0.5 * seededNormal(rng)),
    tokens: Math.exp(Math.log(45_000) + 0.45 * seededNormal(rng)),
    censored: false,
  }));
  const before = protocol.estimateAgentRunBudget("mid", midSamples);
  const otherLevels = Array.from({ length: 500 }, () => ({ level: "low", turns: 1000, tokens: 5_000_000, censored: false }));
  const after = protocol.estimateAgentRunBudget("mid", [...midSamples, ...otherLevels]);
  assert.deepEqual(after, before);
});

test("each level's budget covers at least its stated fraction of a correlated joint distribution", () => {
  const rho = 0.7;
  const muTurns = Math.log(6), sigmaTurns = 0.55;
  const muTokens = Math.log(48_000), sigmaTokens = 0.5;
  const correlatedPair = (rng) => {
    const z1 = seededNormal(rng);
    const z2 = seededNormal(rng);
    return [z1, rho * z1 + Math.sqrt(1 - rho * rho) * z2];
  };
  const draw = (rng, n, level) => Array.from({ length: n }, () => {
    const [z1, z2] = correlatedPair(rng);
    return { level, turns: Math.exp(muTurns + sigmaTurns * z1), tokens: Math.exp(muTokens + sigmaTokens * z2), censored: false };
  });
  const fitRng = mulberry32(2024);
  const testRng = mulberry32(99);
  for (const level of ["low", "mid", "high"]) {
    const budget = protocol.estimateAgentRunBudget(level, draw(fitRng, 4000, level));
    const sample = draw(testRng, 50_000, level);
    const covered = sample.filter((run) => run.turns <= budget.maxTurns && run.tokens <= budget.maxTokens).length;
    const coverage = protocol.AGENT_EFFORT_PROFILES[level].coverage;
    assert.ok(covered / sample.length >= coverage - 0.01, `${level}: covered ${covered / sample.length}, want >= ${coverage}`);
  }
});

test("AGENT_EFFORT_PROFILES coverage matches 2*Phi(sigmas)-1 to four decimals", () => {
  for (const level of ["low", "mid", "high"]) {
    const { coverage, sigmas } = protocol.AGENT_EFFORT_PROFILES[level];
    assert.equal(coverage.toFixed(4), (2 * standardNormalCdf(sigmas) - 1).toFixed(4));
  }
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
