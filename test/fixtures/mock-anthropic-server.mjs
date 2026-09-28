import http from "node:http";

// A scripted local HTTP server that speaks the Anthropic Messages streaming API, standing in for the
// real provider so tests drive the real Pi SDK with no network and no real credentials. Extracted from
// the original test/agent-e2e.mjs (P2 and P3 also consume this fixture).

function sendSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeNormalTurn(res, turn) {
  const usage = turn.usage ?? { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  sendSse(res, "message_start", {
    type: "message_start",
    message: {
      id: `msg_${Math.random().toString(36).slice(2)}`,
      type: "message",
      role: "assistant",
      model: turn.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: usage.input, output_tokens: 0, cache_creation_input_tokens: usage.cacheWrite ?? 0, cache_read_input_tokens: usage.cacheRead ?? 0 },
    },
  });
  for (let index = 0; index < turn.content.length; index++) {
    const block = turn.content[index];
    if (block.type === "text") {
      sendSse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      // A chunked block streams its text as several content_block_delta events with a delay between
      // each one, so tests can observe message_update text_delta events arriving over real time
      // (contract 8's added chunked streaming mode).
      if (Array.isArray(block.chunks)) {
        for (const chunk of block.chunks) {
          sendSse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: chunk } });
          if (block.chunkDelayMs) await delay(block.chunkDelayMs);
        }
      } else {
        sendSse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
      }
      sendSse(res, "content_block_stop", { type: "content_block_stop", index });
    } else if (block.type === "tool_use") {
      sendSse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      sendSse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      sendSse(res, "content_block_stop", { type: "content_block_stop", index });
    }
  }
  sendSse(res, "message_delta", { type: "message_delta", delta: { stop_reason: turn.stopReason, stop_sequence: null }, usage: { output_tokens: usage.output } });
  sendSse(res, "message_stop", { type: "message_stop" });
  res.end();
}

function writeSlowTurn(res, turn) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  sendSse(res, "message_start", {
    type: "message_start",
    message: { id: "msg_slow", type: "message", role: "assistant", model: turn.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  });
  sendSse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  sendSse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Working on it" } });
  turn.onStarted?.();
  const timer = setTimeout(() => {
    // Only reached if the caller failed to cancel in time; finish the turn so the test does not hang.
    try {
      sendSse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      sendSse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
      sendSse(res, "message_stop", { type: "message_stop" });
      res.end();
    } catch { /* connection already gone */ }
  }, 5000);
  res.on("close", () => clearTimeout(timer));
}

export function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.filter((block) => block?.type === "text").map((block) => block.text).join("");
}

export function systemText(system) {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system.filter((block) => block?.type === "text").map((block) => block.text).join("");
}

export function createMockAnthropicServer({ turns = [] } = {}) {
  const requests = [];
  let queue = [...turns];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* leave null */ }
      const headers = { ...req.headers };
      const apiKey = headers["x-api-key"];
      delete headers["x-api-key"];
      delete headers.authorization;
      requests.push({ path: req.url, system: body?.system, tools: body?.tools, messages: body?.messages, model: body?.model, apiKey, headers });
      const turn = queue.shift();
      if (!turn) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "No scripted turn was queued for this request." } }));
        return;
      }
      const modeled = { ...turn, model: turn.model ?? body?.model };
      if (modeled.kind === "error") {
        res.writeHead(modeled.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: modeled.errorType ?? "authentication_error", message: modeled.message } }));
        return;
      }
      if (modeled.kind === "slow") writeSlowTurn(res, modeled);
      else void writeNormalTurn(res, modeled);
    });
  });
  return {
    requests,
    push(turn) { queue.push(turn); },
    reset(nextTurns = []) { queue = [...nextTurns]; requests.length = 0; },
    async listen() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return server.address().port;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
