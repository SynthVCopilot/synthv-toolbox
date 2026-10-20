import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createCreativeService } from "../src/PiDesktop.Tauri/dist/electron/services/creative-service.js";

const root = await mkdtemp(join(tmpdir(), "creative-service-"));
const service = createCreativeService(join(root, "data"), async (command) => {
  if (command === "run_project_probe") return { kind: "project-probe", summary: "Inspected saved project.", data: { tracks: 1 } };
  throw new Error("Component failed");
});
try {
  const project = await service.invoke("create_lyric_project", { title: "Song", draft: "line", sections: [], rhymeTargets: {}, candidateHistory: [] });
  await service.invoke("save_lyric_project", { id: project.id, title: "Song", draft: "next" });
  assert.equal((await service.invoke("restore_lyric_project_version", { id: project.id, revision: 1 })).draft, "line");
  const source = join(root, "song.svp");
  await writeFile(source, JSON.stringify({ tracks: [] }));
  const original = await readFile(source);
  const result = await service.invoke("run_project_probe", { projectPath: source });
  assert.equal(result.summary, "Inspected saved project.");
  assert.equal(result.status, undefined, "synchronous workflows must return a result, not a queued task");
  const [history] = await service.invoke("list_creative_history", {});
  assert.equal(history.result.tracks, 1);
  assert.ok(!Number.isNaN(Date.parse(history.createdAtUtc)));
  const [checkpoint] = await service.invoke("list_project_checkpoints", {});
  assert.equal(checkpoint.sourceSize, original.length);
  assert.match(checkpoint.sourceSha256, /^[a-f0-9]{64}$/);
  await assert.rejects(service.invoke("restore_project_checkpoint", { id: checkpoint.id, outputName: "song.svp" }), /exist/i);
  assert.deepEqual(await readFile(source), original);
  const copy = await service.invoke("restore_project_checkpoint", { id: checkpoint.id, outputName: "copy.svp" });
  assert.deepEqual(await readFile(copy.detail), original);
  await assert.rejects(service.invoke("restore_project_checkpoint", { id: checkpoint.id, outputName: "../outside.svp" }), /filename/);
  await writeFile(checkpoint.snapshotPath, "changed");
  await assert.rejects(service.invoke("restore_project_checkpoint", { id: checkpoint.id, outputName: "bad.svp" }), /integrity/);
  const report = await service.invoke("export_workflow_report", { kind: result.kind, summary: result.summary, data: result.data, format: "markdown" });
  assert.match(report.detail, /\.md$/);
  assert.match(await readFile(report.detail, "utf8"), /"tracks": 1/);
  await assert.rejects(service.invoke("run_audio_probe", {}), /Component failed/);
  assert.equal((await service.invoke("list_creative_history", {})).length, 1, "failed execution cannot append success history");
  await assert.rejects(service.invoke("learn_tuning_profile", { voiceName: "Voice" }), /not available/);
  const batch = await service.invoke("run_batch_workflow", { recipeId: "project-probe", inputPaths: [source, join(root, "missing.svp")], options: {} });
  assert.equal(batch.completed, 1); assert.equal(batch.failed, 1);
  if (process.platform !== "win32") {
    const outside = join(root, "outside");
    await symlink(outside, join(root, "data", "reports", "escaped"));
    await assert.rejects(service.invoke("create_project_checkpoint", { projectPath: "relative.svp" }), /absolute/);
  }
  console.log("Creative result, history, checkpoint integrity, no-overwrite and batch contracts passed.");
} finally { service.dispose(); await rm(root, { recursive: true, force: true }); }

// Project backups belong to the SynthV integration: while it is off, the background timer leaves tracked projects alone.
{
  const backupRoot = await mkdtemp(join(tmpdir(), "creative-backups-"));
  let enabled = true;
  const paused = createCreativeService(join(backupRoot, "data"), async () => ({ kind: "project-probe", summary: "ok", data: {} }), undefined, undefined, { backupsEnabled: () => enabled, backupIntervalMs: 50 });
  try {
    const song = join(backupRoot, "song.svp");
    await writeFile(song, JSON.stringify({ version: 1 }));
    await paused.invoke("run_project_probe", { projectPath: song });
    const count = async () => (await paused.invoke("list_project_checkpoints", {})).length;
    const tracked = await count();
    enabled = false;
    await delay(150); // a backup already under way finishes first
    await writeFile(song, JSON.stringify({ version: 2 }));
    await delay(400);
    assert.equal(await count(), tracked, "no background backup while SynthV is off");
    enabled = true;
    for (let waited = 0; await count() === tracked && waited < 3_000; waited += 50) await delay(50);
    assert.equal(await count(), tracked + 1, "backups resume when it is back on");
    console.log("Background project backups pause while SynthV is off.");
  } finally { paused.dispose(); await rm(backupRoot, { recursive: true, force: true }); }
}
