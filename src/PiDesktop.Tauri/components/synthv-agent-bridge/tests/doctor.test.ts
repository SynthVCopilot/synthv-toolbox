import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  SERVER_BUILD_FINGERPRINT,
  SERVER_CAPABILITY_FINGERPRINT,
} from "../src/build-info.js";

const componentBuildIdentity = await import(
  new URL("../../scripts/component-build-identity.mjs", import.meta.url).href,
);

type DoctorCheck = {
  readonly name: string;
  readonly status: "ok" | "warning" | "error";
};

function runDoctor(
  ipcDirectory: string,
  target?: string,
  host: "core" | "profiles" | "all" = "core",
): {
  readonly status: number | null;
  readonly checks: DoctorCheck[];
} {
  const result = spawnSync(
    process.execPath,
    [
      path.resolve("scripts", "doctor.mjs"),
      "--json",
      "--host",
      host,
      ...(target === undefined ? [] : ["--target", target]),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        SYNTHV_AGENT_BRIDGE_DIR: ipcDirectory,
      },
    },
  );
  assert.equal(result.error, undefined);
  assert.notEqual(result.stdout, "");
  const parsed = JSON.parse(result.stdout) as { checks: DoctorCheck[] };
  return { status: result.status, checks: parsed.checks };
}

function check(
  checks: readonly DoctorCheck[],
  name: string,
): DoctorCheck {
  const result = checks.find((candidate) => candidate.name === name);
  assert.ok(result, `missing doctor check ${name}`);
  return result;
}

test("doctor accepts a fresh MCP capability fingerprint", async () => {
  const ipcDirectory = await mkdtemp(
    path.join(os.tmpdir(), "synthv-doctor-current-"),
  );
  try {
    await writeFile(
      path.join(
        ipcDirectory,
        "synthv-agent-bridge.sidebar.client-status.txt",
      ),
      [
        "synthv-agent-bridge-sidebar-client-status-v1",
        "state=running",
        "version=0.3.1",
        `buildFingerprint=${SERVER_BUILD_FINGERPRINT}`,
        `capabilityFingerprint=${SERVER_CAPABILITY_FINGERPRINT}`,
        `updatedAtEpochMs=${Date.now()}`,
        `ipcDirectory=${ipcDirectory}`,
        "",
      ].join("\n"),
      "utf8",
    );

    const result = runDoctor(ipcDirectory);
    assert.equal(result.status, 0);
    assert.equal(check(result.checks, "mcp-build").status, "ok");
    assert.equal(check(result.checks, "mcp-capabilities").status, "ok");
    assert.equal(
      result.checks.some((candidate) => candidate.name.includes("project-config")),
      false,
    );
  } finally {
    await rm(ipcDirectory, { recursive: true, force: true });
  }
});

// Profiles are routinely emptied in a working tree to stop a client from
// auto-launching a stale build. That local state once made this test look like
// a real regression (docs/issue-8-fix-and-verification-2026-08-11.zh-CN.md), so
// locally modified profiles are reported and skipped instead of asserted. CI
// checks out clean, so nothing is skipped there.
function locallyModifiedPaths(): ReadonlySet<string> {
  const result = spawnSync("git", ["diff", "--name-only", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return new Set();
  }
  return new Set(
    result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );
}

test("doctor discovers and validates every committed project profile", async () => {
  const ipcDirectory = await mkdtemp(
    path.join(os.tmpdir(), "synthv-doctor-host-profiles-"),
  );
  try {
    const result = runDoctor(ipcDirectory, undefined, "all");
    const profiles = result.checks.filter((candidate) =>
      candidate.name.startsWith("project-profile:"),
    );
    assert.ok(
      profiles.length > 0,
      "doctor discovered no project profiles at all",
    );

    const modified = locallyModifiedPaths();
    let asserted = 0;
    for (const profile of profiles) {
      const profilePath = profile.name.slice("project-profile:".length);
      if (modified.has(profilePath)) {
        console.log(`skipping locally modified profile ${profilePath}`);
        continue;
      }
      assert.equal(
        profile.status,
        "ok",
        `${profile.name} does not launch the canonical entry point`,
      );
      asserted += 1;
    }
    assert.ok(
      asserted > 0 || modified.size > 0,
      "no project profile could be validated",
    );
  } finally {
    await rm(ipcDirectory, { recursive: true, force: true });
  }
});

test("doctor keeps project profiles out of the default core run", async () => {
  const ipcDirectory = await mkdtemp(
    path.join(os.tmpdir(), "synthv-doctor-core-only-"),
  );
  try {
    const result = runDoctor(ipcDirectory);
    assert.equal(
      result.checks.some((candidate) =>
        candidate.name.startsWith("project-profile:"),
      ),
      false,
    );
  } finally {
    await rm(ipcDirectory, { recursive: true, force: true });
  }
});

test("doctor rejects a fresh MCP process from a different build", async () => {
  const ipcDirectory = await mkdtemp(
    path.join(os.tmpdir(), "synthv-doctor-stale-"),
  );
  try {
    await writeFile(
      path.join(
        ipcDirectory,
        "synthv-agent-bridge.sidebar.client-status.txt",
      ),
      [
        "synthv-agent-bridge-sidebar-client-status-v1",
        "state=running",
        "version=0.3.1",
        "buildFingerprint=stale-build",
        "capabilityFingerprint=stale-build",
        `updatedAtEpochMs=${Date.now()}`,
        `ipcDirectory=${ipcDirectory}`,
        "",
      ].join("\n"),
      "utf8",
    );

    const result = runDoctor(ipcDirectory);
    assert.equal(result.status, 1);
    assert.equal(check(result.checks, "mcp-capabilities").status, "error");
  } finally {
    await rm(ipcDirectory, { recursive: true, force: true });
  }
});

test(
  "doctor accepts installed scripts prepared with component build identities",
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "synthv-doctor-installed-"),
    );
    try {
      const target = path.join(directory, "scripts");
      const installedDirectory = path.join(target, "SynthV Agent Bridge");
      await mkdir(installedDirectory, { recursive: true });
      const identity =
        await componentBuildIdentity.readComponentBuildIdentity(process.cwd());
      await Promise.all([
        writeFile(
          path.join(installedDirectory, "SynthVAgentBridge.lua"),
          identity.prepareExecutorSource(),
          "utf8",
        ),
        writeFile(
          path.join(installedDirectory, "SynthVAgentSidebar.lua"),
          identity.prepareSidebarSource(),
          "utf8",
        ),
      ]);

      const result = runDoctor(directory, target);
      assert.equal(result.status, 0);
      assert.equal(check(result.checks, "installed-scripts").status, "ok");
      assert.equal(check(result.checks, "optional-sidebar").status, "ok");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
