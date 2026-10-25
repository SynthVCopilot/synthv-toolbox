import { fc } from "./props.mjs";

const SUPPORTED_KEYS = new Set(["type", "properties", "required", "additionalProperties", "enum", "description", "items", "title", "default"]);

/**
 * Arbitrary of values valid for a tool input schema, covering only the constructs our tool schemas use. Anything else
 * throws, so a schema that starts using a new construct fails here instead of being silently under-tested.
 */
export function arbitraryFor(schema, path = "$") {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) throw new Error(`${path}: schema must be an object`);
  for (const key of Object.keys(schema)) if (!SUPPORTED_KEYS.has(key)) throw new Error(`${path}: unsupported schema keyword "${key}"`);
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) throw new Error(`${path}: enum must be a non-empty array`);
    return fc.constantFrom(...schema.enum);
  }
  switch (schema.type) {
    case "string": return fc.string();
    case "number": return fc.double({ noNaN: true, noDefaultInfinity: true });
    case "integer": return fc.integer();
    case "boolean": return fc.boolean();
    case "array": return fc.array(schema.items ? arbitraryFor(schema.items, `${path}[]`) : fc.jsonValue(), { maxLength: 4 });
    case "object": {
      const properties = schema.properties ?? {};
      const required = schema.required ?? [];
      for (const name of required) if (!(name in properties)) throw new Error(`${path}: required "${name}" is not a declared property`);
      const model = Object.fromEntries(Object.entries(properties).map(([name, child]) => [name, arbitraryFor(child, `${path}.${name}`)]));
      const base = fc.record(model, { requiredKeys: required });
      return schema.additionalProperties === false ? base : fc.tuple(base, fc.dictionary(fc.string({ minLength: 1 }).filter(key => !(key in properties)), fc.jsonValue(), { maxKeys: 2 })).map(([known, extra]) => ({ ...extra, ...known }));
    }
    default: throw new Error(`${path}: unsupported schema type ${JSON.stringify(schema.type)}`);
  }
}
