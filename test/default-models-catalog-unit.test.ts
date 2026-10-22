/**
 * The model defaults in every wrangler config must be catalog models. An id
 * missing from the catalog silently gets DEFAULT_CONTEXT_WINDOW (128k) for
 * the session details and for pi's compaction, and no price (2026-10:
 * DEFAULT_MODEL was `anthropic/claude-sonnet-4`, which the catalog doesn't
 * list).
 */
import { describe, expect, it } from "vitest";
import { FALLBACK_MODELS, WORKERS_AI_MODELS } from "../src/model-catalog";
import prod from "../wrangler.jsonc?raw";
import dev from "../wrangler.dev.jsonc?raw";
import preview from "../wrangler.preview.jsonc?raw";

const CATALOG_IDS = new Set([...FALLBACK_MODELS, ...WORKERS_AI_MODELS].map((m) => m.id));
const MODEL_VARS = ["DEFAULT_MODEL", "AI_GATEWAY_DEFAULT_MODEL", "DEFAULT_EXPLORE_MODEL", "DEFAULT_TASK_MODEL"];

function modelVars(source: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const name of MODEL_VARS) {
    for (const m of source.matchAll(new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`, "g"))) out.push([name, m[1]!]);
  }
  return out;
}

describe("wrangler model defaults", () => {
  it.each([["wrangler.jsonc", prod], ["wrangler.dev.jsonc", dev], ["wrangler.preview.jsonc", preview]] as const)(
    "%s only names catalog models",
    (_file, source) => {
      const vars = modelVars(source);
      expect(vars.map(([name]) => name)).toContain("DEFAULT_MODEL");
      for (const [name, id] of vars) expect({ name, id, inCatalog: CATALOG_IDS.has(id) }).toEqual({ name, id, inCatalog: true });
    },
  );
});
