import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import process from "node:process";

const componentDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../components/audio-capture");
const buildDirectory = resolve(componentDirectory, "build");
const executable = resolve(componentDirectory, "bin", process.platform === "win32" ? "audio-capture.exe" : "audio-capture");

if (process.platform !== "win32" && process.platform !== "darwin") {
  console.log(`Process audio capture has no ${process.platform} backend; skipping its native build.`);
  process.exit(0);
}

function cmake(args) {
  const result = spawnSync("cmake", args, { stdio: "inherit" });
  if (result.error) throw new Error(`CMake is required to build the audio capture executable: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Named explicitly because some CMake distributions on Windows default to Ninja with whatever compiler is first on PATH.
function visualStudioGenerator() {
  const vswhere = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const property = name => spawnSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", name], { encoding: "utf8" }).stdout?.trim();
  const version = property("installationVersion"), installation = property("installationPath");
  if (!version || !installation) throw new Error("Visual Studio with the MSVC x64 build tools is required to build the audio capture executable.");
  // vswhere's product line is a year up to VS 2022 but "18" for VS 2026, so take the generator name from CMake itself.
  const major = version.split(".")[0];
  const generator = (spawnSync("cmake", ["--help"], { encoding: "utf8" }).stdout ?? "").split(/\r?\n/).map(line => /^\*?\s*(Visual Studio (\d+) \d{4})\b/.exec(line)).find(match => match?.[2] === major)?.[1];
  if (!generator) throw new Error(`This CMake has no generator for Visual Studio ${major}; update CMake to build the audio capture executable.`);
  return ["-G", generator, "-A", "x64", `-DCMAKE_GENERATOR_INSTANCE=${installation}`];
}

cmake(["-S", componentDirectory, "-B", buildDirectory, ...(process.platform === "win32" ? visualStudioGenerator() : ["-DCMAKE_BUILD_TYPE=Release"])]);
cmake(["--build", buildDirectory, "--config", "Release"]);
if (!existsSync(executable)) throw new Error(`The audio capture build finished without producing ${executable}.`);
