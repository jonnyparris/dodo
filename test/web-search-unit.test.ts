import { describe, expect, it, vi } from "vitest";
import { isWebSearchEnabled } from "../src/agentic";
import { adaptTool, modelOutputToContent } from "../src/pi/tools";
import type { Env } from "../src/types";
import {
  createWebSearchTool,
  hasWebSearch,
  parseWebSearchProvider,
  type DodoWebSearchOutput,
  type WebSearchAi,
} from "../src/web-search";

function fakeAi(response: Response | Error) {
  const websearch = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return { ai: { websearch } as WebSearchAi, websearch };
}

// Test harness: execute and toModelOutput are always defined for our tool.
type AnyTool = any;

async function run(t: ReturnType<typeof createWebSearchTool>, input: { query: string; limit?: number }) {
  const output = (await (t as AnyTool).execute(input, { toolCallId: "t1", messages: [] })) as DodoWebSearchOutput;
  const model = modelOutputToContent(await (t as AnyTool).toModelOutput({ toolCallId: "t1", input, output }));
  const text = model.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  return { output, text, isError: model.isError };
}

describe("parseWebSearchProvider / hasWebSearch", () => {
  it("defaults unknown providers to ceramic", () => {
    expect(parseWebSearchProvider(undefined)).toBe("ceramic");
    expect(parseWebSearchProvider("bing")).toBe("ceramic");
    expect(parseWebSearchProvider("linkup")).toBe("linkup");
  });

  it("detects the websearch method on the binding", () => {
    expect(hasWebSearch({ websearch: () => {} })).toBe(true);
    expect(hasWebSearch({ run: () => {} })).toBe(false);
    expect(hasWebSearch(undefined)).toBe(false);
  });
});

describe("isWebSearchEnabled", () => {
  const ai = { websearch: () => {} };
  it("requires admin, a gateway id and a websearch-capable binding", () => {
    expect(isWebSearchEnabled({ AI: ai, WEB_SEARCH_GATEWAY_ID: "gw" } as unknown as Env, true)).toBe(true);
    expect(isWebSearchEnabled({ AI: ai, WEB_SEARCH_GATEWAY_ID: "gw" } as unknown as Env, false)).toBe(false);
    expect(isWebSearchEnabled({ AI: ai } as unknown as Env, true)).toBe(false);
    expect(isWebSearchEnabled({ AI: {}, WEB_SEARCH_GATEWAY_ID: "gw" } as unknown as Env, true)).toBe(false);
  });
});

describe("createWebSearchTool (agents/websearch/ai-sdk)", () => {
  it("keeps Dodo's description", () => {
    const { ai } = fakeAi(Response.json({ items: [] }));
    expect(createWebSearchTool({ ai, gatewayId: "gw" }).description).toMatch(/browser_markdown/);
  });

  it("adapts to a pi tool with a plain JSON schema", async () => {
    const { ai } = fakeAi(Response.json({ items: [] }));
    const reg = await adaptTool("web_search", createWebSearchTool({ ai, gatewayId: "gw" }) as AnyTool);
    const params = reg.parameters as unknown as { required?: string[]; properties: Record<string, unknown> };
    expect(Object.keys(params.properties).sort()).toEqual(["limit", "query"]);
    expect(params.required).toEqual(["query"]);
    expect(reg.replay).toBe("safe");
  });

  it("calls env.AI.websearch with gateway, provider and a capped limit", async () => {
    const { ai, websearch } = fakeAi(
      Response.json({
        items: [
          { url: "https://a.example", title: "A", description: "x ".repeat(5000) },
          { title: "no url" },
          { url: "https://b.example" },
        ],
        metadata: { query: "hello", requestId: "req-1", latencyMs: 300 },
      }),
    );
    const t = createWebSearchTool({ ai, gatewayId: "gw", provider: "linkup" });
    const { output, text, isError } = await run(t, { query: "hello", limit: 50 });
    expect(websearch).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayId: "gw", query: "hello", provider: "linkup", limit: 5 }),
    );
    expect(isError).toBe(false);
    // Host keeps the full response; the model reads the trimmed rendering.
    expect("error" in output).toBe(false);
    if (!("error" in output)) {
      expect(output.metadata.requestId).toBe("req-1");
      expect(output.provider).toBe("linkup");
      expect(output.items).toHaveLength(2);
    }
    expect(text).toContain('2 results for "hello":');
    expect(text).toContain("1. A\nhttps://a.example\n");
    expect(text).toContain("2. https://b.example\nhttps://b.example");
    expect(text).not.toContain("no url");
    expect(text.length).toBeLessThan(800);
  });

  it("tells the model to rephrase on zero results", async () => {
    const { ai } = fakeAi(Response.json({ items: [], metadata: { query: "q" } }));
    const { text } = await run(createWebSearchTool({ ai, gatewayId: "gw" }), { query: "q" });
    expect(text).toMatch(/No results/);
  });

  it("returns a non-retryable error-text result on 402", async () => {
    const { ai } = fakeAi(new Response("no credits", { status: 402 }));
    const { output, text, isError } = await run(createWebSearchTool({ ai, gatewayId: "gw" }), { query: "q" });
    expect(isError).toBe(true);
    expect(output).toMatchObject({ code: "web_search_payment_required" });
    expect(text).toMatch(/Do not retry/);
  });

  it("returns a retryable error-text result when the binding throws", async () => {
    const { ai } = fakeAi(new Error("boom"));
    const { output, text, isError } = await run(createWebSearchTool({ ai, gatewayId: "gw" }), { query: "q" });
    expect(isError).toBe(true);
    expect(output).toMatchObject({ code: "web_search_unavailable" });
    expect(text).toMatch(/retry once/);
  });
});
