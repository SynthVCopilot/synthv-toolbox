import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const bundleRoot = resolve(import.meta.dirname, "../src/PiDesktop.Tauri/src-tauri");
const base = JSON.parse(readFileSync(resolve(bundleRoot, "tauri.conf.json"), "utf8"));
const macos = JSON.parse(readFileSync(resolve(bundleRoot, "tauri.macos.conf.json"), "utf8"));

test("macOS DMG license uses RTF with the complete original terms", { skip: process.platform !== "darwin" }, () => {
  const license = resolve(bundleRoot, macos.bundle.licenseFile);
  const format = execFileSync("file", ["-b", license], { encoding: "utf8" });
  assert.match(format, /^Rich Text Format data/);
  const decoded = execFileSync("textutil", ["-convert", "txt", "-encoding", "UTF-8", "-stdout", license], { encoding: "utf8" });
  const original = readFileSync(resolve(bundleRoot, base.bundle.licenseFile), "utf8");
  assert.equal(decoded, original);
  assert.match(decoded, /使用条款 \/ Terms of Use/);
});
