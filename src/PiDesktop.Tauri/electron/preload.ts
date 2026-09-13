import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopBridge, DesktopFileDrop, OpenDialogOptions } from "./bridge.js";

const eventChannel = "toolbox:event";

const bridge: DesktopBridge = {
  invoke: (command, args) => ipcRenderer.invoke("toolbox:invoke", { command, args }),
  listen: <T>(event: string, listener: (payload: T) => void) => {
    const callback = (_event: Electron.IpcRendererEvent, envelope: { event?: unknown; payload?: unknown }) => {
      if (envelope?.event === event) listener(envelope.payload as T);
    };
    ipcRenderer.on(eventChannel, callback);
    return () => ipcRenderer.removeListener(eventChannel, callback);
  },
  openDialog: (options: OpenDialogOptions) => ipcRenderer.invoke("toolbox:open-dialog", options),
  onFileDrop: (listener) => {
    const preventDefault = (event: DragEvent) => event.preventDefault();
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      const paths = Array.from(event.dataTransfer?.files ?? [])
        .map((file) => webUtils.getPathForFile(file))
        .filter((path) => path.length > 0);
      if (!paths.length) return;
      const drop: DesktopFileDrop = { paths, position: { x: event.clientX, y: event.clientY } };
      listener(drop);
    };
    document.addEventListener("dragover", preventDefault);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", preventDefault);
      document.removeEventListener("drop", onDrop);
    };
  },
};

contextBridge.exposeInMainWorld("toolboxDesktop", bridge);
