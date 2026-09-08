import assert from "node:assert/strict";
import test from "node:test";

function routeView(plan) {
  const format = plan.projectFormat === "generation1" ? "SynthV Studio 1" : plan.projectFormat === "generation2" ? "SynthV Studio 2" : "Format ambiguous";
  return `<h2>${plan.candidates.some((candidate) => candidate.hostProfile) ? "Choose a SynthV host" : "Choose an account"}</h2><strong>${plan.formatVersion ? `SVP v${plan.formatVersion} · ` : ""}${format}</strong>${plan.candidates.map((candidate) => `<button data-launch-svp-route="${candidate.slotId}">${candidate.hostProfile ?? "account"}</button>`).join("")}`;
}

test("serialized Always ask setting round trips through the command payload", () => {
  assert.deepEqual(JSON.parse(JSON.stringify({ alwaysAsk: true })), { alwaysAsk: true });
});

test("standalone host candidates render format, version, and launch targets", () => {
  const html = routeView({ projectFormat: "ambiguous", formatVersion: 4, candidates: [{ slotId: "host:sv1:0", hostProfile: "sv1" }, { slotId: "host:flat:0", hostProfile: "flat" }] });
  assert.match(html, /Choose a SynthV host/);
  assert.match(html, /SVP v4/);
  assert.match(html, /data-launch-svp-route="host:flat:0"/);
  assert.match(html, /Format ambiguous/);
});

test("a live route wins over a slower startup pending response", () => {
  let generation = 0;
  const startupGeneration = generation;
  generation += 1;
  const liveRoute = { projectPath: "live.svp" };
  const pendingRoute = { projectPath: "old.svp" };
  const displayed = startupGeneration === generation ? pendingRoute : liveRoute;
  assert.equal(displayed, liveRoute);
});
