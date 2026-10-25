import assert from "node:assert/strict";
import test from "node:test";
import { compiled } from "../_lib/load.mjs";
import { assertProperty, fc } from "../_lib/props.mjs";

const { toolParameters, MAX_SCHEMA_DEPTH } = await compiled("services/external-mcp-tools.js");
const COMBINATORS = ["oneOf", "anyOf", "allOf"];
const PERMISSIVE = { type: "object", properties: {}, additionalProperties: true };
const isRecord = value => typeof value === "object" && value !== null && !Array.isArray(value);

const pointer = fc.constantFrom("#", "#/$defs/a", "#/definitions/a", "#/properties/p", "#/anyOf/0", "#/missing", "http://example.test/s.json", "#/$defs/a/properties/p");
const schemaKeys = ["type", "properties", "items", "oneOf", "anyOf", "allOf", "$ref", "$defs", "definitions", "required", "additionalProperties", "description", "enum", "not", "if"];
// Schema-shaped values with every combinator and reference form servers send, plus arbitrary JSON in each slot.
const { schema } = fc.letrec(tie => ({
  schema: fc.oneof({ depthSize: "small" },
    fc.jsonValue({ maxDepth: 2 }),
    fc.dictionary(fc.constantFrom(...schemaKeys), tie("value"), { maxKeys: 6 }),
    fc.record({ type: fc.constantFrom("object", "string", "array", "number"), properties: fc.dictionary(fc.string({ maxLength: 4 }), tie("schema"), { maxKeys: 3 }), required: fc.array(fc.string({ maxLength: 4 }), { maxLength: 3 }) }, { requiredKeys: [] }),
    fc.record({ $ref: pointer, $defs: fc.dictionary(fc.constantFrom("a", "b"), tie("schema"), { maxKeys: 2 }) }, { requiredKeys: ["$ref"] }),
  ),
  value: fc.oneof({ depthSize: "small" }, tie("schema"), fc.array(tie("schema"), { maxLength: 3 }), pointer, fc.string({ maxLength: 4 }), fc.boolean()),
}));

/** Same measure as the implementation: nesting levels of objects and arrays, counted from the root at 0. */
function depth(value) {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(depth));
  if (isRecord(value)) return 1 + Math.max(0, ...Object.values(value).map(depth));
  return 0;
}

test("toolParameters never throws and always returns a flat object schema, whatever the server sent", () => {
  assertProperty(fc.oneof(schema, fc.anything()), input => {
    const result = toolParameters(input);
    assert.ok(isRecord(result));
    assert.equal(result.type, "object");
    // The Anthropic API rejects a top-level oneOf, anyOf or allOf, which would fail the whole session.
    for (const key of COMBINATORS) assert.ok(!(key in result), `top-level ${key} survived`);
    assert.ok(!("$ref" in result), "top-level $ref survived");
    if ("properties" in result) assert.ok(isRecord(result.properties), "properties must be an object when present");
    assert.doesNotThrow(() => JSON.stringify(result));
  });
});

test("schemas nested deeper than MAX_SCHEMA_DEPTH become a permissive object, shallower ones are not replaced wholesale", () => {
  const nested = levels => { let node = { type: "string" }; for (let level = 0; level < levels; level++) node = { type: "object", properties: { p: node } }; return node; };
  assertProperty(fc.integer({ min: 1, max: MAX_SCHEMA_DEPTH * 3 }), levels => {
    const input = nested(levels);
    const result = toolParameters(input);
    if (depth(input) > MAX_SCHEMA_DEPTH) assert.deepEqual(result, PERMISSIVE);
    else assert.ok(isRecord(result.properties) && "p" in result.properties);
  });
});

test("a hostile nesting depth does not exhaust the stack", () => {
  let node = {};
  for (let level = 0; level < 200_000; level++) node = { properties: { p: node } };
  assert.deepEqual(toolParameters(node), PERMISSIVE);
  let array = [];
  for (let level = 0; level < 200_000; level++) array = [array];
  assert.deepEqual(toolParameters({ anyOf: array }), PERMISSIVE);
});

test("the result is deterministic and generated schemas past the bound are replaced", () => {
  assertProperty(schema, input => {
    assert.equal(JSON.stringify(toolParameters(input)), JSON.stringify(toolParameters(structuredClone(input))));
    if (depth(input) > MAX_SCHEMA_DEPTH) assert.deepEqual(toolParameters(input), PERMISSIVE);
  });
});
