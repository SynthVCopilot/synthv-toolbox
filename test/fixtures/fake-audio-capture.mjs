// Speaks the audio-capture executable's stdio protocol and renders audio as a function of the fake host's playhead, so captures of one range match.
import { appendFileSync, closeSync, openSync, readFileSync, writeSync } from "node:fs";

const argument = name => process.argv[process.argv.indexOf(name) + 1];
const processId = Number(argument("--pid")), output = argument("--output");
const env = process.env;
if (env.FAKE_AUDIO_CAPTURE_LOG) appendFileSync(env.FAKE_AUDIO_CAPTURE_LOG, `${JSON.stringify({ processId, output })}\n`);
if (env.FAKE_AUDIO_CAPTURE_FAIL_START) {
  console.log(JSON.stringify({ event: "error", stage: "start", code: -2004287480, message: "Process loopback could not start." }));
  process.exit(1);
}

const rate = 48000, amplitude = Number(env.FAKE_AUDIO_CAPTURE_AMPLITUDE ?? 0.5), discontinuities = Number(env.FAKE_AUDIO_CAPTURE_DISCONTINUITIES ?? 0);
const now = () => performance.timeOrigin + performance.now();
const voice = t => amplitude * (0.5 * Math.sin(2 * Math.PI * 220 * t) + 0.3 * Math.sin(2 * Math.PI * 331.7 * t + 0.5) + 0.2 * Math.sin(2 * Math.PI * 523.3 * t)) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 1.3 * t));
const header = dataBytes => {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(36 + dataBytes, 4); bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 4, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(dataBytes, 40);
  return bytes;
};
const transport = () => { try { return JSON.parse(readFileSync(env.FAKE_AUDIO_CAPTURE_TRANSPORT, "utf8")); } catch { return {}; } };

const file = openSync(output, "wx");
writeSync(file, header(0));
const started = now();
let frames = 0;
const pump = () => {
  const due = Math.floor((now() - started) / 1000 * rate);
  if (due <= frames) return;
  const state = transport(), chunk = Buffer.alloc((due - frames) * 4);
  for (let index = 0; index < due - frames; index += 1) {
    const at = started + (frames + index) / rate * 1000;
    const playing = typeof state.startedAt === "number" && at >= state.startedAt && (state.stoppedAt === null || at < state.stoppedAt);
    const value = playing ? Math.round(voice(state.playFrom + (at - state.startedAt) / 1000) * 32767) : 0;
    chunk.writeInt16LE(value, index * 4); chunk.writeInt16LE(value, index * 4 + 2);
  }
  writeSync(file, chunk);
  frames = due;
};
console.log(JSON.stringify({ event: "ready", sampleRate: rate, channels: 2, bitsPerSample: 16 }));
const timer = setInterval(pump, 10);
let finished = false;
const finish = () => {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  pump();
  writeSync(file, header(frames * 4), 0, 44, 0);
  closeSync(file);
  console.log(JSON.stringify({ event: "finished", sampleRate: rate, channels: 2, bitsPerSample: 16, frames, discontinuities }));
  process.exit(0);
};
process.stdin.on("data", finish);
process.stdin.on("end", finish);
