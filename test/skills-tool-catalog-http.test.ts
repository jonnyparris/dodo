/**
 * Integration tests for the new UI surfacing endpoints:
 *   - GET /api/skills/all  → merged personal + built-in skills
 *   - GET /api/tool-catalog → static orchestrator tool catalog
 *
 * These power the "Skills" and "Tools" sidebar panels.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env } from "../src/types";

vi.mock("@cloudflare/codemode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cloudflare/codemode")>();
  return {
    ...actual,
    DynamicWorkerExecutor: vi.fn(function () {
      return { execute: vi.fn().mockResolvedValue({ logs: [], result: null }) };
    }) as unknown as typeof import("@cloudflare/codemode").DynamicWorkerExecutor,
  };
});
vi.mock("../src/agentic", async () => await import("./helpers/agentic-mock"));
vi.mock("../src/notify", () => ({ dispatchNotification: vi.fn() }));

import worker from "../src/index";

const BASE_URL = "https://dodo.example";

async function fetchJson(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, init), env as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("UI surfacing: /api/skills/all and /api/tool-catalog", () => {
  beforeAll(async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetchJson("/health");
      if (res.status === 200) break;
    }
  });

  it("GET /api/tool-catalog returns the orchestrator catalog", async () => {
    const res = await fetchJson("/api/tool-catalog");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      orchestrator: Array<{ name: string; description: string; category: string; alwaysOn: boolean; caveat?: string }>;
    };
    expect(body.orchestrator.length).toBeGreaterThan(10);
    // Built-in tools we depend on
    const orchestrators = new Set(body.orchestrator.map((t) => t.name));
    for (const required of ["explore", "task", "read", "write", "edit", "skill"]) {
      expect(orchestrators.has(required)).toBe(true);
    }
    // Codemode-only git tools must be present and dimmed (alwaysOn:false)
    const gitClone = body.orchestrator.find((t) => t.name === "git_clone");
    expect(gitClone, "git_clone missing from catalog").toBeDefined();
    expect(gitClone?.alwaysOn).toBe(false);
    expect(gitClone?.caveat).toMatch(/codemode/i);
    // Stripped workspace tools must NOT appear
    expect(orchestrators.has("list")).toBe(false);
    expect(orchestrators.has("find")).toBe(false);
  });

  it("GET /api/skills/all merges personal + built-in", async () => {
    // Create a personal skill so the merged list has at least one of each.
    await fetchJson("/api/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "test-merged",
        description: "Used to assert /api/skills/all merges sources",
        body: "# body",
      }),
    });

    const res = await fetchJson("/api/skills/all");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skills: Array<{ name: string; description: string; source: "personal" | "builtin"; enabled: boolean }>;
    };
    expect(body.skills.length).toBeGreaterThan(0);
    const sources = new Set(body.skills.map((s) => s.source));
    expect(sources.has("builtin")).toBe(true);
    // The personal skill we just created must be in the list.
    expect(body.skills.some((s) => s.name === "test-merged" && s.source === "personal")).toBe(true);
    // No source we don't expect.
    for (const s of body.skills) {
      expect(["personal", "builtin"]).toContain(s.source);
    }
  });

  it("personal skill with same name as a built-in overrides the built-in", async () => {
    // `dodo-self` is one of the built-in skills (src/builtin-skills.ts). A
    // personal skill with the same name should completely replace it in the
    // merged list — that's the precedence the handler's personalNames Set
    // exists to enforce. Without this test, the override filter can be
    // deleted and the previous "merges sources" test still passes.
    const PERSONAL_DESC = "personal override of the built-in dodo-self for testing";
    await fetchJson("/api/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "dodo-self",
        description: PERSONAL_DESC,
        body: "# personal dodo-self body",
      }),
    });

    const res = await fetchJson("/api/skills/all");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skills: Array<{ name: string; description: string; source: "personal" | "builtin"; enabled: boolean }>;
    };
    const matches = body.skills.filter((s) => s.name === "dodo-self");
    expect(matches.length, "expected exactly one dodo-self entry after override").toBe(1);
    expect(matches[0].source).toBe("personal");
    expect(matches[0].description).toBe(PERSONAL_DESC);
  });

  it("personal block comes before builtin block in response order", async () => {
    // Mirrors mergeSkills() sort: personal entries (rank 0) appear before
    // builtin entries (rank 2). Inside each block, alphabetical.
    const res = await fetchJson("/api/skills/all");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skills: Array<{ name: string; source: "personal" | "builtin" }>;
    };
    let seenBuiltin = false;
    for (const s of body.skills) {
      if (s.source === "builtin") seenBuiltin = true;
      else if (seenBuiltin) {
        throw new Error(
          `Sort violation: personal skill '${s.name}' appeared AFTER a builtin entry. Expected personal block first.`,
        );
      }
    }
  });
});
