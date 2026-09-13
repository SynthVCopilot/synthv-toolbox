import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const index = readFileSync(new URL("../src/PiDesktop.Tauri/dist/index.html", import.meta.url), "utf8");

assert.match(index, /(?:src|href)="\.\/assets\//);
assert.doesNotMatch(index, /(?:src|href)="\/assets\//);
