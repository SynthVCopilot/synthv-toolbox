import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenDialogOptions } from "./bridge.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const developmentUrl = process.env.ELECTRON_RENDERER_URL;
let mainWindow: BrowserWindow | undefined;

function focusMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function validateOpenDialogOptions(value: unknown): OpenDialogOptions {
  if (!value || typeof value !== "object") return {};
  const options = value as Partial<OpenDialogOptions>;
  return {
    multiple: options.multiple === true,
    directory: options.directory === true,
    filters: Array.isArray(options.filters)
      ? options.filters.filter((filter): filter is { name: string; extensions: string[] } =>
        Boolean(filter) && typeof filter.name === "string" && Array.isArray(filter.extensions)
          && filter.extensions.every((extension) => typeof extension === "string"))
      : undefined,
  };
}

ipcMain.handle("toolbox:invoke", (_event, payload: unknown) => {
  const command = payload && typeof payload === "object" ? (payload as { command?: unknown }).command : undefined;
  if (typeof command !== "string" || !command) throw new Error("Invalid desktop command.");
  throw new Error(`No Electron handler is registered for ${command}.`);
});

ipcMain.handle("toolbox:open-dialog", async (event, rawOptions: unknown) => {
  const options = validateOpenDialogOptions(rawOptions);
  const properties: ("openFile" | "openDirectory" | "multiSelections")[] = [options.directory ? "openDirectory" : "openFile"];
  if (options.multiple) properties.push("multiSelections");
  const dialogOptions = {
    properties,
    filters: options.filters,
  };
  const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  if (result.canceled) return undefined;
  return options.multiple ? result.filePaths : result.filePaths[0];
});

async function createMainWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(currentDirectory, "preload.js"),
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => { mainWindow = undefined; });
  if (developmentUrl) await mainWindow.loadURL(developmentUrl);
  else await mainWindow.loadFile(resolve(currentDirectory, "../../dist/index.html"));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", focusMainWindow);
  app.whenReady().then(createMainWindow).catch((reason: unknown) => {
    console.error("Unable to create Electron window", reason);
    app.quit();
  });
  app.on("activate", () => {
    if (mainWindow) focusMainWindow();
    else void createMainWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
