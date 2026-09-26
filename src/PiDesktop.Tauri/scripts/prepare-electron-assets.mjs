import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "electron", "assets");
const destination = resolve(root, "dist", "electron", "assets");

await mkdir(destination, { recursive: true });
for (const file of ["icon.ico", "icon.icns"]) {
  await copyFile(resolve(source, file), resolve(destination, file));
}

// Electron reads name/version from the nearest package.json when run unpackaged
// (electron dist/electron/main.js); without one it reports its own version instead.
const { name, version, type } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
await writeFile(resolve(root, "dist", "electron", "package.json"), JSON.stringify({ name, version, type }));
