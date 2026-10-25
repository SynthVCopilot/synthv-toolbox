import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCreativeService } from "../../../src/PiDesktop.Tauri/dist/electron/services/creative-service.js";

const request = overrides => ({ language: "zh-CN", brief: "离别的站台", imagery: "月台 信", sectionLabel: "副歌", tone: "", targetRhyme: "", candidateCount: 4, ...overrides });
const reply = candidates => JSON.stringify({ candidates });

async function withService(complete, run) {
  const root = await mkdtemp(join(tmpdir(), "creative-ai-"));
  const service = createCreativeService(join(root, "data"), async () => { throw new Error("no component"); }, undefined, undefined, { complete, backupIntervalMs: 3_600_000 });
  try { await run(service); } finally { service.dispose?.(); await rm(root, { recursive: true, force: true }); }
}

test("candidates keep the requested count, drop duplicates and report the real rhyme foot", async () => {
  const seen = [];
  const lines = ["旧月台还留着未熄的光", "旧月台还留着未熄的光", "风把那封信吹回我身旁", "我把没说完的话装进行囊", "车窗外的故乡越来越长", "雨落在站台上很轻"];
  await withService(async (system, input) => { seen.push({ system, input }); return `好的：${reply(lines.map(text => ({ text, note: "n" })))}`; }, async service => {
    const set = await service.invoke("generate_lyric_candidates", { request: request({ targetRhyme: "ang", candidateCount: 4 }) });
    assert.equal(set.candidates.length, 4);
    assert.deepEqual(set.candidates.map(item => item.text), [lines[0], lines[2], lines[3], lines[4]]);
    assert.deepEqual(set.candidates.map(item => item.rhymeFoot), ["光", "旁", "囊", "长"]);
    assert.ok(set.candidates.every(item => item.rhymeMatched === true));
    assert.equal(set.targetRhyme, "ang");
    assert.equal(set.sectionLabel, "副歌");
    assert.match(seen[0].input, /"candidateCount": 4/);
    assert.match(seen[0].input, /离别的站台/);
  });
});

test("a candidate whose last character does not rhyme with the target is flagged, not silently accepted", async () => {
  await withService(async () => reply([{ text: "旧月台还留着未熄的光", note: "" }, { text: "我们终于在路口说了再见", note: "" }]), async service => {
    const set = await service.invoke("generate_lyric_candidates", { request: request({ targetRhyme: "光", candidateCount: 2 }) });
    assert.deepEqual(set.candidates.map(item => item.rhymeMatched), [true, false]);
  });
});

test("without a target rhyme the match flag is absent and the target is null", async () => {
  await withService(async () => reply([{ text: "第一句", note: "" }, { text: "第二句", note: "" }]), async service => {
    const set = await service.invoke("generate_lyric_candidates", { request: request({ candidateCount: 2 }) });
    assert.equal(set.targetRhyme, null);
    assert.ok(set.candidates.every(item => item.rhymeMatched === null));
  });
});

test("invalid requests are refused before any model call", async () => {
  let calls = 0;
  await withService(async () => { calls++; return reply([]); }, async service => {
    for (const bad of [request({ candidateCount: 1 }), request({ candidateCount: 9 }), request({ brief: " ", imagery: "" }), request({ language: "en" }), request({ targetRhyme: "x".repeat(25) }), request({ targetRhyme: "???" })]) {
      await assert.rejects(service.invoke("generate_lyric_candidates", { request: bad }));
    }
    assert.equal(calls, 0);
  });
});

test("an unusable model reply is an error, not an empty candidate set", async () => {
  for (const response of ["没有 JSON", "{\"candidates\": [", reply([{ text: "只有一条", note: "" }]), reply([{ text: " ", note: "" }, { text: "也只有一条", note: "" }])]) {
    await withService(async () => response, async service => {
      await assert.rejects(service.invoke("generate_lyric_candidates", { request: request() }));
    });
  }
});

test("a cancelled request fails instead of returning candidates", async () => {
  const controller = new AbortController();
  await withService(async () => { controller.abort(); return reply([{ text: "甲", note: "" }, { text: "乙", note: "" }]); }, async service => {
    await assert.rejects(service.invoke("generate_lyric_candidates", { request: request() }, controller.signal));
  });
});

test("the AI refusal of the model path surfaces to the caller", async () => {
  await withService(async () => { throw new Error("The internal agent is only available in AI mode."); }, async service => {
    await assert.rejects(service.invoke("generate_lyric_candidates", { request: request() }), /AI mode/);
    await assert.rejects(service.invoke("review_workflow", { kind: "project-probe", data: {} }), /AI mode/);
  });
  await withService(undefined, async service => {
    await assert.rejects(service.invoke("generate_lyric_candidates", { request: request() }), /unavailable/);
  });
});

test("workflow review sends the structured result and returns the model text", async () => {
  const seen = [];
  await withService(async (system, input) => { seen.push(input); return "结论：可靠。"; }, async service => {
    assert.equal(await service.invoke("review_workflow", { kind: "project-doctor", data: { tracks: 3 } }), "结论：可靠。");
    assert.match(seen[0], /project-doctor/);
    assert.match(seen[0], /"tracks": 3/);
    await assert.rejects(service.invoke("review_workflow", { kind: "shell", data: {} }), /不受支持/);
    await assert.rejects(service.invoke("review_workflow", { kind: "project-probe", data: { blob: "x".repeat(130_000) } }), /过大/);
    assert.equal(seen.length, 1, "refused reviews never reach the model");
  });
});
