import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const NODE_VERSION = "22.19.0";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "src-tauri", "resources", "node");
const archives = {
  "x86_64-pc-windows-msvc": ["win-x64.zip", "ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86"],
  "aarch64-pc-windows-msvc": ["win-arm64.zip", "e4a7336010d58ff35b53d9dd5869095c56089c70913cf22508cf8183593e56b2"],
  "x86_64-apple-darwin": ["darwin-x64.tar.gz", "3cfed4795cd97277559763c5f56e711852d2cc2420bda1cea30c8aa9ac77ce0c"],
  "aarch64-apple-darwin": ["darwin-arm64.tar.gz", "c59006db713c770d6ec63ae16cb3edc11f49ee093b5c415d667bb4f436c6526d"],
  "x86_64-unknown-linux-gnu": ["linux-x64.tar.xz", "c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2"],
  "aarch64-unknown-linux-gnu": ["linux-arm64.tar.xz", "0b2d9f564b6594222a62c82e1df2efe119dd4a4aff29644f4dd325bf360b6bcc"],
};

export function targetFromEnvironment(environment = process.env) {
  if (environment.SYNTHV_TOOLBOX_NODE_TARGET) return environment.SYNTHV_TOOLBOX_NODE_TARGET;
  const architectures = { x64: "x86_64", arm64: "aarch64" };
  const architecture = architectures[process.arch];
  if (!architecture) throw new Error(`Unsupported Node host architecture: ${process.arch}`);
  if (process.platform === "win32") return `${architecture}-pc-windows-msvc`;
  if (process.platform === "darwin") return `${architecture}-apple-darwin`;
  if (process.platform === "linux") return `${architecture}-unknown-linux-gnu`;
  throw new Error(`Unsupported Node host platform: ${process.platform}`);
}

async function download(target, temp) {
  const [suffix, expected] = archives[target] ?? [];
  if (!suffix) throw new Error(`Unsupported Node target: ${target}`);
  const name = `node-v${NODE_VERSION}-${suffix}`;
  const destination = join(temp, name);
  const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${name}`);
  if (!response.ok || !response.body) throw new Error(`Failed to download ${name}: ${response.status}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
  const actual = createHash("sha256").update(await readFile(destination)).digest("hex");
  if (actual !== expected) throw new Error(`SHA256 mismatch for ${name}`);
  return destination;
}

async function stage(target, temp) {
  const archive = await download(target, temp);
  const extract = await mkdtemp(join(temp, "extract-"));
  execFileSync("tar", ["-xf", archive, "-C", extract], { stdio: "inherit" });
  const [suffix] = archives[target];
  const directory = join(extract, `node-v${NODE_VERSION}-${suffix.replace(/\.(zip|tar\.gz|tar\.xz)$/, "")}`);
  return { executable: join(directory, target.includes("windows") ? "node.exe" : "bin/node"), license: join(directory, "LICENSE") };
}

const target = targetFromEnvironment();
if (process.argv.includes("--dry-run")) {
  console.log(JSON.stringify({ target, version: NODE_VERSION, archive: archives[target]?.[0], output }));
  process.exit(0);
}
const temp = await mkdtemp(join(tmpdir(), "synthv-node-"));
try {
  const staged = target === "universal-apple-darwin"
    ? await Promise.all([stage("x86_64-apple-darwin", temp), stage("aarch64-apple-darwin", temp)])
    : [await stage(target, temp)];
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const executable = join(output, process.platform === "win32" || target.includes("windows") ? "node.exe" : "node");
  if (staged.length === 2) execFileSync("lipo", ["-create", staged[0].executable, staged[1].executable, "-output", executable]);
  else await cp(staged[0].executable, executable);
  if (!executable.endsWith(".exe")) await chmod(executable, 0o755);
  await cp(staged[0].license, join(output, "LICENSE"));
  await writeFile(join(output, "manifest.json"), JSON.stringify({ version: NODE_VERSION, target, executable: executable.split(/[\\/]/).pop() }, null, 2) + "\n");
} finally { await rm(temp, { recursive: true, force: true }); }
