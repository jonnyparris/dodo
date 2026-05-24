/**
 * Integration tests for the new UI surfacing endpoints:
 *   - GET /api/skills/all  → merged personal + built-in skills
 *   - GET /api/tool-catalog → static orchestrator + subagent tool catalogs
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

  it("GET /api/tool-catalog returns orchestrator + subagent catalogs", async () => {
    const res = await fetchJson("/api/tool-catalog");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      orchestrator: Array<{ name: string; description: string; category: string }>;
      subagent: Array<{ name: string }>;
    };
    expect(body.orchestrator.length).toBeGreaterThan(10);
    expect(body.subagent.length).toBeGreaterThan(0);
    // Built-in tools we depend on
    const orchestrators = new Set(body.orchestrator.map((t) => t.name));
    for (const required of ["explore", "task", "read", "write", "edit", "skill"]) {
      expect(orchestrators.has(required)).toBe(true);
    }
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
});
