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
const version = `${packageJson.version}-dev.${hash}`;

updateJson(packageFile, (value) => {
  value.version = version;
});
updateJson(path.join(desktop, "package-lock.json"), (value) => {
  value.version = version;
  if (value.packages?.[""]) value.packages[""].version = version;
});
updateJson(path.join(desktop, "src-tauri/tauri.conf.json"), (value) => {
  value.version = version;
});

const cargoFile = path.join(desktop, "src-tauri/Cargo.toml");
const cargo = fs.readFileSync(cargoFile, "utf8");
const packageVersion = /(\[package\][\s\S]*?\r?\nversion\s*=\s*)"[^"]+"/;
if (!packageVersion.test(cargo)) {
  throw new Error("Could not locate the Cargo package version");
}
fs.writeFileSync(cargoFile, cargo.replace(packageVersion, `$1"${version}"`));

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}
process.stdout.write(`SynthV Toolbox development build version: ${version}\n`);
