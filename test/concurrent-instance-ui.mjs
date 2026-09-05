import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src/main.ts", import.meta.url), "utf8");

assert.match(source, /instanceRefreshInFlight/);
assert.match(source, /generation !== instanceRefreshGeneration/);
assert.match(source, /slot\.concurrent\.runningPids\.includes\(process\.processId\)/);
assert.match(source, /function isSv2NormalProcess/);
assert.match(source, /未关联账号/);
assert.match(source, /声库按账号独立保存，同账号实例共用槽位数据/);
console.log("concurrent instance UI contract passed");
