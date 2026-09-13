export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface OpenDialogOptions {
  multiple?: boolean;
  directory?: boolean;
  filters?: FileFilter[];
}

export interface DesktopFileDrop {
  paths: string[];
  position: { x: number; y: number };
}

export interface DesktopBridge {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, listener: (payload: T) => void): () => void;
  openDialog(options: OpenDialogOptions): Promise<string | string[] | undefined>;
  onFileDrop(listener: (drop: DesktopFileDrop) => void): () => void;
}

declare global {
  interface Window {
    toolboxDesktop?: DesktopBridge;
  }
}

function desktopBridge(): DesktopBridge | undefined {
  return window.toolboxDesktop;
}

export function hasDesktopBridge(): boolean {
  return desktopBridge() !== undefined;
}

export function invokeDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const bridge = desktopBridge();
  if (!bridge) return Promise.reject(new Error("Desktop bridge is unavailable."));
  return bridge.invoke<T>(command, args);
}

export async function listenDesktop<T>(event: string, listener: (payload: T) => void): Promise<() => void> {
  const bridge = desktopBridge();
  if (!bridge) return () => undefined;
  return bridge.listen(event, listener);
}

export function openDesktopDialog(options: OpenDialogOptions): Promise<string | string[] | undefined> {
  const bridge = desktopBridge();
  if (!bridge) return Promise.resolve(undefined);
  return bridge.openDialog(options);
}

export async function listenForDesktopFileDrops(listener: (drop: DesktopFileDrop) => void): Promise<() => void> {
  const bridge = desktopBridge();
  if (!bridge) return () => undefined;
  return bridge.onFileDrop(listener);
}
