/**
 * Workers AI's `/compat` schema validates `content` as a string per message
 * and rejects two shapes pi-ai sends: `content: null` on a tool-only assistant
 * turn, and `content: [...]` on a turn with more than one block. On AI Gateway
 * `jp-gw` those 400'd 30 `@cf/openai/gpt-oss-120b` turns on 2026-10-22, every
 * one past the first, while the first turn of the same session succeeded.
 * These tests pin the rewrite and that the `/compat` leg applies it to `@cf/`
 * models only, and leaves arrays alone for a vision model.
 */
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentModelRef, setDodoProvider, stringMessageContent } from "../src/pi/models";
import type { AppConfig, Env } from "../src/types";

const GPT_OSS = "@cf/openai/gpt-oss-120b"; // text-only in the catalog
const GLM = "@cf/zai-org/glm-5.3-flash"; // vision: true
const config = {
  activeGateway: "ai-gateway",
  aiGatewayBaseURL: "https://gateway.ai.cloudflare.com/v1/acct/gw/compat",
  opencodeBaseURL: "https://opencode.example/v1",
  sessionId: "sess-1",
} as unknown as AppConfig;
// COMPAT_VIA_BINDING=0 keeps the /compat leg on HTTP, so the stubbed fetch sees the body.
const env = { AI_GATEWAY_KEY: "gw-key", CLOUDFLARE_ACCOUNT_ID: "acct", COMPAT_VIA_BINDING: "0" } as unknown as Env;

const payload = (messages: unknown[]) => ({ model: `workers-ai/${GPT_OSS}`, messages });
const textPart = (text: string) => ({ type: "text", text });

/** One user turn with two blocks, then a tool-only assistant turn and its result. */
const transcript = () => ({
  systemPrompt: "You are Dodo.",
  messages: [
    { role: "user", content: [textPart("read it"), textPart("then summarise")], timestamp: 0 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a" } }],
      api: "openai-completions",
      provider: "dodo-gateway",
      model: GPT_OSS,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 1,
    },
    { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [textPart("contents")], isError: false, timestamp: 2 },
  ],
  tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
});

afterEach(() => vi.unstubAllGlobals());

describe("stringMessageContent", () => {
  it("rewrites a tool-only assistant turn's null content to an empty string", () => {
    const out = stringMessageContent(
      payload([
        { role: "system", content: "You are Dodo." },
        { role: "user", content: "read it" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1" }] },
        { role: "tool", tool_call_id: "call_1", content: "contents" },
      ]),
      true,
    ) as { messages: Array<Record<string, unknown>> };
    expect(out.messages.map((m) => m.content)).toEqual(["You are Dodo.", "read it", "", "contents"]);
  });

  it("collapses an array to its text for a model that cannot take images", () => {
    const out = stringMessageContent(
      payload([
        { role: "user", content: [textPart("read it"), textPart("then summarise")] },
        { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] },
      ]),
      false,
    ) as { messages: Array<Record<string, unknown>> };
    expect(out.messages[0]!.content).toBe("read it\n\nthen summarise");
    expect(out.messages[1]!.content).toContain("attachment removed from context");
  });

  it("keeps an array for a vision model", () => {
    const messages = [{ role: "user", content: [textPart("a"), textPart("b")] }];
    const kept = payload(messages);
    expect(stringMessageContent(kept, true)).toBe(kept);
  });

  it("returns the same payload when there is nothing to rewrite", () => {
    const clean = payload([{ role: "user", content: "hi" }]);
    expect(stringMessageContent(clean, false)).toBe(clean);
    expect(stringMessageContent(null, false)).toBeNull();
    expect(stringMessageContent("not a payload", false)).toBe("not a payload");
    expect(stringMessageContent({ model: "m" }, false)).toEqual({ model: "m" });
  });

  it("leaves null content on other roles alone", () => {
    const other = payload([{ role: "user", content: null }]);
    expect(stringMessageContent(other, false)).toBe(other);
  });
});

describe("/compat requests for Workers AI models", () => {
  async function bodyFor(modelId: string): Promise<Record<string, unknown>> {
    const seen: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      seen.push((await req.json()) as Record<string, unknown>);
      return new Response(JSON.stringify({ error: { message: "Bad input" } }), { status: 400, headers: { "content-type": "application/json" } });
    });
    const models = createModels();
    setDodoProvider(models, [modelId], config, env);
    const ref = agentModelRef(modelId, config, env);
    // The 400 is expected: this test reads the request body, not the answer.
    await models.complete(models.getModel(ref.provider, ref.modelId)!, transcript() as never).catch(() => undefined);
    expect(seen).toHaveLength(1);
    return seen[0]!;
  }

  it("sends strings, never null or an array, for a text-only Workers AI model", async () => {
    const body = await bodyFor(GPT_OSS);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(messages[1]!.content).toBe("read it\n\nthen summarise");
    expect(messages[2]!.content).toBe("");
    expect(messages[2]!.tool_calls).toHaveLength(1);
  });

  it("keeps a vision Workers AI model's array content", async () => {
    const body = await bodyFor(GLM);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(Array.isArray(messages[1]!.content)).toBe(true);
  });

  it("leaves other providers' null assistant content untouched", async () => {
    const body = await bodyFor("openai/gpt-5.4");
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[2]!.content).toBeNull();
  });
});
