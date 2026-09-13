import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = stripTypeScriptTypes(readFileSync(new URL("../src/PiDesktop.Tauri/electron/services/component-audio-commands.ts", import.meta.url), "utf8"), { mode: "transform" });
const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);
const handlers = new Map();
module.registerComponentAudioCommands({ register: (name, handler) => handlers.set(name, handler) }, { dataRoot: ".", ffmpegPath: "ffmpeg", run: async (_file, args) => args[0] === "-version" ? { stdout: "ffmpeg test\n", stderr: "" } : { stdout: '{"format":{"duration":"1"}}', stderr: "" } });
assert.equal((await handlers.get("ffmpeg_status")({})).available, true);
assert.deepEqual(await handlers.get("get_ffmpeg_configuration")({}), { directory: null });
await assert.rejects(handlers.get("start_audio_prepare")({}), /configured component executor/);
assert.ok(handlers.has("component_downloads"));
console.log("Component and audio command contracts passed.");
