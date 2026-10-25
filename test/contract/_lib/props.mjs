import { createRequire } from "node:module";

// fast-check lives in the app package, which is not an ancestor of test/.
export const fc = createRequire(new URL("../../../src/PiDesktop.Tauri/package.json", import.meta.url))("fast-check");

/** Properties that touch the disk pass a cap so the nightly 1000-run setting stays affordable. */
export const runsCapped = cap => Math.min(runs(), cap);
const runs = () => Number(process.env.TONESHUTTLE_PROPERTY_RUNS) || 100;
const seed = () => (process.env.TONESHUTTLE_PROPERTY_SEED ? Number(process.env.TONESHUTTLE_PROPERTY_SEED) : undefined);

/** A failure prints the seed and path; TONESHUTTLE_PROPERTY_SEED=<seed> replays the same cases. */
export function assertProperty(arbitrary, predicate, options = {}) {
  fc.assert(fc.property(arbitrary, predicate), { numRuns: runs(), seed: seed(), ...options });
}

export async function assertAsyncProperty(arbitrary, predicate, options = {}) {
  await fc.assert(fc.asyncProperty(arbitrary, predicate), { numRuns: runs(), seed: seed(), ...options });
}
