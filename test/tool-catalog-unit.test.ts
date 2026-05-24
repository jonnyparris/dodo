/**
 * Unit tests for the static tool catalog and the merged skills endpoint.
 *
 * These exist mainly to catch drift:
 *   - tool-catalog should always have at least the core file ops
 *   - every entry must have a non-empty name and description
 *   - the system prompt's tool table is the canonical surface; this
 *     catalog mirrors it for the UI
 */
import { describe, expect, it } from "vitest";
import {
  getOrchestratorToolCatalog,
  getSubagentToolCatalog,
} from "../src/tool-catalog";

describe("tool-catalog", () => {
  it("returns a non-empty orchestrator catalog with required core tools", () => {
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

  it("subagent catalog is read-only", () => {
    const tools = getSubagentToolCatalog();
    // explore subagent surface is intentionally read-only — no `write`/`edit`.
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("read")).toBe(true);
    expect(names.has("write")).toBe(false);
    expect(names.has("edit")).toBe(false);
  });

  it("does not duplicate tool names", () => {
    const tools = getOrchestratorToolCatalog();
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
