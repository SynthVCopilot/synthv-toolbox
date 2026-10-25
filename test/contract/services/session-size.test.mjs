import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { SESSION_OFFLINE_THRESHOLD_BYTES, inspectSessionSize, SynthVService } = await import(new URL("../../../src/PiDesktop.Tauri/electron/services/synthv-service.ts", import.meta.url));
const { registerSynthVCommands } = await import(new URL("../../../src/PiDesktop.Tauri/electron/services/synthv-commands.ts", import.meta.url));
const noBridge = { status: async () => ({ connected: false }), requestStop: async () => {} };

test("session-size boundary is online at 4096 bytes and offline above it", async () => {
  assert.equal(SESSION_OFFLINE_THRESHOLD_BYTES, 4096);
  const root = await mkdtemp(join(tmpdir(), "session-size-boundary-"));
  try {
    const atThreshold = join(root, "4096.session");
    const aboveThreshold = join(root, "4097.session");
    await writeFile(atThreshold, Buffer.alloc(4096));
    await writeFile(aboveThreshold, Buffer.alloc(4097));
    assert.deepEqual(await inspectSessionSize(atThreshold), { status: "online", sizeBytes: 4096 });
    assert.deepEqual(await inspectSessionSize(aboveThreshold), { status: "offline", sizeBytes: 4097 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("session-size reports unknown for missing paths and directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-size-unknown-"));
  try {
    assert.deepEqual(await inspectSessionSize(join(root, "missing")), { status: "unknown", sizeBytes: null });
    const directory = join(root, "directory");
    await mkdir(directory);
    assert.deepEqual(await inspectSessionSize(directory), { status: "unknown", sizeBytes: null });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("session-size reads metadata for a regular file without requiring content access", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-size-metadata-"));
  try {
    const file = join(root, "unreadable.session");
    await writeFile(file, "arbitrary session bytes");
    await chmod(file, 0);
    assert.deepEqual(await inspectSessionSize(file), { status: "online", sizeBytes: 23 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("profile state and profile-state IPC include per-slot session-size metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-size-profile-"));
  try {
    const service = new SynthVService(root, root, noBridge, root, async () => ({ stdout: "", stderr: "", code: 0 }), undefined, root);
    const created = await service.createProfile("Primary");
    const slotId = created.slots[0].id;
    const session = join(created.slots[0].dataPath, "license", "session");
    await mkdir(join(created.slots[0].dataPath, "license"), { recursive: true });
    await writeFile(session, Buffer.alloc(4097));
    const state = await service.profileState();
    assert.deepEqual(state.slots[0].sessionSize, { status: "offline", sizeBytes: 4097 });

    const handlers = new Map();
    registerSynthVCommands({ register: (name, handler) => handlers.set(name, handler) }, service);
    const ipcState = await handlers.get("sv2_profile_state")({});
    assert.deepEqual(ipcState.slots[0].sessionSize, { status: "offline", sizeBytes: 4097 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("active slots inspect the live official session rather than the saved slot copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-size-active-"));
  try {
    const service = new SynthVService(root, root, noBridge, root, async () => ({ stdout: "", stderr: "", code: 0 }), undefined, root);
    const created = await service.createProfile("Primary");
    const slot = created.slots[0];
    await mkdir(join(slot.dataPath, "license"), { recursive: true });
    await writeFile(join(slot.dataPath, "license", "session"), Buffer.alloc(4096));
    const activated = await service.activateProfile(slot.id);
    await writeFile(join(activated.canonicalPath, "license", "session"), Buffer.alloc(4097));
    assert.equal((await service.sessionSize(slot.id)).status, "offline");
    assert.equal((await service.profileState()).slots[0].sessionSize.status, "offline");
  } finally { await rm(root, { recursive: true, force: true }); }
});
