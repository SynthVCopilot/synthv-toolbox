import assert from "node:assert/strict";
import test from "node:test";
import { compiled } from "../_lib/load.mjs";
import { assertProperty, fc } from "../_lib/props.mjs";

const { externalToolNames } = await compiled("services/external-mcp-tools.js");
const PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

// Unicode, lone surrogates, very long names, and a tiny alphabet that forces slug and sanitised-name collisions.
const text = fc.oneof(
  fc.string({ unit: "binary", maxLength: 24 }),
  fc.string({ unit: "grapheme", maxLength: 24 }),
  fc.string({ minLength: 60, maxLength: 150 }),
  fc.constantFrom("a", "A", "a b", "a.b", "a-b", "a_b", "", " ", "工具", "mcp__x", "x".repeat(70), "x".repeat(70) + "y"),
);
const server = fc.record({
  id: fc.oneof(fc.string({ maxLength: 12 }), fc.constantFrom("a", "b", "c", "")),
  name: text,
  tools: fc.uniqueArray(fc.record({ name: text }), { selector: tool => tool.name, maxLength: 8 }),
});
const servers = fc.uniqueArray(server, { selector: item => item.id, maxLength: 5 });
const total = list => list.reduce((count, item) => count + item.tools.length, 0);

test("every produced tool name is a valid provider tool name, unique ignoring case, one per tool", () => {
  assertProperty(servers, list => {
    const names = externalToolNames(list);
    assert.equal(names.size, total(list));
    const values = [...names.values()];
    for (const name of values) assert.match(name, PATTERN);
    assert.equal(new Set(values.map(name => name.toLowerCase())).size, values.length);
    for (const item of list) for (const tool of item.tools) assert.ok(names.has(`${item.id}\u0000${tool.name}`));
  });
});

test("the mapping is deterministic and does not depend on the order of a server's tools", () => {
  assertProperty(servers, list => {
    const first = externalToolNames(list);
    assert.deepEqual([...externalToolNames(structuredClone(list))], [...first]);
    // A saved transcript replays names, so a reordered tools/list must not move them.
    const reversed = list.map(item => ({ ...item, tools: [...item.tools].reverse() }));
    assert.deepEqual([...externalToolNames(reversed)].sort(), [...first].sort());
  });
});
