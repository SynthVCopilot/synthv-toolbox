import fs from "node:fs";
import path from "node:path";

const commit = process.argv[2] ?? "";
if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
  throw new Error(`Development build commit must be a Git SHA: ${commit}`);
}

const repository = path.resolve(process.argv[3] ?? path.join(import.meta.dirname, "../.."));
const desktop = path.join(repository, "src/PiDesktop.Tauri");
const hash = commit.slice(0, 7).toLowerCase();

function updateJson(filename, update) {
  const value = JSON.parse(fs.readFileSync(filename, "utf8"));
  update(value);
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

const packageFile = path.join(desktop, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
const lockFile = path.join(desktop, "package-lock.json");
const packageLock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
const tauriFile = path.join(desktop, "src-tauri/tauri.conf.json");
const tauriConfig = JSON.parse(fs.readFileSync(tauriFile, "utf8"));
const cargoFile = path.join(desktop, "src-tauri/Cargo.toml");
const cargo = fs.readFileSync(cargoFile, "utf8");
const packageVersion = /(\[package\][\s\S]*?\r?\nversion\s*=\s*)"([^"]+)"/;
const cargoMatch = cargo.match(packageVersion);
if (!cargoMatch) {
  throw new Error("Could not locate the Cargo package version");
}

const versions = [
  packageJson.version,
  packageLock.version,
  packageLock.packages?.[""]?.version,
  tauriConfig.version,
  cargoMatch[2],
];
if (versions.some((current) => current !== packageJson.version)) {
  throw new Error("Desktop manifests must use the same base version before a development build");
}

const suffix = `-dev.${hash}`;
let version;
if (packageJson.version.includes("-dev.")) {
  if (!packageJson.version.endsWith(suffix)) {
    throw new Error(`Desktop manifests already contain a different development version: ${packageJson.version}`);
  }
  version = packageJson.version;
} else {
  version = `${packageJson.version}${suffix}`;
}

updateJson(packageFile, (value) => {
  value.version = version;
});
updateJson(lockFile, (value) => {
  value.version = version;
  if (value.packages?.[""]) value.packages[""].version = version;
});
updateJson(tauriFile, (value) => {
  value.version = version;
});

fs.writeFileSync(cargoFile, cargo.replace(packageVersion, `$1"${version}"`));

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}
process.stdout.write(`SynthV Toolbox development build version: ${version}\n`);
