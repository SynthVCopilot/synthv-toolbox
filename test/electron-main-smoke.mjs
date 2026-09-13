import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const updater = pathToFileURL(join(root, "src/PiDesktop.Tauri/dist/electron/updater.js")).href;

try {
  await import(updater);
  console.log("Compiled Electron main modules loaded.");
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
