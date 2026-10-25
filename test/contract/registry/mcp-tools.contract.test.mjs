import assert from "node:assert/strict";
import test from "node:test";
import { arbitraryFor } from "../_lib/arb.mjs";
import { compiled } from "../_lib/load.mjs";
import { assertProperty, fc } from "../_lib/props.mjs";

const { TOOLBOX_OPERATIONS, hostResultToToolResult, toStructuredContent, toToolContent, toolboxAgentMcpTool, toolboxMcpTools } = await compiled("services/mcp-tools.js");

// Everything tools/list can return: the permission-gated toolbox tools plus the agent tool.
const tools = [...toolboxMcpTools(Object.keys(TOOLBOX_OPERATIONS)), toolboxAgentMcpTool()];
const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const isPlainObject = value => typeof value === "object" && value !== null && !Array.isArray(value);

test("the tool table is not empty and covers every permission tier", () => {
  assert.ok(tools.length >= 3);
  assert.deepEqual(toolboxMcpTools(Object.keys(TOOLBOX_OPERATIONS)).map(tool => tool.name), Object.keys(TOOLBOX_OPERATIONS));
});

test("tool names are valid provider tool names and unique", () => {
  const names = tools.map(tool => tool.name);
  for (const name of names) assert.match(name, NAME);
  assert.equal(new Set(names.map(name => name.toLowerCase())).size, names.length);
});

for (const tool of tools) {
  test(`${tool.name}: description, annotations and a flat object input schema`, () => {
    assert.ok(typeof tool.description === "string" && tool.description.trim().length > 0, "description");
    if (tool.title !== undefined) assert.ok(typeof tool.title === "string" && tool.title.trim());
    const schema = tool.inputSchema;
    assert.equal(schema.type, "object");
    // The Anthropic API rejects a top-level oneOf, anyOf or allOf in input_schema.
    for (const key of ["oneOf", "anyOf", "allOf", "not", "$ref", "enum"]) assert.ok(!(key in schema), `top-level ${key} is rejected by tool input_schema`);
    if (schema.properties !== undefined) assert.ok(isPlainObject(schema.properties));
    for (const required of schema.required ?? []) assert.ok(required in (schema.properties ?? {}), `required "${required}" is not a declared property`);
    for (const [key, hint] of Object.entries(tool.annotations ?? {})) {
      if (key === "title") assert.equal(typeof hint, "string");
      else assert.ok(["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].includes(key) && typeof hint === "boolean", `annotation ${key}`);
    }
    if (tool.annotations?.readOnlyHint === true) assert.notEqual(tool.annotations.destructiveHint, true);
    assert.doesNotThrow(() => JSON.stringify(tool));
  });

  test(`${tool.name}: arguments generated from the schema satisfy it`, () => {
    assertProperty(arbitraryFor(tool.inputSchema), args => {
      assert.ok(isPlainObject(args));
      for (const required of tool.inputSchema.required ?? []) assert.ok(required in args, `missing ${required}`);
      for (const [key, child] of Object.entries(tool.inputSchema.properties ?? {})) if (child.enum && key in args) assert.ok(child.enum.includes(args[key]), `${key} outside enum`);
      if (tool.inputSchema.additionalProperties === false) assert.deepEqual(Object.keys(args).filter(key => !(key in tool.inputSchema.properties)), []);
    });
  });
}

test("operations documented per capability match the schema enum and the description", () => {
  for (const tool of toolboxMcpTools(Object.keys(TOOLBOX_OPERATIONS))) {
    const capabilities = TOOLBOX_OPERATIONS[tool.name];
    assert.deepEqual(tool.inputSchema.properties.capability.enum, Object.keys(capabilities));
    for (const [capability, operations] of Object.entries(capabilities)) for (const operation of Object.keys(operations)) assert.ok(tool.description.includes(operation), `${tool.name} description omits ${capability}/${operation}`);
  }
});

test("unknown tool names produce no definitions", () => {
  assert.deepEqual(toolboxMcpTools(["toolbox_agent", "constructor", "__proto__"]), []);
});

test("the arbitrary mapper rejects schema constructs it does not model", () => {
  for (const schema of [{ type: "object", oneOf: [] }, { type: "object", properties: { a: { $ref: "#/x" } } }, { type: "null" }, { type: "object", properties: { a: { type: "string", pattern: "x" } } }]) {
    assert.throws(() => arbitraryFor(schema), /unsupported/);
  }
});

const isContentBlock = block => isPlainObject(block) && ((block.type === "text" && typeof block.text === "string")
  || ((block.type === "image" || block.type === "audio") && typeof block.data === "string" && typeof block.mimeType === "string")
  || (block.type === "resource_link" && typeof block.uri === "string" && typeof block.name === "string")
  || (block.type === "resource" && isPlainObject(block.resource) && typeof block.resource.uri === "string"));

test("any JSON host result becomes a tool result with a plain-object structuredContent and valid content", () => {
  assertProperty(fc.jsonValue(), value => {
    const result = hostResultToToolResult(value);
    // An array structuredContent was rejected by the official MCP SDK client.
    assert.ok(isPlainObject(result.structuredContent), "structuredContent must be a plain object");
    assert.ok(result.content.length > 0 && result.content.every(isContentBlock));
    assert.doesNotThrow(() => JSON.stringify(result));
  });
  for (const odd of [undefined, null, [], "", 0, false]) assert.ok(isPlainObject(hostResultToToolResult(odd).structuredContent));
});

test("toStructuredContent keeps objects intact and wraps everything else", () => {
  assertProperty(fc.jsonValue(), value => {
    const structured = toStructuredContent(value);
    assert.ok(isPlainObject(structured));
    if (isPlainObject(value)) assert.equal(structured, value);
    else assert.deepEqual(structured, { items: value });
  });
});

test("toToolContent always yields valid, non-empty content blocks", () => {
  const block = fc.oneof(
    fc.record({ type: fc.constant("text"), text: fc.string() }),
    fc.record({ type: fc.constantFrom("image", "audio"), data: fc.string(), mimeType: fc.string() }),
    fc.record({ type: fc.constant("resource_link"), uri: fc.string(), name: fc.string() }),
  );
  assertProperty(fc.oneof(fc.jsonValue(), fc.array(block), fc.array(fc.oneof(block, fc.jsonValue()))), content => {
    const blocks = toToolContent(content);
    assert.ok(Array.isArray(blocks) && blocks.length > 0 && blocks.every(isContentBlock));
  });
  assert.deepEqual(toToolContent(undefined).map(item => item.type), ["text"]);
});
