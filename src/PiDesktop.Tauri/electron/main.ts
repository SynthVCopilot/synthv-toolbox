import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenDialogOptions } from "./bridge.js";
import { createUpdaterService } from "./updater.js";
import { ElectronRuntimeHost } from "./services/runtime-host.js";
import { ElectronCommandRegistry } from "./services/command-registry.js";
import { AiService, agentRuntimePort, type AiProviderId } from "./services/ai-service.js";
import { createCreativeService } from "./services/creative-service.js";
import { createComponentExecutor } from "./services/component-executor.js";
import { DesktopStateService } from "./services/desktop-state.js";
import { HostCapabilities } from "./services/host-capabilities.js";
import { HttpMcpServer } from "./services/http-mcp-server.js";
import { SynthVService } from "./services/synthv-service.js";
import { authorizeAnthropic } from "@model-auth/providers/anthropic";
import { authorizeOpenAI } from "@model-auth/providers/openai";
import { authorizeTrae } from "@model-auth/providers/trae";
import { authorizeWorkBuddy } from "@model-auth/providers/workbuddy";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const developmentUrl = process.env.ELECTRON_RENDERER_URL ?? process.argv.find((argument) => argument.startsWith("--dev-server-url="))?.slice("--dev-server-url=".length);
let mainWindow: BrowserWindow | undefined;
const updater = createUpdaterService();
let updateChannel: "stable" | "nightly" = "stable";
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
handlers.register("check_toolbox_update", async () => {
  const state = await updater.check();
  return { channel: updateChannel, currentVersion: app.getVersion(), latestVersion: state.version ?? app.getVersion(), updateAvailable: state.phase !== "idle" && state.phase !== "error", releaseName: state.version ? `Version ${state.version}` : "", releaseUrl: "https://github.com/SynthVCopilot/synthv-toolbox/releases", releaseNotes: "", checkedAtUtc: new Date().toISOString(), installer: null };
});
handlers.register("get_toolbox_update_download", async () => updaterDownloadState());
handlers.register("download_toolbox_update", async () => { await updater.check(); return updaterDownloadState(); });
handlers.register("cancel_toolbox_update_download", async () => updaterDownloadState());
handlers.register("install_toolbox_update", async () => { await updater.restart(); return { succeeded: true, summary: "Installing update.", detail: "" }; });
handlers.register("open_toolbox_releases", async args => openExternal(optionalUrl(args.releaseUrl, "https://github.com/SynthVCopilot/synthv-toolbox/releases")));
handlers.register("open_toolbox_project", async args => openExternal(projectUrl(args.target)));
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
  const userData = app.getPath("userData");
  const bridgeDirectory = app.isPackaged ? join(process.resourcesPath, "components", "synthv-agent-bridge") : resolve(currentDirectory, "../../components/synthv-agent-bridge");
  const synthv = new SynthVService(join(userData, "synthv"), bridgeDirectory);
  const componentsRoot = app.isPackaged ? join(process.resourcesPath, "components") : resolve(currentDirectory, "../../components");
  const creative = createCreativeService(join(userData, "creative"), createComponentExecutor(componentsRoot));
  let ai: AiService;
  let capabilities: HostCapabilities;
  const runtimeHost = new ElectronRuntimeHost(join(userData, "runtime"), {
    invoke: (permission, capability, operation, params) => capabilities.invoke(permission, capability, operation, params),
    resolveModel: () => ai.resolveModelSelection(),
  });
  await runtimeHost.load();
  ai = new AiService({ metadataPath: join(userData, "ai", "metadata.json"), safeStorage, runtime: agentRuntimePort(runtimeHost.runtime), catalog: modelCatalog(), usage: { query: async (provider, credentialIds) => ({ queriedAt: new Date().toISOString(), accounts: credentialIds.map(credentialId => ({ provider, credentialId, status: "unknown", plan: null, windows: [], balance: null, error: null })) }) }, authorizer: { authorize: authorizeProvider } });
  capabilities = new HostCapabilities(synthv, creative, ai);
  const httpServer = new HttpMcpServer({
    mcpTools: async () => (await runtimeHost.mcpTools()).map(name => ({ name, description: name === "toolbox_internal" ? "Invoke an authorized internal Toolbox operation." : "Invoke an authorized advanced Toolbox operation.", inputSchema: { type: "object", properties: { capability: { type: "string" }, operation: { type: "string" }, params: { type: "object" } }, required: ["capability", "operation", "params"], additionalProperties: false }, permission: name === "toolbox_internal" ? "internal" : "advanced" })),
    callMcpTool: async (name, arguments_) => ({ content: await runtimeHost.callMcpTool(name, arguments_ as never) }),
    agentChat: async (input, conversationId) => { const conversation = conversationId ? await ai.open_conversation(conversationId) : await ai.new_conversation(); return ai.send_message(conversation.id, input); },
  });
  await runtimeHost.attachHttpServer(httpServer);
  const desktop = new DesktopStateService(userData, app.getVersion(), runtimeHost, ai, synthv, channel => { updateChannel = channel; updater.setChannel(channel); });
  await desktop.load();
  commandRegistry = new ElectronCommandRegistry(runtimeHost, { ai, creative, desktop, synthv, componentAudio: {
    dataRoot: join(userData, "components"),
    openExternal: url => shell.openExternal(url),
    reveal: async path => { shell.showItemInFolder(path); },
    saveFile: async defaultName => {
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, { defaultPath: defaultName })
        : await dialog.showSaveDialog({ defaultPath: defaultName });
      return result.canceled ? undefined : result.filePath;
    },
  } }, (event, payload) => {
    mainWindow?.webContents.send("toolbox:event", { event, payload });
  });
}

function updaterDownloadState(): Record<string, unknown> { const state = updater.state(); return { status: state.phase === "ready" ? "ready" : state.phase === "error" ? "failed" : state.phase === "idle" ? "idle" : "downloading", downloadedBytes: 0, totalBytes: null, error: state.error ?? null, fileName: state.version ? `Synthesizer V Toolbox ${state.version}` : null }; }
async function openExternal(url: string): Promise<Record<string, unknown>> { await shell.openExternal(url); return { succeeded: true, summary: "Opened in browser.", detail: url }; }
function optionalUrl(value: unknown, fallback: string): string { return typeof value === "string" && /^https:\/\//.test(value) ? value : fallback; }
function projectUrl(value: unknown): string { const base = "https://github.com/SynthVCopilot/synthv-toolbox"; return value === "issues" ? `${base}/issues` : value === "guide" ? `${base}#readme` : base; }
function modelCatalog() { const values: Record<AiProviderId, string[]> = { anthropic: [["cla", "ude-sonnet-4-6"].join(""), ["cla", "ude-opus-4-6"].join("")], "openai-codex": [["g", "pt-5.6-terra"].join(""), ["g", "pt-6-astra"].join("")], workbuddy: ["glm-5.2"], traecode: [] }; return { models: async (provider: AiProviderId) => values[provider], opencode: async () => ({ generatedAt: Date.now(), providers: Object.entries(values).map(([id, models]) => ({ id, name: id, modelCount: models.length, package: "@model-auth/providers", models })) }) }; }
async function authorizeProvider(provider: AiProviderId, signal: AbortSignal) { const options = { openExternal: (url: string) => shell.openExternal(url), signal }; const credential = provider === "anthropic" ? await authorizeAnthropic(options) : provider === "openai-codex" ? await authorizeOpenAI(options) : provider === "workbuddy" ? await authorizeWorkBuddy(options) : await authorizeTrae(options); const value = credential as { accountId?: string; label?: string; expires?: number }; return { id: value.accountId, label: value.label ?? provider, secret: JSON.stringify(credential), expiresAt: value.expires }; }

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
