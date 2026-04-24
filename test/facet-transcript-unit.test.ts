/**
 * Facet transcripts (Phase 5).
 *
 * Exercises:
 *
 *   1. `runExploreFacet` records a `facet_runs` row on the parent,
 *      visible via `GET /session/:id/facets`.
 *   2. The facet records user + assistant messages in its own
 *      `assistant_messages` table, reachable via
 *      `GET /session/:id/facets/:facetName/transcript`.
 *   3. Non-existent facet names return 404.
 *
 * The model is mocked so the generateText path is deterministic and
 * produces a synthetic response the test can match on.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env, AppConfig } from "../src/types";

vi.mock("../src/executor", () => ({
  runSandboxedCode: vi.fn().mockResolvedValue({ logs: [], result: null }),
}));
vi.mock("../src/agentic", async () => await import("./helpers/agentic-mock"));
vi.mock("../src/notify", () => ({
  sendNotification: vi.fn(),
}));

import worker from "../src/index";

const BASE_URL = "https://dodo.example";

async function fetchJson(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, init), env as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function createSession(): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetchJson("/session", { method: "POST" });
    if (response.status === 201) {
      return ((await response.json()) as { id: string }).id;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Failed to create session");
}

function makeParentConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    activeGateway: "opencode",
    aiGatewayBaseURL: "https://mock-ai-gateway.example/v1",
    gitAuthorEmail: "dodo@example.com",
    gitAuthorName: "Dodo",
    model: "anthropic/claude-sonnet-4",
    opencodeBaseURL: "https://mock-opencode.example/v1",
    exploreMode: "facet",
    taskMode: "inprocess",
    ...overrides,
  };
}

describe("Facet transcripts — HTTP surface", () => {
  beforeAll(async () => {
    for (let i = 0; i < 5; i++) {
      try {
        await fetchJson("/health");
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  });

  it("runExploreFacet records a facet_runs row visible via GET /session/:id/facets", async () => {
    const sessionId = await createSession();
    const { getAgentByName } = await import("agents");
    const testEnv = env as Env;
    const parent = await getAgentByName(testEnv.CODING_AGENT as never, sessionId) as unknown as {
      runExploreFacet: (name: string, opts: { q: string; parentSessionId?: string; parentConfig?: AppConfig }) => Promise<{ ok: true; facetName: string; summary: string }>;
    };

    await parent.runExploreFacet("pool-explore-0", {
      q: "transcript-test-query-xyz",
      parentSessionId: sessionId,
      parentConfig: makeParentConfig(),
    });

    const response = await fetchJson(`/session/${sessionId}/facets`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { runs: Array<{ facetType: string; facetName: string; input: string; status: string }> };

    expect(body.runs.length).toBeGreaterThanOrEqual(1);
    const run = body.runs.find((r) => r.facetName === "pool-explore-0");
    expect(run).toBeDefined();
    expect(run!.facetType).toBe("explore");
    expect(run!.input).toContain("transcript-test-query-xyz");
    expect(run!.status).toBe("completed");
  });

  it("GET /session/:id/facets/:name/transcript returns the facet's message log", async () => {
    const sessionId = await createSession();
    const { getAgentByName } = await import("agents");
    const testEnv = env as Env;
    const parent = await getAgentByName(testEnv.CODING_AGENT as never, sessionId) as unknown as {
      runExploreFacet: (name: string, opts: { q: string; parentSessionId?: string; parentConfig?: AppConfig }) => Promise<{ ok: true; facetName: string; summary: string }>;
    };

    await parent.runExploreFacet("pool-explore-txn", {
      q: "something distinctive xyz-777",
      parentSessionId: sessionId,
      parentConfig: makeParentConfig(),
    });

    const response = await fetchJson(`/session/${sessionId}/facets/pool-explore-txn/transcript`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { facetType: string; messages: Array<{ role: string; content: string }> };

    expect(body.facetType).toBe("explore");
    expect(body.messages.length).toBeGreaterThanOrEqual(2);
    const userMsg = body.messages.find((m) => m.role === "user");
    const assistantMsg = body.messages.find((m) => m.role === "assistant");
    expect(userMsg?.content).toContain("xyz-777");
    expect(assistantMsg?.content).toContain("Explore results");
  });

  it("unknown facet name returns 404", async () => {
    const sessionId = await createSession();

    const response = await fetchJson(`/session/${sessionId}/facets/does-not-exist/transcript`);
    expect(response.status).toBe(404);
  });
});
