import fs from "node:fs";
import path from "node:path";

const [tag = "", repositoryOption] = process.argv.slice(2);
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error(
    `Release tag must use semantic versioning (for example v1.2.3): ${tag}`,
  );
}
const version = tag.slice(1);
const repository = path.resolve(repositoryOption ?? path.join(import.meta.dirname, "../.."));
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
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}
process.stdout.write(`SynthV Toolbox build version: ${version}\n`);
