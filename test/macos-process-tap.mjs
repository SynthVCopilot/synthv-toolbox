import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tauriRoot = join(root, "src", "PiDesktop.Tauri", "src-tauri");
const read = (path) => readFileSync(path, "utf8");

const build = read(join(tauriRoot, "build.rs"));
const capture = read(join(tauriRoot, "src", "audio_capture.rs"));
const native = read(join(tauriRoot, "native", "macos_process_tap.mm"));
const plist = read(join(tauriRoot, "Info.plist"));

assert.match(build, /native\/macos_process_tap\.mm/);
for (const framework of ["CoreAudio", "AudioToolbox", "Foundation"]) {
  assert.match(build, new RegExp(`framework=${framework}`));
}

assert.match(capture, /backend: "core-audio-process-tap"/);
assert.match(capture, /major == 14 && minor >= 2/);
assert.match(capture, /"synthesizer v studio 2 pro"/);
assert.match(capture, /frames_written == 0/);

assert.match(native, /kAudioHardwarePropertyTranslatePIDToProcessObject/);
assert.match(native, /AudioHardwareCreateProcessTap/);
assert.match(native, /AudioHardwareDestroyProcessTap/);
assert.match(native, /AudioHardwareCreateAggregateDevice/);
assert.match(native, /AudioHardwareDestroyAggregateDevice/);
assert.match(native, /AudioDeviceCreateIOProcID/);
assert.match(native, /AudioDeviceDestroyIOProcID/);
assert.match(native, /const AudioBufferList\* input, const AudioTimeStamp\*, AudioBufferList\*,/);
assert.match(native, /static_assert\(sizeof\(WavHeader\) == 44/);
assert.match(native, /kAudioAggregateDeviceTapAutoStartKey: @NO/);
assert.match(native, /AudioDeviceStart\(capture->aggregate, capture->io_proc\)/);
assert.ok(native.indexOf("stop_and_destroy_io(capture)") < native.indexOf("delete capture"));

assert.match(plist, /<key>NSAudioCaptureUsageDescription<\/key>/);
assert.match(plist, /Synthesizer V process you select/);

console.log("macOS Process Tap contracts passed.");
