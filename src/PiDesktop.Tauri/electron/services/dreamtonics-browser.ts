import { BrowserWindow, session } from "electron";
import { DREAMTONICS_PRODUCT_PAGE, type WebAccountBrowser } from "./dreamtonics-web.js";

export function createDreamtonicsBrowser(slotId: string): WebAccountBrowser {
  let window: BrowserWindow | undefined;
  let received: ((value: string) => void) | undefined;

  const create = (show: boolean) => {
    if (window && !window.isDestroyed()) { if (show) { window.show(); window.focus(); } return window; }
    window = new BrowserWindow({ width: 1100, height: 780, show, webPreferences: { partition: `persist:dreamtonics-${slotId}`, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      const target = new URL(url);
      if (target.protocol !== "https:" || !["my.dreamtonics.com", "account.dreamtonics.com"].includes(target.hostname)) event.preventDefault();
    });
    window.webContents.session.webRequest.onBeforeSendHeaders({ urls: ["https://authr3.dreamtonics.com/api/v1/client/*"] }, (details, callback) => {
      const value = details.requestHeaders.Authorization ?? details.requestHeaders.authorization;
      if (typeof value === "string" && value.startsWith("Bearer ")) { received?.(value); }
      callback({ requestHeaders: details.requestHeaders });
    });
    return window;
  };

  return {
    async open() { const browser = create(true); if (browser.webContents.getURL() === "") await browser.loadURL(DREAMTONICS_PRODUCT_PAGE); },
    async authorization() {
      const browser = create(false);
      const token = new Promise<string | undefined>((resolve) => {
        const timer = setTimeout(() => { received = undefined; if (!browser.isDestroyed()) browser.show(); resolve(undefined); }, 20000);
        received = (value) => { clearTimeout(timer); received = undefined; resolve(value); };
      });
      void browser.loadURL(DREAMTONICS_PRODUCT_PAGE).catch(() => {});
      return token;
    },
    async fetch(url, init) {
      const browser = create(false);
      return browser.webContents.session.fetch(url, init);
    },
    async clear() {
      if (window && !window.isDestroyed()) window.close();
      const browserSession = session.fromPartition(`persist:dreamtonics-${slotId}`);
      await browserSession.clearStorageData();
      await browserSession.clearCache();
    },
  };
}
