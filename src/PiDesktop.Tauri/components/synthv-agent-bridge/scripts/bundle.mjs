import { build } from "esbuild";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeModules = join(repositoryRoot, "node_modules");
const outputDirectory = join(repositoryRoot, "dist");

const result = await build({
  entryPoints: ["src/cli.ts", "legacy-sv1/src/cli.ts", "src/score-import.ts"],
  absWorkingDir: repositoryRoot,
  bundle: true,
  format: "esm",
  legalComments: "inline",
  metafile: true,
  outbase: ".",
  outdir: "dist",
  platform: "node",
  target: "node20",
});

const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const packageRoot = await findPackageRoot(resolve(repositoryRoot, input));
  if (packageRoot !== undefined) {
    packages.set(packageRoot, await readPackage(packageRoot));
  }
}

const notices = [];
for (const [packageRoot, packageJson] of [...packages.entries()].sort((left, right) =>
  left[1].name.localeCompare(right[1].name),
)) {
  const license = await readLicense(packageRoot);
  notices.push(`${packageJson.name} ${packageJson.version}\nDeclared license: ${packageJson.license}\n\n${license}`);
}
const separator = `\n\n${"=".repeat(80)}\n\n`;
await writeFile(
  join(outputDirectory, "THIRD_PARTY_NOTICES.txt"),
  `Third-party notices for the bundled SynthV Agent Bridge\n\n${notices.join(separator)}\n`,
);

async function findPackageRoot(filePath) {
  let current = dirname(filePath);
  while (relative(nodeModules, current) && !relative(nodeModules, current).startsWith("..")) {
    if (await exists(join(current, "package.json"))) {
      const packageJson = await readPackage(current, false);
      if (packageJson !== undefined) {
        return current;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return undefined;
}

async function readPackage(packageRoot, required = true) {
  const value = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (typeof value.name !== "string" || typeof value.version !== "string" || typeof value.license !== "string") {
    if (!required) return undefined;
    throw new Error(`Bundled package at ${packageRoot} lacks name, version, or license metadata.`);
  }
  return value;
}

async function readLicense(packageRoot) {
  const entries = await readdir(packageRoot);
  const licenseFile = entries.find((entry) => /^(?:licen[cs]e|copying)(?:\.[\w-]+)?$/iu.test(entry));
  if (licenseFile === undefined) {
    throw new Error(`Bundled package at ${packageRoot} does not contain a license text.`);
  }
  return readFile(join(packageRoot, licenseFile), "utf8");
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
