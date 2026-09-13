import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenDialogOptions } from "./bridge.js";
import { createUpdaterService } from "./updater.js";
import { ElectronRuntimeHost } from "./services/runtime-host.js";
import { ElectronCommandRegistry } from "./services/command-registry.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const developmentUrl = process.env.ELECTRON_RENDERER_URL ?? process.argv.find((argument) => argument.startsWith("--dev-server-url="))?.slice("--dev-server-url=".length);
let mainWindow: BrowserWindow | undefined;
const updater = createUpdaterService();
type HostArguments = Record<string, unknown>;
type HostHandler = (args: HostArguments) => Promise<unknown>;

class HostHandlerRegistry {
  private readonly handlers = new Map<string, HostHandler>();

  register(command: string, handler: HostHandler): void {
    if (this.handlers.has(command)) throw new Error(`Desktop handler already registered: ${command}`);
    this.handlers.set(command, handler);
  }

  async invoke(command: string, args: HostArguments): Promise<unknown> {
    const handler = this.handlers.get(command);
    if (!handler) throw new Error(`No Electron handler is registered for ${command}.`);
    return handler(args);
  }
}

const handlers = new HostHandlerRegistry();
handlers.register("updater.check", async () => updater.check());
handlers.register("updater.restart", async () => updater.restart());
handlers.register("updater.state", async () => updater.state());
let commandRegistry: ElectronCommandRegistry | undefined;

updater.onState((state) => {
  mainWindow?.webContents.send("toolbox:event", { event: "updater.state", payload: state });
});

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

ipcMain.handle("toolbox:invoke", async (_event, payload: unknown) => {
  const envelope = payload && typeof payload === "object" ? payload as { command?: unknown; args?: unknown } : undefined;
  const command = envelope?.command;
  if (typeof command !== "string" || !command) throw new Error("Invalid desktop command.");
  const args = envelope?.args;
  if (args !== undefined && (!args || typeof args !== "object" || Array.isArray(args))) throw new Error("Desktop command arguments must be an object.");
  const parameters = (args ?? {}) as HostArguments;
  try {
    return await handlers.invoke(command, parameters);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("No Electron handler is registered")) throw error;
    if (!commandRegistry) throw new Error("Electron services are not ready.");
    return commandRegistry.invoke(command, parameters);
  }
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

async function initializeServices(): Promise<void> {
  const runtimeHost = new ElectronRuntimeHost(join(app.getPath("userData"), "runtime"), {
    invoke: async () => { throw new Error("The requested native capability has not been migrated to Node."); },
    resolveModel: async () => { throw new Error("No model credential is configured."); },
  });
  await runtimeHost.load();
  commandRegistry = new ElectronCommandRegistry(runtimeHost, (event, payload) => {
    mainWindow?.webContents.send("toolbox:event", { event, payload });
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", focusMainWindow);
  app.whenReady().then(async () => {
    await initializeServices();
    await createMainWindow();
  }).catch((reason: unknown) => {
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
