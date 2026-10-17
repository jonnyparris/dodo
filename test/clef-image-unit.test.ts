import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it, vi } from "vitest";
import { classifyImageIntent, EDIT_INTENT_THRESHOLD } from "../src/clef";
import { createImageCheckTool } from "../src/tools/image-check";
import type { Env } from "../src/types";

vi.mock("../src/agentic", async () => await import("./helpers/agentic-mock"));
vi.mock("../src/pi/models", async () => await import("./helpers/pi-models-mock"));

const RED = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeUlEQVR4nO3PQQkAMAzAwIqof2UTMxF7HINABFzm7H7dcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFj12qxUDxeFqrFAAAAABJRU5ErkJggg==";
const fakeAi = (answers: Record<string, unknown>) => {
  const run = vi.fn(async () => ({ model: "clef-flash", answers, usage: { input_tokens: 300, output_tokens: 0 } }));
  return { ai: { run } as unknown as Ai, run };
};
const exec = (t: unknown, input: unknown) => (t as { execute: (i: unknown, o: unknown) => Promise<any> }).execute(input, { toolCallId: "t", messages: [] });

describe("image_check", () => {
  it("maps yes_no / choice / score to Clef and summarises answers", async () => {
    const { ai, run } = fakeAi({
      colour: { type: "choice", choice: "red", probabilities: { red: 0.97, blue: 0.03 }, confidence: 0.92 },
      photo: { type: "noul", noul: 0.0466 },
      sharp: { type: "score", score: 1.6, legend: { "0": "blurry", "1": "ok", "2": "sharp" }, probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 }, confidence: 0.5 },
    });
    const t = createImageCheckTool({ ai, resolveImage: async () => ({ mediaType: "image/png", dataUrl: `data:image/png;base64,${RED}` }) });
    const out = await exec(t, {
      images: ["dodo-attachment://x"],
      questions: [
        { id: "colour", kind: "choice", question: "Main colour?", options: ["red", "blue"] },
        { id: "photo", kind: "yes_no", question: "A photo?" },
        { id: "sharp", kind: "score", question: "How sharp?", levels: ["blurry", "ok", "sharp"] },
      ],
    });
    expect(out.answers).toEqual({
      colour: { answer: "red", confidence: 0.92, top: { red: 0.97, blue: 0.03 } },
      photo: { yes: 0.047 },
      sharp: { score: 1.6, confidence: 0.5, legend: { "0": "blurry", "1": "ok", "2": "sharp" } },
    });
    const [model, body] = run.mock.calls[0] as unknown as [string, any];
    expect(model).toBe("@cf/cloudflare/clef-flash");
    expect(body.model).toBe("clef-flash");
    expect(body.images).toEqual([`data:image/png;base64,${RED}`]);
    expect(body.questions.colour).toEqual({ type: "choice", instructions: "Main colour?", criteria: { red: "red", blue: "blue" } });
    expect(body.questions.photo).toEqual({ type: "noul", instructions: "A photo?" });
  });

  it("refuses unresolvable or unsupported images before calling Clef", async () => {
    const { ai, run } = fakeAi({});
    const t = createImageCheckTool({ ai, resolveImage: async (r) => (r === "gif" ? { mediaType: "image/gif", dataUrl: "data:image/gif;base64,AA" } : { error: "not an attachment of this session" }) });
    expect((await exec(t, { images: ["other"], questions: [{ id: "q", kind: "yes_no", question: "?" }] })).error).toContain("not an attachment");
    expect((await exec(t, { images: ["gif"], questions: [{ id: "q", kind: "yes_no", question: "?" }] })).error).toContain("not supported");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("classifyImageIntent", () => {
  it(`edit at P(edit) >= ${EDIT_INTENT_THRESHOLD}, otherwise ask; Clef failure means ask`, async () => {
    const edit = fakeAi({ intent: { type: "choice", choice: "edit", probabilities: { edit: 0.99, ask: 0.01 }, confidence: 0.95 } });
    expect((await classifyImageIntent(edit.ai, "make the sky purple", "attached")).intent).toBe("edit");
    const thanks = fakeAi({ intent: { type: "choice", choice: "ask", probabilities: { edit: 0.25, ask: 0.75 }, confidence: 0.24 } });
    expect((await classifyImageIntent(thanks.ai, "thanks!", "generated")).intent).toBe("ask");
    const broken = { run: vi.fn(async () => { throw new Error("down"); }) } as unknown as Ai;
    expect(await classifyImageIntent(broken, "make it blue", "attached")).toEqual({ intent: "ask", pEdit: null });
  });
});

describe("CodingAgent + Clef", () => {
  const typedEnv = env as unknown as Env;
  const inDO = runInDurableObject as unknown as <T>(stub: unknown, fn: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
  const agent = async (id: string) => (await getAgentByName(typedEnv.CODING_AGENT as never, id)) as unknown;

  it("resolveImageRef only serves this session's attachments and workspace images", async () => {
    const id = crypto.randomUUID();
    await inDO(await agent(id), async (instance, state) => {
      const url = `data:image/png;base64,${RED}`;
      state.storage.sql.exec(
        "INSERT INTO message_attachments (message_id, media_type, url, size, source, name, created_at) VALUES ('m1', 'image/png', ?, 4, 'tool', NULL, 1)",
        url,
      );
      expect(await instance.resolveImageRef(url)).toEqual({ mediaType: "image/png", dataUrl: url });
      expect(await instance.resolveImageRef("dodo-attachment://someone-else/x.png")).toEqual({ error: "not an attachment of this session" });
      const bytes = Uint8Array.from(atob(RED), (ch) => ch.charCodeAt(0));
      await instance.workspace.writeFileBytes("/shots/a.png", bytes);
      expect((await instance.resolveImageRef("/shots/a.png")).mediaType).toBe("image/png");
      expect((await instance.resolveImageRef("/shots/a.gif")).error).toContain(".png");
    });
  });

  it("text-only model: Clef routes edits to Replicate and questions to the model; vision models skip Clef", async () => {
    const id = crypto.randomUUID();
    await inDO(await agent(id), async (instance) => {
      const img = [{ data: RED, mediaType: "image/png" }];
      const setModel = (model: string) => instance.configure({ ...(instance.getConfig() ?? {}), model });
      const edit = fakeAi({ intent: { type: "choice", choice: "edit", probabilities: { edit: 0.99, ask: 0.01 }, confidence: 0.95 } });
      const ask = fakeAi({ intent: { type: "choice", choice: "ask", probabilities: { edit: 0.02, ask: 0.98 }, confidence: 0.94 } });
      const realEnv = instance.env;
      try {
        setModel("@cf/qwen/qwen2.5-coder-32b-instruct");
        instance.env = { ...realEnv, AI: edit.ai };
        expect(await instance.imageEditTarget("make it purple", img)).toEqual(img);
        instance.env = { ...realEnv, AI: ask.ai };
        expect(await instance.imageEditTarget("what colour is this?", img)).toBeNull();
        // No image in play: no Clef call at all.
        expect(await instance.imageEditTarget("hello", undefined)).toBeNull();
        setModel("@cf/zai-org/glm-5.3-flash");
        const calls = ask.run.mock.calls.length;
        expect(await instance.imageEditTarget("make it purple", img)).toBeNull();
        expect(ask.run.mock.calls.length).toBe(calls);
      } finally {
        instance.env = realEnv;
      }
    });
  });

  it("text-only model: an uploaded image is stored and the model is told how to image_check it", async () => {
    const id = crypto.randomUUID();
    await inDO(await agent(id), async (instance, state) => {
      state.storage.sql.exec("INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES ('owner_email', 'dev@dodo.local', 1)");
      state.storage.sql.exec("INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES ('session_id', ?, 1)", id);
      instance.configure({ ...(instance.getConfig() ?? {}), model: "@cf/qwen/qwen2.5-coder-32b-instruct" });
      const { userMsg, userMsgId } = await instance.prepareUserTurn("what colour is it?", { images: [{ data: RED, mediaType: "image/png", name: "red.png" }] });
      const text = userMsg.parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
      expect(userMsg.parts.some((p: any) => p.type === "file")).toBe(false);
      expect(text).toContain("image_check");
      const rows = Array.from(state.storage.sql.exec("SELECT url, source, name FROM message_attachments WHERE message_id = ?", userMsgId));
      expect(rows).toHaveLength(1);
      expect(text).toContain(String(rows[0]!.url));
      const resolved = await instance.resolveImageRef(String(rows[0]!.url));
      expect(resolved, JSON.stringify({ url: rows[0]!.url, resolved })).toMatchObject({ mediaType: "image/png" });
    });
  });
});

describe("uiPartsToPiContent", () => {
  it("joins text-only parts into one string (gpt-oss / Qwen reject array content)", async () => {
    const { uiPartsToPiContent } = await import("../src/coding-agent");
    expect(uiPartsToPiContent([{ type: "text", text: "what colour?" }, { type: "text", text: "[Image attached: x]" }] as never)).toBe("what colour?\n\n[Image attached: x]");
    const withImage = uiPartsToPiContent([{ type: "text", text: "hi" }, { type: "file", mediaType: "image/png", url: `data:image/png;base64,${RED}` }] as never);
    expect(Array.isArray(withImage)).toBe(true);
  });
});
