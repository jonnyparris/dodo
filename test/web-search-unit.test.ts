import { describe, expect, it, vi } from "vitest";
import { isWebSearchEnabled } from "../src/agentic";
import type { Env } from "../src/types";
import {
  createWebSearchTool,
  hasWebSearch,
  parseWebSearchProvider,
  renderWebSearchResults,
  trimDescription,
  type WebSearchAi,
} from "../src/web-search";

function fakeAi(response: Response | Error) {
  const websearch = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return { ai: { websearch } as WebSearchAi, websearch };
}

async function run(t: ReturnType<typeof createWebSearchTool>, input: { query: string; limit?: number }) {
  // biome-ignore lint: test harness — execute is always defined for our tool
  return (t as any).execute(input, { toolCallId: "t1", messages: [] });
}

describe("trimDescription", () => {
  it("collapses whitespace and leaves short text alone", () => {
    expect(trimDescription("a\n\n  b  c")).toBe("a b c");
  });

  it("cuts long text at a word boundary with an ellipsis", () => {
    const out = trimDescription("word ".repeat(300), 50);
    expect(out.length).toBeLessThanOrEqual(51);
    expect(out.endsWith("word…")).toBe(true);
  });
});

describe("renderWebSearchResults", () => {
  it("numbers results, drops items without a URL, falls back to URL for title", () => {
    const text = renderWebSearchResults("q", {
      items: [
        { url: "https://a.example", title: "A", description: "first" },
        { title: "no url" },
        { url: "https://b.example", lastModified: "2026-10-01" },
      ],
    });
    expect(text).toContain('2 results for "q":');
    expect(text).toContain("1. A\nhttps://a.example\nfirst");
    expect(text).toContain("2. https://b.example\nhttps://b.example\nLast modified: 2026-10-01");
    expect(text).not.toContain("no url");
  });

  it("tells the model to rephrase on zero results", () => {
    expect(renderWebSearchResults("q", { items: [] })).toMatch(/No results/);
  });
});

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

describe("createWebSearchTool", () => {
  it("calls env.AI.websearch with gateway, provider and a clamped limit", async () => {
    const { ai, websearch } = fakeAi(
      Response.json({
        items: [{ url: "https://a.example", title: "A", description: "x".repeat(5000) }],
        metadata: { requestId: "req-1", latencyMs: 300 },
      }),
    );
    const t = createWebSearchTool({ ai, gatewayId: "gw", provider: "ceramic" });
    const out = await run(t, { query: "hello", limit: 50 });
    expect(websearch).toHaveBeenCalledWith({ gatewayId: "gw", query: "hello", provider: "ceramic", limit: 5 });
    expect(out.requestId).toBe("req-1");
    expect(out.results.length).toBeLessThan(800);
  });

  it("returns a structured error with guidance on HTTP failure", async () => {
    const { ai } = fakeAi(new Response("no credits", { status: 402 }));
    const out = await run(createWebSearchTool({ ai, gatewayId: "gw" }), { query: "q" });
    expect(out.error).toMatch(/402/);
    expect(out.error).toMatch(/without web search/);
  });

  it("returns a structured error when the binding throws", async () => {
    const { ai } = fakeAi(new Error("web_search_unsupported_runtime"));
    const out = await run(createWebSearchTool({ ai, gatewayId: "gw" }), { query: "q" });
    expect(out.error).toMatch(/unsupported_runtime/);
  });
});
