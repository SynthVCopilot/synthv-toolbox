import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { ensureDraft, main, promote, requiredAssets } = await import(path.join(root, ".github", "scripts", "release-draft.mjs"));

const temps = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
const workspace = (notes) => {
  const dir = mkdtempSync(path.join(tmpdir(), "toolbox-release-"));
  temps.push(dir);
  if (notes) {
    mkdirSync(path.join(dir, "docs", "releases"), { recursive: true });
    writeFileSync(path.join(dir, "docs", "releases", "v1.2.3.md"), "notes");
  }
  return dir;
};

// A stand-in for the gh CLI that follows the release view/create/edit surface.
function fakeGh({ release = null, createFails = false } = {}) {
  const calls = [];
  let current = release;
  const gh = (args) => {
    calls.push(args);
    const [, command] = args;
    if (args[0] === "release" && command === "view") {
      if (!current) throw new Error("not found");
      return JSON.stringify(current);
    }
    if (args[0] === "release" && command === "create") {
      if (createFails) throw new Error("exists");
      current = { isDraft: true, assets: [] };
      return "";
    }
    if (args[0] === "release" && command === "edit") {
      current = { ...current, isDraft: !args.includes("--draft=false") };
      return "";
    }
    throw new Error("unexpected gh call");
  };
  return { gh, calls, state: () => current };
}

const assets = (names) => names.map((name) => ({ name }));
const env = { INPUT_TAG: "v1.2.3" };

describe("assets required before a release is announced", () => {
  test("cover the Windows installer and update metadata and the macOS image, updater zip and update metadata", () => {
    assert.deepEqual(requiredAssets("1.2.3").sort(), [
      "Synthesizer-V-Toolbox-1.2.3-arm64-mac.zip", "Synthesizer-V-Toolbox-1.2.3-setup.exe", "Synthesizer-V-Toolbox-1.2.3.dmg", "latest-mac.yml", "latest.yml",
    ]);
  });
});

describe("promoting the draft release", () => {
  test("publishes it as the latest release once every asset is present", () => {
    const fake = fakeGh({ release: { isDraft: true, assets: assets(requiredAssets("1.2.3")) } });
    assert.equal(promote({ env, gh: fake.gh, log: () => {} }), "published");
    assert.deepEqual(fake.calls.at(-1), ["release", "edit", "v1.2.3", "--draft=false", "--latest"]);
    assert.equal(fake.state().isDraft, false);
  });

  for (const missing of ["latest.yml", "Synthesizer-V-Toolbox-1.2.3-setup.exe", "latest-mac.yml", "Synthesizer-V-Toolbox-1.2.3.dmg", "Synthesizer-V-Toolbox-1.2.3-arm64-mac.zip"]) {
    test(`keeps the draft while ${missing} is missing`, () => {
      const fake = fakeGh({ release: { isDraft: true, assets: assets(requiredAssets("1.2.3").filter((name) => name !== missing)) } });
      const lines = [];
      assert.equal(promote({ env, gh: fake.gh, log: (line) => lines.push(line) }), "waiting");
      assert.equal(fake.calls.some((call) => call[1] === "edit"), false);
      assert.deepEqual(lines, [`waiting for: ${missing}`]);
    });
  }

  test("leaves an already published release alone", () => {
    const fake = fakeGh({ release: { isDraft: false, assets: [] } });
    assert.equal(promote({ env, gh: fake.gh, log: () => {} }), "published");
    assert.equal(fake.calls.some((call) => call[1] === "edit"), false);
  });

  test("refuses a tag that is not a stable version", () => {
    assert.throws(() => promote({ env: { INPUT_TAG: "v1.2.3-dev.4" }, gh: fakeGh().gh }), { code: "TAG_NOT_STABLE" });
  });
});

describe("creating the draft release", () => {
  test("creates a draft on the existing tag with the release notes", async () => {
    const fake = fakeGh();
    const dir = workspace(true);
    assert.equal(await ensureDraft({ env: { ...env, GITHUB_WORKSPACE: dir }, gh: fake.gh }), "created");
    const create = fake.calls.find((call) => call[1] === "create");
    assert.deepEqual(create.slice(0, 7), ["release", "create", "v1.2.3", "--draft", "--verify-tag", "--title", "v1.2.3"]);
    assert.deepEqual(create.slice(7), ["--notes-file", path.join(dir, "docs", "releases", "v1.2.3.md")]);
  });

  test("falls back to generated notes when the checked out commit has none", async () => {
    const fake = fakeGh();
    await ensureDraft({ env: { ...env, GITHUB_WORKSPACE: workspace(false) }, gh: fake.gh });
    assert.deepEqual(fake.calls.find((call) => call[1] === "create").slice(7), ["--generate-notes"]);
  });

  test("keeps a release another workflow already created", async () => {
    const fake = fakeGh({ release: { isDraft: true, assets: assets(["latest.yml"]) } });
    assert.equal(await ensureDraft({ env, gh: fake.gh }), "exists");
    assert.equal(fake.calls.some((call) => call[1] === "create"), false);
  });

  test("accepts losing the creation race", async () => {
    let views = 0;
    const gh = (args) => {
      if (args[1] === "view") { views += 1; if (views === 1) throw new Error("not found"); return "{}"; }
      throw new Error("exists");
    };
    assert.equal(await ensureDraft({ env, gh }), "exists");
  });

  test("fails when the release can neither be created nor found", async () => {
    await assert.rejects(ensureDraft({ env, gh: () => { throw new Error("down"); } }));
  });
});

describe("command line", () => {
  test("rejects unknown commands and reports failures without details", async () => {
    const errors = [];
    const stderr = { write: (text) => errors.push(text) };
    assert.equal(await main(["delete"], { env, stderr, gh: fakeGh().gh }), 1);
    assert.equal(await main(["promote"], { env, stderr, gh: () => { throw new Error("secret detail"); } }), 1);
    assert.equal(errors.join(""), "INVALID_COMMAND\nRELEASE_FAILED\n");
  });
});
