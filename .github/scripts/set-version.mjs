import fs from "node:fs";
import path from "node:path";

const tag = process.argv[2] ?? "";
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error(
    `Release tag must use semantic versioning (for example v1.2.3): ${tag}`,
  );
}
const version = tag.slice(1);
const repository = path.resolve(import.meta.dirname, "../..");
const desktop = path.join(repository, "src/PiDesktop.Tauri");

function updateJson(filename, update) {
  const value = JSON.parse(fs.readFileSync(filename, "utf8"));
  update(value);
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

updateJson(path.join(desktop, "package.json"), (value) => {
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
if (!packageVersion.test(cargo))
  throw new Error("Could not locate the Cargo package version");
const updatedCargo = cargo.replace(packageVersion, `$1"${version}"`);
fs.writeFileSync(cargoFile, updatedCargo);

process.stdout.write(`SynthV Toolbox build version: ${version}\n`);
