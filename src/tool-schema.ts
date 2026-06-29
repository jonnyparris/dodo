/**
 * Tool JSON Schema sanitiser.
 *
 * Third-party MCP servers (gatekeeper + OAuth-federated) hand us tool
 * `inputSchema` objects that we forward verbatim to the model provider as the
 * tool's `parameters`. We do not control those schemas, and some are invalid
 * under JSON Schema draft 2020-12.
 *
 * Most providers ignore the malformed bits. Some — notably the Workers AI
 * OpenAI-compatible endpoint behind the AI Gateway (e.g. `@cf/zai-org/glm-5.2`)
 * — validate the ENTIRE tool list against the strict 2020-12 metaschema and
 * reject the whole request with HTTP 400 if any single tool is malformed:
 *
 *   AiError: Tool 26 function has invalid 'parameters' schema:
 *   ['steps'] is not of type 'object', 'boolean'
 *   On schema['properties']['required']: ['steps']
 *
 * The pathology there: a `properties.<key>` value that is not a valid
 * subschema (i.e. not an object and not a boolean). One bad MCP tool takes
 * out every prompt for that session — no assistant turn is produced at all.
 *
 * This module defensively normalises a tool schema so it is always a valid
 * 2020-12 object schema before it reaches the provider. The goal is
 * permissiveness, not correctness: when a node can't be salvaged we coerce it
 * to the "accept anything" schema (`{}`) and let the downstream MCP server do
 * its own argument validation. We never throw — a sanitiser that can fail is
 * just another way to 400 the request.
 */

/** Depth ceiling. Guards against pathological / cyclic schemas. Past this we
 *  collapse to the permissive empty schema. Real tool schemas are shallow. */
const MAX_DEPTH = 40;

type JsonSchemaObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonSchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A valid JSON Schema subschema is either an object or a boolean. Anything
 * else (array, string, number, null) in a schema position is invalid and is
 * what trips strict validators.
 */
function isValidSubschema(value: unknown): value is JsonSchemaObject | boolean {
  return isPlainObject(value) || typeof value === "boolean";
}

/** Keywords whose value is a single subschema. */
const SUBSCHEMA_KEYS = [
  "items",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
  "additionalItems",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;

/** Keywords whose value is an array of subschemas. */
const SUBSCHEMA_ARRAY_KEYS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;

/** Keywords whose value is a map of name -> subschema. */
const SUBSCHEMA_MAP_KEYS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
] as const;

/**
 * Sanitise a single subschema node (object form). Returns a new object — the
 * input is never mutated. Caller guarantees `node` is a plain object.
 */
function sanitiseNode(node: JsonSchemaObject, depth: number): JsonSchemaObject {
  if (depth >= MAX_DEPTH) return {};

  const out: JsonSchemaObject = {};

  for (const [key, value] of Object.entries(node)) {
    // Map-of-subschema keywords: every VALUE must be a valid subschema.
    // This is the exact failure mode we saw — a `properties.steps` that was
    // an array instead of a schema. Repair invalid entries to `{}`.
    if ((SUBSCHEMA_MAP_KEYS as readonly string[]).includes(key)) {
      if (!isPlainObject(value)) {
        // The whole map is malformed; drop it rather than emit junk.
        continue;
      }
      const cleanedMap: JsonSchemaObject = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        if (typeof propSchema === "boolean") {
          cleanedMap[propName] = propSchema;
        } else if (isPlainObject(propSchema)) {
          cleanedMap[propName] = sanitiseNode(propSchema, depth + 1);
        } else {
          // Non-object, non-boolean (array/string/number/null) in a schema
          // position — the strict-validator killer. Coerce to "accept any".
          cleanedMap[propName] = {};
        }
      }
      out[key] = cleanedMap;
      continue;
    }

    // Single-subschema keywords: value must be a valid subschema.
    if ((SUBSCHEMA_KEYS as readonly string[]).includes(key)) {
      if (typeof value === "boolean") {
        out[key] = value;
      } else if (isPlainObject(value)) {
        out[key] = sanitiseNode(value, depth + 1);
      } else if (Array.isArray(value) && key === "items") {
        // Legacy draft tuple form: `items: [schema, schema]`. Keep it as a
        // tuple of sanitised subschemas; invalid entries become `{}`.
        out[key] = value.map((entry) =>
          isValidSubschema(entry)
            ? typeof entry === "boolean"
              ? entry
              : sanitiseNode(entry as JsonSchemaObject, depth + 1)
            : {},
        );
      }
      // else: drop the malformed keyword entirely.
      continue;
    }

    // Array-of-subschema keywords (allOf/anyOf/oneOf/prefixItems).
    if ((SUBSCHEMA_ARRAY_KEYS as readonly string[]).includes(key)) {
      if (!Array.isArray(value)) continue;
      const cleaned = value
        .filter(isValidSubschema)
        .map((entry) =>
          typeof entry === "boolean" ? entry : sanitiseNode(entry as JsonSchemaObject, depth + 1),
        );
      // An empty combinator array (`anyOf: []`) is itself invalid; drop it.
      if (cleaned.length > 0) out[key] = cleaned;
      continue;
    }

    // additionalProperties is special: boolean OR subschema.
    if (key === "additionalProperties") {
      if (typeof value === "boolean") {
        out[key] = value;
      } else if (isPlainObject(value)) {
        out[key] = sanitiseNode(value, depth + 1);
      }
      // else drop
      continue;
    }

    // Everything else (type, description, enum, required, format, const,
    // minimum, etc.) passes through untouched. These are leaf metadata, not
    // subschema positions, so they can't carry the malformed-schema pathology.
    out[key] = value;
  }

  return out;
}

/**
 * Sanitise a tool's `inputSchema` / `parameters` into a JSON Schema that is
 * valid under draft 2020-12. Always returns a plain object schema suitable as
 * a tool `parameters` value.
 *
 * - Non-object roots (boolean, array, null, primitive) collapse to a
 *   permissive empty object schema.
 * - Invalid subschema positions anywhere in the tree are repaired or dropped.
 * - The input is never mutated.
 */
export function sanitizeToolJsonSchema(schema: unknown): JsonSchemaObject {
  if (!isPlainObject(schema)) {
    // A bare `true` schema is valid JSON Schema but a tool's top-level
    // parameters should be an object schema; an array/primitive/null root is
    // outright invalid. Either way, fall back to "accept any object".
    return { type: "object", properties: {} };
  }
  return sanitiseNode(schema, 0);
}
