import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCreativeRuntime } from "../../../src/PiDesktop.Tauri/electron/services/creative-runtime.ts";

const root = await mkdtemp(path.join(os.tmpdir(), "creative-runtime-test-"));
const originalPython = process.env.SYNTHV_TOOLBOX_PYTHON;

function pythonRelativePath() {
  return process.platform === "win32" ? path.join("Scripts", "python.exe") : path.join("bin", "python");
}

function runtimePrefix(pythonPath) {
  if (pythonPath.includes(`${path.sep}python-runtime${path.sep}`)) return path.dirname(path.dirname(pythonPath));
  return path.join(root, "external-python-prefix");
}

function createRunner({ missingModules = [], stallOnPip = false, failBasePython = false } = {}) {
  const runner = async (file, args, request) => {
    runner.calls.push({ file, args });
    if (request.signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    if (args[0] === "-c" && args[1].includes("sys.version_info")) {
      if (failBasePython && !file.includes("python-runtime")) return { stdout: "", stderr: "not found", code: 1 };
      const prefix = runtimePrefix(file);
      return { stdout: JSON.stringify({ executable: file, version: "3.11.9", major: 3, minor: 11, prefix, basePrefix: path.join(root, "base-python") }), stderr: "", code: 0 };
    }
    if (args[0] === "-c" && args[1].includes("importlib.import_module")) {
      const missing = Object.fromEntries(args.slice(2).filter((module) => missingModules.includes(module)).map((module) => [module, "ModuleNotFoundError: fake missing module"]));
      return { stdout: JSON.stringify({ missing }), stderr: "", code: Object.keys(missing).length ? 2 : 0 };
    }
    if (args[0] === "-m" && args[1] === "venv") {
      const executable = path.join(args[2], pythonRelativePath());
      await mkdir(path.dirname(executable), { recursive: true });
      await writeFile(executable, "fake python executable");
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "-m" && args[1] === "pip") {
      assert.ok(args.includes("--isolated"));
      assert.ok(args.includes("--index-url"));
      assert.equal(args[args.indexOf("--index-url") + 1], "https://pypi.org/simple");
      assert.ok(args.includes("--no-cache-dir"));
      assert.ok(args.includes("yt-dlp==2026.8.19"));
      if (process.platform === "darwin" && process.arch === "arm64") assert.ok(args.includes("mlx-whisper==0.4.3"));
      runner.pipCount += 1;
      request.onOutput?.("stderr", "Collecting dependencies\n");
      if (stallOnPip) {
        await new Promise((resolve, reject) => {
          const onAbort = () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
          if (request.signal?.aborted) onAbort();
          else request.signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      return { stdout: "", stderr: "Successfully installed dependencies", code: 0 };
    }
    throw new Error(`Unexpected process request: ${file} ${args.join(" ")}`);
  };
  runner.calls = [];
  runner.pipCount = 0;
  return runner;
}

async function makeComponents(directory) {
  const componentsRoot = path.join(directory, "components");
  await mkdir(path.join(componentsRoot, "pi-audio"), { recursive: true });
  await mkdir(path.join(componentsRoot, "vocal-separation"), { recursive: true });
  await writeFile(path.join(componentsRoot, "pi-audio", "requirements.txt"), "numpy\nlibrosa\n");
  await writeFile(path.join(componentsRoot, "vocal-separation", "requirements.txt"), "demucs==4.0.1\ntorch==2.7.1\n");
  return componentsRoot;
}

try {
  delete process.env.SYNTHV_TOOLBOX_PYTHON;
  const componentsRoot = await makeComponents(root);
  const managedRoot = path.join(root, "managed-data");
  const runner = createRunner();
  const runtime = createCreativeRuntime({ dataRoot: managedRoot, componentsRoot }, runner);

  const initial = await runtime.status();
  assert.equal(initial.ready, false);
  assert.ok(initial.missing.includes("managed Python runtime"));
  const progress = [];
  const [pythonPath, concurrentPath] = await Promise.all([
    runtime.ensure({ onProgress: (percent, detail) => progress.push({ percent, detail }) }),
    runtime.ensure(),
  ]);
  assert.ok(pythonPath.endsWith(pythonRelativePath()));
  assert.equal(concurrentPath, pythonPath);
  assert.equal(runner.pipCount, 1);
  assert.ok(progress.some((item) => item.detail.includes("Installing")));
  assert.equal(progress.at(-1).percent, 100);

  const ready = await runtime.status();
  assert.equal(ready.ready, true);
  assert.equal(ready.pythonPath, pythonPath);
  assert.deepEqual(ready.missing, []);
  assert.equal((await runtime.ensure()), pythonPath);
  assert.equal(runner.pipCount, 1);
  const runtimeFiles = await readdir(path.join(managedRoot, "python-runtime"));
  assert.ok(runtimeFiles.includes("active.json"));
  assert.ok(runtimeFiles.includes("versions"));

  const mismatchRunner = createRunner({ missingModules: ["cmudict"] });
  const external = createCreativeRuntime({ dataRoot: path.join(root, "external-data"), componentsRoot, pythonCommand: "configured-python" }, mismatchRunner);
  const externalStatus = await external.status();
  assert.equal(externalStatus.ready, false);
  assert.ok(externalStatus.missing.includes("cmudict"));
  await assert.rejects(external.ensure(), /failed module checks/u);
  assert.equal(mismatchRunner.pipCount, 0);
  assert.equal(mismatchRunner.calls.some((call) => call.args[0] === "-m" && call.args[1] === "venv"), false);

  process.env.SYNTHV_TOOLBOX_PYTHON = "configured-python-from-env";
  const envRunner = createRunner({ missingModules: ["torch"] });
  const envRuntime = createCreativeRuntime({ dataRoot: path.join(root, "env-config-data"), componentsRoot }, envRunner);
  const envStatus = await envRuntime.status();
  assert.equal(envStatus.ready, false);
  assert.ok(envStatus.missing.includes("torch"));
  await assert.rejects(envRuntime.ensure(), /failed module checks/u);
  assert.equal(envRunner.pipCount, 0);
  delete process.env.SYNTHV_TOOLBOX_PYTHON;

  const changedComponents = await makeComponents(path.join(root, "changed"));
  const changedRunner = createRunner();
  const changedDataRoot = path.join(root, "changed-data");
  const changedRuntime = createCreativeRuntime({ dataRoot: changedDataRoot, componentsRoot: changedComponents }, changedRunner);
  await changedRuntime.ensure();
  await writeFile(path.join(changedComponents, "pi-audio", "requirements.txt"), "numpy\nlibrosa\n# new runtime input\n");
  assert.equal((await changedRuntime.status()).ready, false);
  await changedRuntime.ensure();
  assert.equal(changedRunner.pipCount, 2);
  assert.equal((await readdir(path.join(changedDataRoot, "python-runtime", "versions"))).length, 2);

  const cancelComponents = await makeComponents(path.join(root, "cancel"));
  const cancelData = path.join(root, "cancel-data");
  const cancelRunner = createRunner({ stallOnPip: true });
  const cancelRuntime = createCreativeRuntime({ dataRoot: cancelData, componentsRoot: cancelComponents }, cancelRunner);
  const controller = new AbortController();
  const preparing = cancelRuntime.ensure({ signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  await assert.rejects(preparing, { name: "AbortError" });
  const cancelRuntimeRoot = path.join(cancelData, "python-runtime");
  assert.equal((await readdir(path.join(cancelRuntimeRoot, "versions"))).length, 0);
  assert.equal((await readdir(cancelRuntimeRoot)).includes("active.json"), false);

  const outside = path.join(root, "outside-runtime");
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "keep.txt"), "preserve");
  const symlinkData = path.join(root, "symlink-data");
  await mkdir(symlinkData, { recursive: true });
  await symlink(outside, path.join(symlinkData, "python-runtime"), process.platform === "win32" ? "junction" : "dir");
  const symlinkRuntime = createCreativeRuntime({ dataRoot: symlinkData, componentsRoot }, createRunner());
  assert.equal((await symlinkRuntime.status()).ready, false);
  await assert.rejects(symlinkRuntime.ensure(), /symbolic link/u);
  assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "preserve");

  const unsafeComponents = await makeComponents(path.join(root, "unsafe-components"));
  const outsideRequirements = path.join(root, "outside-requirements.txt");
  const linkedRequirements = path.join(unsafeComponents, "pi-audio", "requirements.txt");
  await writeFile(outsideRequirements, "untrusted-package\n");
  await rm(linkedRequirements);
  let requirementsSymlinkCreated = true;
  try { await symlink(outsideRequirements, linkedRequirements, "file"); }
  catch (error) {
    requirementsSymlinkCreated = false;
    if (process.platform !== "win32" || !["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
  }
  if (requirementsSymlinkCreated) {
    const unsafeRuntime = createCreativeRuntime({ dataRoot: path.join(root, "unsafe-data"), componentsRoot: unsafeComponents }, createRunner());
    assert.equal((await unsafeRuntime.status()).ready, false);
    await assert.rejects(unsafeRuntime.ensure(), /requirements are missing or unsafe/u);
  }
  assert.equal(await readFile(outsideRequirements, "utf8"), "untrusted-package\n");

  const noPythonRunner = createRunner({ failBasePython: true });
  const noPython = createCreativeRuntime({ dataRoot: path.join(root, "no-python-data"), componentsRoot }, noPythonRunner);
  assert.ok((await noPython.status()).missing.includes("Python 3.11"));
  await assert.rejects(noPython.ensure(), /Python 3\.11 was not found/u);
  assert.equal(noPythonRunner.pipCount, 0);
} finally {
  if (originalPython === undefined) delete process.env.SYNTHV_TOOLBOX_PYTHON;
  else process.env.SYNTHV_TOOLBOX_PYTHON = originalPython;
  await rm(root, { recursive: true, force: true });
}

console.log("Creative runtime requirements, isolation, verification, reuse, cancellation, and symlink contracts passed.");
