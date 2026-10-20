// The data folder moves from its pre-Toneshuttle name ("synthv-toolbox") to "Toneshuttle" on the first start of the
// renamed build. These tests run the real rename against temporary folders, including a held file on Windows.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MIGRATION_MARKER, relocatePath, resolveUserDataDirectory } from "../src/PiDesktop.Tauri/dist/electron/services/user-data-migration.js";

const JOB = "3f2b8f6e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

function sandbox(t) {
  const appData = mkdtempSync(join(tmpdir(), "toneshuttle-migration-"));
  t.after(() => rmSync(appData, { recursive: true, force: true }));
  return { appData, legacy: join(appData, "synthv-toolbox"), target: join(appData, "Toneshuttle") };
}

function options(appData, overrides = {}) {
  return { appData, name: "Toneshuttle", legacyNames: ["synthv-toolbox"], migrate: true, appVersion: "9.9.9", sleep: () => {}, ...overrides };
}

function write(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

/** A legacy folder shaped like a real one: Chromium state, the sealed credential key and records that store absolute paths. */
function seedLegacy(legacy) {
  write(join(legacy, "desktop-settings.json"), { mode: "ai", mcpServers: [{ name: "local", command: "node", args: [join(legacy, "tools", "server.js")], cwd: join(legacy, "tools"), env: { HOME: "C:\\Users\\me" } }] });
  write(join(legacy, "ai", "credentials.key"), Buffer.alloc(32, 7).toString("base64"));
  write(join(legacy, "ai", "metadata.json"), { conversations: [{ text: `Saved the take to ${join(legacy, "creative", "out.wav")}` }] });
  write(join(legacy, "runtime", "runtime-settings.json"), { httpApiToken: "token-123" });
  write(join(legacy, "Local State"), "{\"os_crypt\":{\"encrypted_key\":\"abc\"}}");
  write(join(legacy, "Local Storage", "leveldb", "000003.log"), "locale=en");
  write(join(legacy, "creative", "cover-jobs", `${JOB}.json`), JSON.stringify({ id: JOB, kind: "cover", imported: { audioPath: join(legacy, "creative", "media", "a", "source.wav") }, request: { audioPath: "D:\\Music\\take.wav" } }));
  write(join(legacy, "creative", "cover-jobs", JOB, "result.json"), { midi: { outputPath: join(legacy, "creative", "cover-jobs", JOB, "notes.mid") } });
  write(join(legacy, "creative", "cover-score", JOB, "state.json"), { accepted: { notesPath: join(legacy, "creative", "cover-score", JOB, "repaired.json") } });
  write(join(legacy, "creative", "creative-history", "entries.json"), [{ outputPath: join(legacy, "creative", "output", "x.mid"), parameters: { input: `${legacy}-other\\x.wav` } }]);
  write(join(legacy, "creative", "project-checkpoints", "entries.json"), [{ snapshotPath: join(legacy, "creative", "project-checkpoints", "1", "song.svp"), sourcePath: "E:\\Songs\\song.svp" }]);
  write(join(legacy, "components", "ffmpeg.json"), { directory: "C:\\Tools\\ffmpeg\\bin" });
}

test("a legacy folder is renamed as a whole and stored paths inside it are rewritten", (t) => {
  const { appData, legacy, target } = sandbox(t);
  seedLegacy(legacy);
  linkSync(join(legacy, "ai", "credentials.key"), join(legacy, "ai", "credentials.link"));
  const key = readFileSync(join(legacy, "ai", "credentials.key"));
  const decision = resolveUserDataDirectory(options(appData, { now: () => new Date("2026-10-18T12:00:00Z") }));
  assert.deepEqual(decision, { path: target, migratedFrom: legacy });
  assert.equal(existsSync(legacy), false, "the old folder is moved, not copied");
  assert.deepEqual(readFileSync(join(target, "ai", "credentials.key")), key, "the credential key moves byte for byte");
  assert.equal(statSync(join(target, "ai", "credentials.key")).nlink, 2, "hard links survive a rename");
  assert.equal(readFileSync(join(target, "Local State"), "utf8"), "{\"os_crypt\":{\"encrypted_key\":\"abc\"}}", "Chromium's cookie key moves with the profile");
  assert.ok(existsSync(join(target, "Local Storage", "leveldb", "000003.log")));

  const job = JSON.parse(readFileSync(join(target, "creative", "cover-jobs", `${JOB}.json`), "utf8"));
  assert.equal(job.imported.audioPath, join(target, "creative", "media", "a", "source.wav"));
  assert.equal(job.request.audioPath, "D:\\Music\\take.wav", "paths outside the data folder are left alone");
  assert.equal(JSON.parse(readFileSync(join(target, "creative", "cover-jobs", JOB, "result.json"), "utf8")).midi.outputPath, join(target, "creative", "cover-jobs", JOB, "notes.mid"));
  assert.equal(JSON.parse(readFileSync(join(target, "creative", "cover-score", JOB, "state.json"), "utf8")).accepted.notesPath, join(target, "creative", "cover-score", JOB, "repaired.json"));
  const history = JSON.parse(readFileSync(join(target, "creative", "creative-history", "entries.json"), "utf8"));
  assert.equal(history[0].outputPath, join(target, "creative", "output", "x.mid"));
  assert.equal(history[0].parameters.input, `${legacy}-other\\x.wav`, "a sibling folder that only shares the prefix is not the data folder");
  assert.equal(JSON.parse(readFileSync(join(target, "creative", "project-checkpoints", "entries.json"), "utf8"))[0].snapshotPath, join(target, "creative", "project-checkpoints", "1", "song.svp"));
  const settings = readFileSync(join(target, "desktop-settings.json"), "utf8");
  assert.match(settings, /\n {2}"mode"/u, "pretty-printed files stay pretty-printed");
  assert.equal(JSON.parse(settings).mcpServers[0].cwd, join(target, "tools"));
  assert.deepEqual(JSON.parse(settings).mcpServers[0].args, [join(target, "tools", "server.js")]);
  assert.equal(JSON.parse(readFileSync(join(target, "ai", "metadata.json"), "utf8")).conversations[0].text, `Saved the take to ${join(legacy, "creative", "out.wav")}`, "conversations are not path records and are never rewritten");

  const marker = JSON.parse(readFileSync(join(target, MIGRATION_MARKER), "utf8"));
  assert.deepEqual(marker, { from: legacy, to: target, at: "2026-10-18T12:00:00.000Z", appVersion: "9.9.9", fixups: "done", attempts: 1 });
  assert.equal(existsSync(join(appData, ".toneshuttle-migration.lock")), false, "the migration lock is released");
  assert.deepEqual(resolveUserDataDirectory(options(appData)), { path: target }, "the next start finds the moved folder and does nothing");
});

test("a fresh machine and a development run never move anything", (t) => {
  const { appData, legacy, target } = sandbox(t);
  assert.deepEqual(resolveUserDataDirectory(options(appData)), { path: target });
  assert.equal(existsSync(target), false, "resolving does not create the folder; Electron does");
  seedLegacy(legacy);
  assert.deepEqual(resolveUserDataDirectory(options(appData, { migrate: false })), { path: legacy }, "an unpackaged run keeps sharing the folder of the installed older build");
  assert.equal(existsSync(target), false);
});

test("a legacy folder without app data is ignored and an existing new folder is never merged", (t) => {
  const { appData, legacy, target } = sandbox(t);
  write(join(legacy, "Local State"), "{}");
  assert.deepEqual(resolveUserDataDirectory(options(appData)), { path: target }, "Chromium files alone are not user data");
  assert.ok(existsSync(join(legacy, "Local State")), "an unrelated legacy folder is left in place");
  seedLegacy(legacy);
  write(join(target, "desktop-settings.json"), { mode: "toolbox" });
  assert.deepEqual(resolveUserDataDirectory(options(appData)), { path: target, legacyRemaining: legacy });
  assert.equal(JSON.parse(readFileSync(join(target, "desktop-settings.json"), "utf8")).mode, "toolbox");
  assert.ok(existsSync(join(legacy, "desktop-settings.json")), "the legacy data is reported, never deleted or merged");
});

test("an empty new folder is replaced and one without app data is set aside before the move", (t) => {
  const { appData, legacy, target } = sandbox(t);
  seedLegacy(legacy);
  mkdirSync(target);
  assert.equal(resolveUserDataDirectory(options(appData)).migratedFrom, legacy);
  assert.equal(readdirSync(appData).length, 1);

  const second = sandbox(t);
  seedLegacy(second.legacy);
  write(join(second.target, "Local State"), "{}");
  const decision = resolveUserDataDirectory(options(second.appData, { now: () => new Date("2026-10-18T12:00:00Z") }));
  assert.equal(decision.migratedFrom, second.legacy);
  assert.equal(decision.setAside, `${second.target}.before-migration-2026-10-18T12-00-00-000Z`, "Settings can say where the old contents went");
  assert.deepEqual(readdirSync(second.appData).sort(), ["Toneshuttle", "Toneshuttle.before-migration-2026-10-18T12-00-00-000Z"]);
  assert.ok(existsSync(join(second.target, "desktop-settings.json")));
});

test("a file held open in the old folder defers the move to the next start", { skip: process.platform !== "win32" && "Windows refuses to rename a folder with open files; other platforms check SingletonLock" }, (t) => {
  const { appData, legacy, target } = sandbox(t);
  seedLegacy(legacy);
  const handle = openSync(join(legacy, "Local State"), "r");
  const delays = [];
  let decision;
  try { decision = resolveUserDataDirectory(options(appData, { sleep: (milliseconds) => delays.push(milliseconds) })); } finally { closeSync(handle); }
  assert.equal(decision.path, legacy, "the old folder stays in use for this launch");
  assert.equal(decision.deferred.reason, "in-use");
  assert.match(decision.deferred.detail, /EPERM|EBUSY|EACCES/u);
  assert.deepEqual(delays, [100, 200, 400, 800], "the rename is retried with backoff while an exiting old version releases its files");
  assert.equal(existsSync(target), false);
  assert.ok(existsSync(join(legacy, "ai", "credentials.key")), "nothing is half moved");
  assert.equal(existsSync(join(legacy, MIGRATION_MARKER)), false, "a move that did not happen leaves no marker behind");
  assert.equal(resolveUserDataDirectory(options(appData)).migratedFrom, legacy, "the next start completes the move");
});

test("a live older instance on macOS or Linux defers the move", (t) => {
  const { appData, legacy } = sandbox(t);
  seedLegacy(legacy);
  try { symlinkSync(`${hostname()}-4242`, join(legacy, "SingletonLock")); } catch (error) { t.skip(`symlinks unavailable: ${error.code}`); return; }
  const alive = resolveUserDataDirectory(options(appData, { platform: "darwin", isProcessAlive: (pid) => pid === 4242 }));
  assert.deepEqual(alive, { path: legacy, deferred: { reason: "running", detail: "An older version is still running (process 4242)." } });
  rmSync(join(legacy, "SingletonLock"));
  symlinkSync("Old-MacBook.local-4242", join(legacy, "SingletonLock"));
  assert.equal(resolveUserDataDirectory(options(appData, { platform: "darwin", isProcessAlive: (pid) => pid === 4242 })).deferred?.reason, "running", "macOS host names change with the network, so a live pid defers whatever the host part says");
  const stale = resolveUserDataDirectory(options(appData, { platform: "darwin", isProcessAlive: () => false }));
  assert.equal(stale.migratedFrom, legacy, "a lock left by a crashed process does not block the move");
});

/** Holds a file the way Chromium holds <userData>\lockfile: read sharing only. */
function holdExclusively(t, file) {
  return new Promise((resolve, reject) => {
    // -Command takes the rest of the line as script text, so the path is embedded as a single-quoted literal.
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$f=[IO.File]::Open('${file.replaceAll("'", "''")}','OpenOrCreate','ReadWrite','Read'); Write-Output ready; Start-Sleep -Seconds 60; $f.Close()`]);
    t.after(() => child.kill());
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`the file holder exited early with ${code}`)));
    child.stdout.on("data", (data) => { if (String(data).includes("ready")) resolve(() => new Promise((done) => { child.once("exit", done); child.kill(); })); });
  });
}

test("a running older instance is found through its lockfile, even when the old folder is a junction", { skip: process.platform !== "win32" && "Windows-only lockfile probe" }, async (t) => {
  const { appData, legacy, target } = sandbox(t);
  const real = join(appData, "real-data");
  seedLegacy(real);
  symlinkSync(real, legacy, "junction");
  const release = await holdExclusively(t, join(legacy, "lockfile"));
  const decision = resolveUserDataDirectory(options(appData));
  await release();
  assert.deepEqual(decision, { path: legacy, deferred: { reason: "running", detail: "An older version is still running." } }, "Windows renames a junction even while files behind it are open, so the lockfile is checked first");
  assert.equal(existsSync(target), false);
  assert.equal(resolveUserDataDirectory(options(appData)).migratedFrom, legacy, "once the old instance has quit, the move goes ahead");
});

test("concurrent starts are serialized, and a lock left by a dead process is broken", (t) => {
  const { appData, legacy, target } = sandbox(t);
  seedLegacy(legacy);
  const lock = join(appData, ".toneshuttle-migration.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), "4242");
  const waits = [];
  const blocked = resolveUserDataDirectory(options(appData, { isProcessAlive: () => true, sleep: (milliseconds) => waits.push(milliseconds) }));
  assert.deepEqual(blocked, { path: legacy, deferred: { reason: "in-use", detail: "Another start of the app is moving the data folder." }, busy: true }, "this start exits instead of opening a folder another start is moving");
  assert.equal(waits.length, 50, "it waits about five seconds for the other start to finish");
  assert.ok(existsSync(join(legacy, "desktop-settings.json")), "nothing moves without the lock");
  const resumed = resolveUserDataDirectory(options(appData, { isProcessAlive: () => false }));
  assert.equal(resumed.migratedFrom, legacy);
  assert.ok(existsSync(join(target, "desktop-settings.json")));
  assert.equal(existsSync(lock), false);
});

test("fix-ups that fail because a record is held open are retried on later starts", { skip: process.platform !== "win32" && "only Windows refuses to replace an open file" }, (t) => {
  const { appData, legacy, target } = sandbox(t);
  // The state right after a move: the folder has its new name and the marker it carried says fix-ups are pending.
  seedLegacy(target);
  const record = join(target, "creative", "creative-history", "entries.json");
  write(record, [{ outputPath: join(legacy, "creative", "output", "x.mid") }]);
  write(join(target, MIGRATION_MARKER), { from: legacy, to: target, at: "2026-10-18T12:00:00.000Z", appVersion: "9.9.9", fixups: "pending", attempts: 0 });
  const handle = openSync(record, "r");
  let first;
  try { first = resolveUserDataDirectory(options(appData)); } finally { closeSync(handle); }
  assert.equal(first.path, target);
  assert.match(first.fixupErrors.join("\n"), /entries\.json/u);
  const marker = JSON.parse(readFileSync(join(target, MIGRATION_MARKER), "utf8"));
  assert.equal(marker.fixups, "pending", "a transient failure keeps the fix-ups pending");
  assert.equal(marker.attempts, 1);
  assert.deepEqual(resolveUserDataDirectory(options(appData)), { path: target });
  assert.equal(JSON.parse(readFileSync(record, "utf8"))[0].outputPath, join(target, "creative", "output", "x.mid"));
  assert.equal(JSON.parse(readFileSync(join(target, MIGRATION_MARKER), "utf8")).fixups, "done");
});

test("path fix-ups interrupted by a crash resume on the next start", (t) => {
  const { appData, legacy, target } = sandbox(t);
  seedLegacy(target);
  // seedLegacy wrote paths under `target`; make them look like they still point at the old folder.
  write(join(target, "creative", "creative-history", "entries.json"), [{ outputPath: join(legacy, "creative", "output", "x.mid") }]);
  write(join(target, MIGRATION_MARKER), { from: legacy, to: target, at: "2026-10-18T12:00:00.000Z", appVersion: "9.9.9", fixups: "pending" });
  write(join(target, "creative", "cover-jobs", `${JOB}.json`), "{ not json");
  const decision = resolveUserDataDirectory(options(appData));
  assert.equal(decision.path, target);
  assert.equal(decision.fixupErrors.length, 1);
  assert.match(decision.fixupErrors[0], new RegExp(`cover-jobs.${JOB}\\.json`, "u"), "one unreadable record does not stop the others");
  assert.equal(JSON.parse(readFileSync(join(target, "creative", "creative-history", "entries.json"), "utf8"))[0].outputPath, join(target, "creative", "output", "x.mid"));
  assert.equal(JSON.parse(readFileSync(join(target, MIGRATION_MARKER), "utf8")).fixups, "done", "an unreadable record is a permanent failure and is not retried");
  const later = resolveUserDataDirectory(options(appData));
  assert.deepEqual(later.fixupErrors, decision.fixupErrors, "records that stayed broken are still reported on later starts");
  assert.equal(JSON.parse(readFileSync(join(target, MIGRATION_MARKER), "utf8")).attempts, 1, "finished fix-ups are not repeated");
});

test("stored paths are matched by folder, case-insensitively on Windows only", () => {
  const from = "C:\\Users\\张三\\AppData\\Roaming\\synthv-toolbox", to = "C:\\Users\\张三\\AppData\\Roaming\\Toneshuttle";
  assert.equal(relocatePath(`${from}\\creative\\a.wav`, from, to, "win32"), `${to}\\creative\\a.wav`);
  assert.equal(relocatePath("c:/users/张三/appdata/roaming/SYNTHV-TOOLBOX/creative/a.wav", from, to, "win32"), `${to}/creative/a.wav`);
  assert.equal(relocatePath(from, from, to, "win32"), to);
  assert.equal(relocatePath(`${from}-backup\\a.wav`, from, to, "win32"), undefined);
  assert.equal(relocatePath(`see ${from}\\a.wav`, from, to, "win32"), undefined);
  assert.equal(relocatePath("/Users/me/Library/Application Support/synthv-toolbox/a.wav", "/Users/me/Library/Application Support/synthv-toolbox", "/Users/me/Library/Application Support/Toneshuttle", "darwin"), "/Users/me/Library/Application Support/Toneshuttle/a.wav");
  assert.equal(relocatePath("/Users/me/Library/Application Support/SYNTHV-TOOLBOX/a.wav", "/Users/me/Library/Application Support/synthv-toolbox", "/x", "darwin"), undefined);
});

test("a lock held by a live owner is kept while it works, but not forever", (t) => {
  const { appData, legacy } = sandbox(t);
  seedLegacy(legacy);
  const lock = join(appData, ".toneshuttle-migration.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), "4242");
  // A live owner may still be moving a large profile on a slow disk: its lock is kept past the 30 s used for ownerless locks.
  const minuteAgo = new Date(Date.now() - 60_000);
  utimesSync(lock, minuteAgo, minuteAgo);
  assert.equal(resolveUserDataDirectory(options(appData, { isProcessAlive: () => true })).deferred?.reason, "in-use");
  assert.ok(existsSync(join(legacy, "desktop-settings.json")), "a slow but live migration is never run twice");
  // A pid can be reused, so after ten minutes even a live-looking owner no longer holds the lock.
  const longAgo = new Date(Date.now() - 11 * 60_000);
  utimesSync(lock, longAgo, longAgo);
  assert.equal(resolveUserDataDirectory(options(appData, { isProcessAlive: () => true })).migratedFrom, legacy);
});
