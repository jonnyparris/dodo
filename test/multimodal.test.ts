import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env } from "../src/types";
import { resetMockAgentic } from "./helpers/agentic-mock";

const { runSandboxedCodeMock, sendNotificationMock } = vi.hoisted(() => ({
  runSandboxedCodeMock: vi.fn(),
  sendNotificationMock: vi.fn(),
}));

vi.mock("../src/executor", () => ({
  runSandboxedCode: runSandboxedCodeMock,
}));

vi.mock("../src/agentic", async () => await import("./helpers/agentic-mock"));

vi.mock("../src/notify", () => ({
  sendNotification: sendNotificationMock,
}));

import worker from "../src/index";

const BASE_URL = "https://dodo.example";

async function fetchJson(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, init), env as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

// Tiny 1x1 red PNG as base64 (valid image data for testing)
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

describe("Multimodal image support", () => {
  let sessionId: string;

  beforeAll(async () => {
    // Ensure health
    try { await fetchJson("/health"); } catch { /* absorb */ }
    try { await fetchJson("/health"); } catch { /* retry */ }

    // Create session
    const response = await fetchJson("/session", { method: "POST" });
    expect(response.status).toBe(201);
    sessionId = ((await response.json()) as { id: string }).id;
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    resetMockAgentic();
    runSandboxedCodeMock.mockReset();
    runSandboxedCodeMock.mockResolvedValue({ logs: [], result: {} });
    sendNotificationMock.mockReset();

    await fetchJson("/api/config", {
      body: JSON.stringify({ activeGateway: "opencode", model: "claude-test" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
  });

  describe("Schema validation", () => {
    it("accepts a prompt with text only (no images)", async () => {
      const res = await fetchJson(`/session/${sessionId}/message`, {
        body: JSON.stringify({ content: "Hello" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(res.status).toBe(200);
    });

    it("accepts a prompt with text and valid images", async () => {
      const res = await fetchJson(`/session/${sessionId}/message`, {
        body: JSON.stringify({
          content: "What is in this image?",
          images: [{ data: TINY_PNG_BASE64, mediaType: "image/png" }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(res.status).toBe(200);
    });

    it("accepts multiple images up to the limit", async () => {
      const images = Array.from({ length: 5 }, () => ({
        data: TINY_PNG_BASE64,
        mediaType: "image/png",
      }));
      const res = await fetchJson(`/session/${sessionId}/message`, {
        body: JSON.stringify({ content: "Describe these images", images }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(res.status).toBe(200);
    });

    it("rejects more than 5 images", async () => {
      const images = Array.from({ length: 6 }, () => ({
        data: TINY_PNG_BASE64,
        mediaType: "image/png",
      }));
      const res = await fetchJson(`/session/${sessionId}/message`, {
        body: JSON.stringify({ content: "Too many images", images }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid media types", async () => {
      const res = await fetchJson(`/session/${sessionId}/message`, {
        body: JSON.stringify({
          content: "Bad type",
          images: [{ data: TINY_PNG_BASE64, mediaType: "application/pdf" }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(res.status).toBe(400);
    });

    it("rejects images with empty data", async () => {
      const res = await fetchJson(`/session/${sessionId}/message`, {
        body: JSON.stringify({
          content: "Empty image",
          images: [{ data: "", mediaType: "image/png" }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(res.status).toBe(400);
    });

    it("rejects images whose base64 payload exceeds the length cap", async () => {
      // MAX_IMAGE_BASE64_LENGTH = 4_000_000. One over and it should fail schema
      // validation before the handler ever runs. Use divisible-by-4 so it
      // doesn't fail for the wrong reason.
      const oversizedBase64 = "A".repeat(4_000_004);
      const res = await fetchJson(`/session/${sessionId}/message`, {
        body: JSON.stringify({
          content: "Too big",
          images: [{ data: oversizedBase64, mediaType: "image/png" }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(res.status).toBe(400);
    });

    it("rejects base64 whose length is not divisible by 4", async () => {
      // Valid-looking alphabet but broken framing — caught by isLikelyBase64.
      const res = await fetchJson(`/session/${sessionId}/message`, {
        body: JSON.stringify({
          content: "Malformed base64",
          images: [{ data: "AAA", mediaType: "image/png" }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(res.status).toBe(400);
    });

    it("rejects base64 containing characters outside the base64 alphabet", async () => {
      // 8 chars, divisible by 4, but contains `$` which isn't in the alphabet.
      const res = await fetchJson(`/session/${sessionId}/message`, {
        body: JSON.stringify({
          content: "Bad chars",
          images: [{ data: "AAAA$AAA", mediaType: "image/png" }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(res.status).toBe(400);
    });

    it("accepts image/svg+xml with a sanitizable SVG payload", async () => {
      // Base64 of `<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>`.
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
      const b64 = btoa(svg);
      const res = await fetchJson(`/session/${sessionId}/message`, {
        body: JSON.stringify({
          content: "SVG upload",
          images: [{ data: b64, mediaType: "image/svg+xml" }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(res.status).toBe(200);
    });

    it("sanitizes SVG attachments before storing them on the message", async () => {
      // This is the end-to-end round-trip. Upload an SVG with a script tag,
      // read the message back, assert the stored base64 decodes to a
      // script-free SVG. Would have caught the claim-3 bypass.
      const dirty = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="4"/></svg>';
      const b64 = btoa(dirty);
      const msgRes = await fetchJson(`/session/${sessionId}/message`, {
        body: JSON.stringify({
          content: "SVG with script",
          images: [{ data: b64, mediaType: "image/svg+xml" }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(msgRes.status).toBe(200);

      const historyRes = await fetchJson(`/session/${sessionId}/messages`);
      const { messages } = (await historyRes.json()) as {
        messages: Array<{ role: string; content: string; attachments?: Array<{ mediaType: string; url: string }> }>;
      };
      const userMsg = messages.find((m) => m.role === "user" && m.content === "SVG with script");
      expect(userMsg).toBeTruthy();
      expect(userMsg!.attachments).toBeDefined();
      expect(userMsg!.attachments).toHaveLength(1);
      expect(userMsg!.attachments![0].mediaType).toBe("image/svg+xml");

      // Decode the data URL and assert no <script> in the cleaned SVG.
      const url = userMsg!.attachments![0].url;
      expect(url).toMatch(/^data:image\/svg\+xml;base64,/);
      const storedB64 = url.replace(/^data:image\/svg\+xml;base64,/, "");
      const storedSvg = atob(storedB64);
      expect(storedSvg).not.toContain("script");
      expect(storedSvg).not.toContain("alert");
      expect(storedSvg).toContain("<circle");
    });

    it("silently drops malformed SVG attachments", async () => {
      // sanitizeUserImage returns null → filePart is skipped, message still
      // succeeds. This prevents a malformed upload from nuking the whole
      // message, which would be confusing UX.
      const garbage = btoa("not valid svg at all, just html");
      const msgRes = await fetchJson(`/session/${sessionId}/message`, {
        body: JSON.stringify({
          content: "SVG garbage",
          images: [{ data: garbage, mediaType: "image/svg+xml" }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(msgRes.status).toBe(200);

      const historyRes = await fetchJson(`/session/${sessionId}/messages`);
      const { messages } = (await historyRes.json()) as {
        messages: Array<{ role: string; content: string; attachments?: unknown }>;
      };
      const userMsg = messages.find((m) => m.role === "user" && m.content === "SVG garbage");
      expect(userMsg).toBeTruthy();
      // No attachments — the malformed one was dropped, nothing else to persist.
      expect(userMsg!.attachments).toBeUndefined();
    });
  });

  describe("Message history", () => {
    it("stores image attachments in message history", async () => {
      const msgRes = await fetchJson(`/session/${sessionId}/message`, {
        body: JSON.stringify({
          content: "Describe this",
          images: [{ data: TINY_PNG_BASE64, mediaType: "image/png" }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(msgRes.status).toBe(200);

      const historyRes = await fetchJson(`/session/${sessionId}/messages`);
      const { messages } = (await historyRes.json()) as {
        messages: Array<{ role: string; content: string; attachments?: Array<{ mediaType: string; url: string }> }>;
      };

      // Find the user message with attachments
      const userMsg = messages.find(
        (m) => m.role === "user" && m.content === "Describe this",
      );
      expect(userMsg).toBeTruthy();
      expect(userMsg!.attachments).toBeDefined();
      expect(userMsg!.attachments).toHaveLength(1);
      expect(userMsg!.attachments![0].mediaType).toBe("image/png");
      // uiMessageToChatRecord normalizes raw base64 to data URLs for frontend display
      expect(userMsg!.attachments![0].url).toMatch(/^data:image\/png;base64,/);
    });

    it("messages without images have no attachments field", async () => {
      const msgRes = await fetchJson(`/session/${sessionId}/message`, {
        body: JSON.stringify({ content: "Plain text message" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(msgRes.status).toBe(200);

      const historyRes = await fetchJson(`/session/${sessionId}/messages`);
      const { messages } = (await historyRes.json()) as {
        messages: Array<{ role: string; content: string; attachments?: unknown }>;
      };

      const userMsg = messages.find(
        (m) => m.role === "user" && m.content === "Plain text message",
      );
      expect(userMsg).toBeTruthy();
      expect(userMsg!.attachments).toBeUndefined();
    });
  });

  describe("Async prompt path", () => {
    it("accepts images via the prompt endpoint", async () => {
      const res = await fetchJson(`/session/${sessionId}/prompt`, {
        body: JSON.stringify({
          content: "Analyze this screenshot",
          images: [{ data: TINY_PNG_BASE64, mediaType: "image/jpeg" }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      // 202 = accepted (async prompt queued)
      expect(res.status).toBe(202);
      const body = (await res.json()) as { promptId: string; status: string };
      expect(body.promptId).toBeTruthy();
      expect(body.status).toBe("queued");
    });
  });
});
