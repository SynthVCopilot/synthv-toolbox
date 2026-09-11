import assert from "node:assert/strict";
import { formatPercentage, normalizePercentagePrecision } from "../src/PiDesktop.Tauri/src/percentage.ts";

assert.equal(formatPercentage(42.125), "42.13");
assert.equal(formatPercentage(42.125, 0), "42");
assert.equal(formatPercentage(42.125, 4), "42.1250");
assert.equal(formatPercentage(42.125, -1), "42.125");
assert.equal(normalizePercentagePrecision(1.5), 2);
assert.equal(normalizePercentagePrecision(-2), 2);

console.log("AI percentage precision defaults and overrides passed.");
