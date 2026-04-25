/**
 * Integration tests for the skill HTTP routes — proxy through index.ts
 * into the UserControl DO. Verifies CRUD wiring end-to-end so a
 * regression in the routing or DO schema gets caught.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env } from "../src/types";

vi.mock("../src/executor", () => ({
  runSandboxedCode: vi.fn().mockResolvedValue({ logs: [], result: null }),
}));
vi.mock("../src/agentic", async () => await import("./helpers/agentic-mock"));
vi.mock("../src/notify", () => ({ sendNotification: vi.fn() }));

import worker from "../src/index";

const BASE_URL = "https://dodo.example";

async function fetchJson(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, init), env as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("skill HTTP routes", () => {
  beforeAll(async () => {
    // Warm: tolerate DO invalidation between test files.
    for (let i = 0; i < 3; i++) {
      const res = await fetchJson("/health");
      if (res.status === 200) break;
    }
  });

  it("POST /api/skills creates a personal skill", async () => {
    const res = await fetchJson("/api/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "test-create",
        description: "Created via test",
        body: "# Body\n\nfor test-create",
      }),
    });
    expect(res.status).toBe(201);
    const skill = (await res.json()) as { name: string; description: string; enabled: boolean; source: string };
    expect(skill.name).toBe("test-create");
    expect(skill.description).toBe("Created via test");
    expect(skill.enabled).toBe(true);
    expect(skill.source).toBe("personal");
  });

  it("GET /api/skills lists personal skills", async () => {
    const res = await fetchJson("/api/skills");
    expect(res.status).toBe(200);
    const { skills } = (await res.json()) as { skills: Array<{ name: string }> };
    expect(skills.some((s) => s.name === "test-create")).toBe(true);
  });

  it("GET /api/skills/:name returns one skill by name", async () => {
    const res = await fetchJson("/api/skills/test-create");
    expect(res.status).toBe(200);
    const skill = (await res.json()) as { name: string; body: string };
    expect(skill.name).toBe("test-create");
    expect(skill.body).toContain("# Body");
  });

  it("GET /api/skills/:name returns 404 for missing skill", async () => {
    const res = await fetchJson("/api/skills/never-exists");
    expect(res.status).toBe(404);
  });

  it("PUT /api/skills/:name updates an existing skill", async () => {
    const res = await fetchJson("/api/skills/test-create", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "test-create",
        description: "Updated description",
        body: "# New body",
      }),
    });
    expect(res.status).toBe(200);
    const skill = (await res.json()) as { description: string; body: string };
    expect(skill.description).toBe("Updated description");
    expect(skill.body).toContain("# New body");
  });

  it("PUT /api/skills/:name/enabled toggles enabled flag", async () => {
    const offRes = await fetchJson("/api/skills/test-create/enabled", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(offRes.status).toBe(200);

    const verify = await fetchJson("/api/skills/test-create");
    const skill = (await verify.json()) as { enabled: boolean };
    expect(skill.enabled).toBe(false);

    const onRes = await fetchJson("/api/skills/test-create/enabled", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(onRes.status).toBe(200);
  });

  it("GET /api/skills?enabled=true filters out disabled skills", async () => {
    // Create a disabled skill
    await fetchJson("/api/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "test-disabled",
        description: "Disabled by default",
        body: "body",
        enabled: false,
      }),
    });

    const res = await fetchJson("/api/skills?enabled=true");
    const { skills } = (await res.json()) as { skills: Array<{ name: string }> };
    expect(skills.some((s) => s.name === "test-disabled")).toBe(false);

    // cleanup
    await fetchJson("/api/skills/test-disabled", { method: "DELETE" });
  });

  it("DELETE /api/skills/:name removes the skill", async () => {
    const res = await fetchJson("/api/skills/test-create", { method: "DELETE" });
    expect(res.status).toBe(200);
    const verify = await fetchJson("/api/skills/test-create");
    expect(verify.status).toBe(404);
  });

  it("rejects skill names with bad characters", async () => {
    const res = await fetchJson("/api/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "BAD NAME!",
        description: "x",
        body: "y",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects descriptions over 1024 chars", async () => {
    const res = await fetchJson("/api/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "test-long",
        description: "x".repeat(2000),
        body: "y",
      }),
    });
    expect(res.status).toBe(400);
  });
});
