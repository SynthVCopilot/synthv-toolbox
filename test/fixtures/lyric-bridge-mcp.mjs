import fs from "node:fs";
import readline from "node:readline";

const [mode, logPath] = process.argv.slice(2);
let statusCalls = 0;
let selectionCalls = 0;

function record(value) {
  fs.appendFileSync(logPath, `${JSON.stringify(value)}\n`);
}

function response(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function text(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function selection() {
  selectionCalls += 1;
  const changed = mode === "selection-change" && selectionCalls > 1;
  return {
    contextId: "old-selection-context",
    selectionRevision: changed ? 2 : 1,
    selectedNoteCount: 2,
    current: { trackIndex: 2, groupIndex: 3 },
    selectedNotes: changed
      ? [{ noteIndex: 1, lyric: "旧", onset: 0, duration: 480, pitch: 60 }, { noteIndex: 3, lyric: "词", onset: 480, duration: 480, pitch: 62 }]
      : [{ noteIndex: 2, lyric: "词", onset: 480, duration: 480, pitch: 62 }, { noteIndex: 1, lyric: "旧", onset: 0, duration: 480, pitch: 60 }],
  };
}

const tools = ["sv_status", "sv_describe", "sv_query", "sv_command", "sv_ui", "sv_review"]
  .map((name) => ({ name, description: name, inputSchema: { type: "object" } }));

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "notifications/initialized") return;
  if (request.method === "initialize") {
    response(request.id, { protocolVersion: "2025-06-18", serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } });
    return;
  }
  if (request.method === "tools/list") {
    response(request.id, { tools });
    return;
  }
  const { name, arguments: args } = request.params;
  record({ name, args });
  if (name === "sv_status") {
    statusCalls += 1;
    const sessionToken = mode === "session-change" && statusCalls > 2 ? "session-b" : "session-a";
    response(request.id, text({ connected: true, fresh: true, ageMs: 0, status: { state: "running", sessionToken } }));
    return;
  }
  if (name === "sv_query") {
    response(request.id, text(selection()));
    return;
  }
  if (name === "sv_command") {
    response(request.id, text({ applied: true }));
    return;
  }
  response(request.id, text({}));
});
