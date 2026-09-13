import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const main = readFileSync(new URL("../src/PiDesktop.Tauri/electron/main.ts", import.meta.url), "utf8");
const synthv = readFileSync(new URL("../src/PiDesktop.Tauri/electron/services/synthv-service.ts", import.meta.url), "utf8");

test("Electron launch-at-login uses the operating system setting and starts hidden", () => {
  assert.match(main, /app\.setLoginItemSettings\(\{ openAtLogin: enabled, openAsHidden: enabled, args: enabled \? \["--toolbox-autostart"\] : \[\] \}\)/);
  assert.match(main, /app\.getLoginItemSettings\(\)\.openAtLogin/);
  assert.match(main, /process\.argv\.includes\("--toolbox-autostart"\) \|\| app\.getLoginItemSettings\(\)\.wasOpenedAtLogin/);
  assert.match(main, /await createMainWindow\(isLoginLaunch\(\)\)/);
  assert.match(main, /if \(!startHidden\) mainWindow\?\.show\(\)/);
  assert.match(synthv, /private readonly autostart\?: AutostartController/);
});

test("Electron tray opens the hidden window and supplies an explicit exit action", () => {
  assert.match(main, /new Tray\(image\)/);
  assert.match(main, /tray\.on\("click", \(\) => void showMainWindow\(\)\)/);
  assert.match(main, /Menu\.buildFromTemplate\(\[/);
  assert.match(main, /label: "打开 Toolbox"/);
  assert.match(main, /label: "退出"/);
  assert.match(main, /mainWindow\?\.hide\(\)/);
});
