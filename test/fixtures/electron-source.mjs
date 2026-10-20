import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const electronRoot = fileURLToPath(new URL("../../src/PiDesktop.Tauri/electron/", import.meta.url));
const modules = new Map();

/**
 * Imports an Electron host module straight from its TypeScript source, transpiling its relative imports the same way,
 * so tests exercise the current source without a fresh build. Only node: builtins and relative imports are supported.
 */
export async function importElectronSource(relativePath) {
  return import(await moduleUrl(resolve(electronRoot, relativePath)));
}

function moduleUrl(path) {
  if (!modules.has(path)) modules.set(path, (async () => {
    let text = stripTypeScriptTypes(await readFile(path, "utf8"), { mode: "transform" });
    for (const [statement, specifier] of text.matchAll(/from "(\.{1,2}\/[^"]+)\.js"/g)) {
      text = text.replace(statement, `from "${await moduleUrl(resolve(dirname(path), `${specifier}.ts`))}"`);
    }
    return `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
  })());
  return modules.get(path);
}
