/**
 * Unit tests for the static tool catalog. The catalog (src/tool-catalog.ts)
 * is what the UI shows the user; the canonical name sets in src/agentic.ts
 * (KNOWN_ALWAYS_ON_TOOL_NAMES, KNOWN_CONDITIONAL_TOOL_NAMES,
 * KNOWN_CODEMODE_GIT_TOOLS) describe what `buildTools()` actually registers.
 *
 * These tests cross-check the two so a tool added or removed in agentic.ts
 * without a matching catalog update fails the build. That's the
 * "drift detection" the comment in tool-catalog.ts promises.
 */
import { describe, expect, it } from "vitest";
import {
  CODEMODE_GIT_CAVEAT,
  getOrchestratorToolCatalog,
} from "../src/tool-catalog";
import {
  KNOWN_ALWAYS_ON_TOOL_NAMES,
  KNOWN_CODEMODE_GIT_TOOLS,
  KNOWN_CONDITIONAL_TOOL_NAMES,
  KNOWN_TOP_LEVEL_GIT_TOOLS,
} from "../src/agentic";

describe("tool-catalog static catalog", () => {
  it("returns a non-empty catalog with required core tools", () => {
    const tools = getOrchestratorToolCatalog();
    expect(tools.length).toBeGreaterThan(10);
    const names = new Set(tools.map((t) => t.name));
    for (const required of ["explore", "task", "read", "write", "edit", "grep", "todo_add", "skill", "git_commit"]) {
      expect(names.has(required), `missing required tool '${required}'`).toBe(true);
    }
  });

  it("every entry has a non-empty name, description, and category", () => {
    for (const t of getOrchestratorToolCatalog()) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.category).toBeTruthy();
      expect(typeof t.alwaysOn).toBe("boolean");
    }
  });

  it("does not duplicate tool names", () => {
    const tools = getOrchestratorToolCatalog();
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("does not include workspace tools that are stripped at the top level", () => {
    // `list` and `find` are removed in agentic.ts:1238 — they fill the
    // context window with raw listings. The catalog must NOT advertise them
    // as top-level orchestrator tools.
    const names = new Set(getOrchestratorToolCatalog().map((t) => t.name));
    expect(names.has("list")).toBe(false);
    expect(names.has("find")).toBe(false);
  });
});

describe("tool-catalog ↔ agentic.ts drift detection", () => {
  it("every alwaysOn:true catalog entry is in KNOWN_ALWAYS_ON_TOOL_NAMES", () => {
    const knownAlwaysOn = new Set<string>(KNOWN_ALWAYS_ON_TOOL_NAMES);
    const catalogAlwaysOn = getOrchestratorToolCatalog().filter((t) => t.alwaysOn);
    for (const t of catalogAlwaysOn) {
      expect(
        knownAlwaysOn.has(t.name),
        `Catalog declares '${t.name}' as alwaysOn:true but agentic.ts does not list it in KNOWN_ALWAYS_ON_TOOL_NAMES. Add it there or change the catalog entry.`,
      ).toBe(true);
    }
  });

  it("every KNOWN_ALWAYS_ON_TOOL_NAMES entry has a catalog entry", () => {
    const catalogNames = new Set(getOrchestratorToolCatalog().map((t) => t.name));
    for (const name of KNOWN_ALWAYS_ON_TOOL_NAMES) {
      expect(
        catalogNames.has(name),
        `agentic.ts lists '${name}' as always-on but src/tool-catalog.ts does not include it. Add a catalog entry for the UI.`,
      ).toBe(true);
    }
  });

  it("every catalog entry tagged with CODEMODE_GIT_CAVEAT is in KNOWN_CODEMODE_GIT_TOOLS", () => {
    const knownCodemodeGit = new Set<string>(KNOWN_CODEMODE_GIT_TOOLS);
    const codemodeGitEntries = getOrchestratorToolCatalog().filter(
      (t) => t.caveat === CODEMODE_GIT_CAVEAT,
    );
    expect(codemodeGitEntries.length).toBeGreaterThan(0);
    for (const t of codemodeGitEntries) {
      expect(
        knownCodemodeGit.has(t.name),
        `Catalog tags '${t.name}' as codemode-only but agentic.ts does not list it in KNOWN_CODEMODE_GIT_TOOLS.`,
      ).toBe(true);
      // Codemode-only git tools must be alwaysOn:false — the orchestrator
      // can't call them directly, only inside a codemode block.
      expect(
        t.alwaysOn,
        `Catalog entry '${t.name}' is codemode-only but alwaysOn:true. Set alwaysOn:false.`,
      ).toBe(false);
    }
  });

  it("every KNOWN_CODEMODE_GIT_TOOLS entry has a catalog entry", () => {
    const catalogNames = new Set(getOrchestratorToolCatalog().map((t) => t.name));
    for (const name of KNOWN_CODEMODE_GIT_TOOLS) {
      expect(
        catalogNames.has(name),
        `agentic.ts lists '${name}' as a codemode-only git tool but it is missing from src/tool-catalog.ts.`,
      ).toBe(true);
    }
  });

  it("every catalog entry is in exactly one of the known name sets", () => {
    const allKnown = new Set<string>([
      ...KNOWN_ALWAYS_ON_TOOL_NAMES,
      ...KNOWN_CONDITIONAL_TOOL_NAMES,
      ...KNOWN_CODEMODE_GIT_TOOLS,
    ]);
    for (const t of getOrchestratorToolCatalog()) {
      expect(
        allKnown.has(t.name),
        `Catalog declares '${t.name}' but agentic.ts does not list it in any KNOWN_*_TOOL_NAMES set.`,
      ).toBe(true);
    }
  });

  it("hot-path git tools are alwaysOn:true and match KNOWN_TOP_LEVEL_GIT_TOOLS", () => {
    const topLevelGit = new Set<string>(KNOWN_TOP_LEVEL_GIT_TOOLS);
    const catalog = getOrchestratorToolCatalog();
    for (const name of topLevelGit) {
      const entry = catalog.find((t) => t.name === name);
      expect(entry, `missing catalog entry for top-level git tool '${name}'`).toBeDefined();
      expect(entry?.alwaysOn).toBe(true);
      expect(entry?.caveat).toBeUndefined();
    }
  });
});
