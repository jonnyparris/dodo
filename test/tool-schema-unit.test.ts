/**
 * Unit tests for the tool JSON Schema sanitiser (src/tool-schema.ts).
 *
 * The headline case is the real production failure: a third-party MCP tool
 * whose `properties.steps` was not a valid subschema, which made the Workers
 * AI glm-5.2 endpoint 400 the entire request. The sanitiser must repair that
 * in place while leaving well-formed schemas semantically intact.
 */
import { describe, expect, it } from "vitest";
import { sanitizeToolJsonSchema } from "../src/tool-schema";

describe("sanitizeToolJsonSchema", () => {
  it("repairs the production pathology: a non-object value in properties", () => {
    // properties.steps is an array, not a subschema. This is what tripped the
    // strict 2020-12 validator: "['steps'] is not of type 'object', 'boolean'".
    const bad = {
      type: "object",
      properties: {
        steps: ["steps"],
      },
      required: ["steps"],
    };
    const out = sanitizeToolJsonSchema(bad);
    expect(out.type).toBe("object");
    expect((out.properties as Record<string, unknown>).steps).toEqual({});
    // required is leaf metadata and is preserved verbatim.
    expect(out.required).toEqual(["steps"]);
  });

  it("leaves a well-formed schema structurally intact", () => {
    const good = {
      type: "object",
      properties: {
        name: { type: "string", description: "A name" },
        count: { type: "number", minimum: 0 },
      },
      required: ["name"],
      additionalProperties: false,
    };
    expect(sanitizeToolJsonSchema(good)).toEqual(good);
  });

  it("coerces a non-object root to a permissive object schema", () => {
    expect(sanitizeToolJsonSchema(null)).toEqual({ type: "object", properties: {} });
    expect(sanitizeToolJsonSchema(undefined)).toEqual({ type: "object", properties: {} });
    expect(sanitizeToolJsonSchema(["nope"])).toEqual({ type: "object", properties: {} });
    expect(sanitizeToolJsonSchema("string")).toEqual({ type: "object", properties: {} });
    expect(sanitizeToolJsonSchema(true)).toEqual({ type: "object", properties: {} });
  });

  it("preserves boolean subschemas in properties", () => {
    const schema = {
      type: "object",
      properties: {
        anything: true,
        nothing: false,
      },
    };
    const out = sanitizeToolJsonSchema(schema);
    expect((out.properties as Record<string, unknown>).anything).toBe(true);
    expect((out.properties as Record<string, unknown>).nothing).toBe(false);
  });

  it("recurses into nested properties and repairs deep invalid nodes", () => {
    const schema = {
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: {
            inner: 42, // invalid subschema
            valid: { type: "string" },
          },
        },
      },
    };
    const out = sanitizeToolJsonSchema(schema);
    const outer = (out.properties as Record<string, unknown>).outer as Record<string, unknown>;
    const innerProps = outer.properties as Record<string, unknown>;
    expect(innerProps.inner).toEqual({});
    expect(innerProps.valid).toEqual({ type: "string" });
  });

  it("sanitises array-of-subschema keywords and drops invalid entries", () => {
    const schema = {
      anyOf: [{ type: "string" }, "garbage", { type: "number" }],
    };
    const out = sanitizeToolJsonSchema(schema);
    expect(out.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
  });

  it("drops an empty combinator array produced by filtering", () => {
    const schema = { type: "object", oneOf: [123, "bad"] };
    const out = sanitizeToolJsonSchema(schema);
    expect(out.oneOf).toBeUndefined();
    expect(out.type).toBe("object");
  });

  it("handles additionalProperties as both boolean and subschema", () => {
    expect(sanitizeToolJsonSchema({ additionalProperties: true }).additionalProperties).toBe(true);
    expect(
      sanitizeToolJsonSchema({ additionalProperties: { type: "string" } }).additionalProperties,
    ).toEqual({ type: "string" });
    // invalid additionalProperties is dropped
    expect(
      sanitizeToolJsonSchema({ additionalProperties: ["x"] }).additionalProperties,
    ).toBeUndefined();
  });

  it("repairs invalid items while keeping valid object and tuple forms", () => {
    expect(sanitizeToolJsonSchema({ type: "array", items: { type: "string" } }).items).toEqual({
      type: "string",
    });
    // legacy tuple form with an invalid entry
    const tuple = sanitizeToolJsonSchema({ type: "array", items: [{ type: "string" }, 7] });
    expect(tuple.items).toEqual([{ type: "string" }, {}]);
    // scalar items value is invalid → dropped
    expect(sanitizeToolJsonSchema({ type: "array", items: 5 }).items).toBeUndefined();
  });

  it("drops a malformed properties map that isn't an object", () => {
    const out = sanitizeToolJsonSchema({ type: "object", properties: ["a", "b"] });
    expect(out.properties).toBeUndefined();
    expect(out.type).toBe("object");
  });

  it("does not mutate the input", () => {
    const input = { type: "object", properties: { steps: ["steps"] } };
    const snapshot = JSON.parse(JSON.stringify(input));
    sanitizeToolJsonSchema(input);
    expect(input).toEqual(snapshot);
  });

  it("survives deeply nested schemas without throwing", () => {
    // Build a 60-deep nested-properties chain (past MAX_DEPTH).
    let node: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 60; i++) {
      node = { type: "object", properties: { child: node } };
    }
    expect(() => sanitizeToolJsonSchema(node)).not.toThrow();
  });

  it("preserves $defs/definitions subschema maps and repairs bad entries", () => {
    const schema = {
      type: "object",
      $defs: {
        Good: { type: "string" },
        Bad: 99,
      },
    };
    const out = sanitizeToolJsonSchema(schema);
    const defs = out.$defs as Record<string, unknown>;
    expect(defs.Good).toEqual({ type: "string" });
    expect(defs.Bad).toEqual({});
  });
});
