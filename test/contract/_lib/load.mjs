import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";

export const appRoot = new URL("../../../src/PiDesktop.Tauri/", import.meta.url);

/** A module compiled by `npm run build:electron`, addressed relative to dist/electron. */
export const compiled = path => import(new URL(`dist/electron/${path}`, appRoot).href);

export const rendererSource = name => readFileSync(new URL(`src/${name}.ts`, appRoot), "utf8");

/** Renderer TypeScript has no build output a test can import, so its types are stripped and the module loaded as a data URL. */
export const tsModuleUrl = text => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(text)).toString("base64")}`;

export const vueI18nUrl = () => pathToFileURL(createRequire(new URL("package.json", appRoot)).resolve("vue-i18n")).href;

const rendererUrls = new Map();

/**
 * Loads a renderer TypeScript module with its relative imports (./x) loaded the same way and vue-i18n pointed at the real
 * runtime, so every module shares one i18n instance. Type-only imports are stripped with the types.
 */
export function rendererModuleUrl(name) {
  if (!rendererUrls.has(name)) {
    const directory = name.includes("/") ? name.slice(0, name.lastIndexOf("/") + 1) : "";
    const text = rendererSource(name)
      .replace(/from "vue-i18n"/g, `from ${JSON.stringify(vueI18nUrl())}`)
      .replace(/from "\.\/([\w./-]+)"/g, (_, relative) => `from ${JSON.stringify(rendererModuleUrl(directory + relative))}`);
    rendererUrls.set(name, tsModuleUrl(text));
  }
  return rendererUrls.get(name);
}
