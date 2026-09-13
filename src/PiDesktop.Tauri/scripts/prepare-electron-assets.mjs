import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "electron", "assets");
const destination = resolve(root, "dist", "electron", "assets");

await mkdir(destination, { recursive: true });
for (const file of ["icon.ico", "icon.icns"]) {
  await copyFile(resolve(source, file), resolve(destination, file));
}
