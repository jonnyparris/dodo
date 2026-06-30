/**
 * Unit tests for the Replicate image client (src/replicate.ts) — the
 * generation + editing path that backs /generate and /edit-image.
 *
 * Network is mocked via vi.stubGlobal("fetch"). We assert: the missing-token
 * and bad-model guards, the request body shape (text-to-image vs edit), the
 * Prefer:wait happy path, the polling fallback, and failure propagation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplicateNotConfiguredError, runReplicateImage } from "../src/replicate";
import type { Env } from "../src/types";

const env = (token?: string) => ({ REPLICATE_API_TOKEN: token } as unknown as Env);

// A 1x1 transparent PNG, base64 — used as the fake downloaded output.
const PNG_BYTES = Uint8Array.from(atob("iVBORw0KGgo="), (c) => c.charCodeAt(0));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runReplicateImage", () => {
  it("throws ReplicateNotConfiguredError when no token", async () => {
    await expect(
      runReplicateImage({ env: env(undefined), model: "google/nano-banana-2", prompt: "hi" }),
    ).rejects.toBeInstanceOf(ReplicateNotConfiguredError);
  });

  it("rejects a malformed model id", async () => {
    await expect(
      runReplicateImage({ env: env("r8_x"), model: "not-a-valid-model", prompt: "hi" }),
    ).rejects.toThrow(/Invalid Replicate model id/);
  });

  it("text-to-image: posts prompt without image_input and returns base64", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/predictions")) {
        return new Response(JSON.stringify({ status: "succeeded", output: "https://img/out.jpg" }), { status: 200 });
      }
      return new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/jpeg" } });
    }));

    const out = await runReplicateImage({ env: env("r8_x"), model: "google/nano-banana-2", prompt: "a cat" });
    expect(out.mediaType).toBe("image/jpeg");
    expect(out.imageBase64.length).toBeGreaterThan(0);

    const create = calls.find((c) => c.url.endsWith("/predictions"))!;
    expect(create.url).toBe("https://api.replicate.com/v1/models/google/nano-banana-2/predictions");
    expect((create.init?.headers as Record<string, string>).Prefer).toBe("wait");
    const body = JSON.parse(String(create.init?.body));
    expect(body.input.prompt).toBe("a cat");
    expect(body.input.output_format).toBe("jpg");
    expect(body.input.image_input).toBeUndefined();
  });

  it("edit: includes image_input as data URIs", async () => {
    let createBody: { input: { image_input?: string[] } } | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/predictions")) {
        createBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ status: "succeeded", output: ["https://img/out.png"] }), { status: 200 });
      }
      return new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } });
    }));

    const out = await runReplicateImage({
      env: env("r8_x"),
      model: "google/nano-banana-2",
      prompt: "add a hat",
      images: [{ data: "QUJD", mediaType: "image/png" }],
    });
    expect(out.mediaType).toBe("image/png");
    expect(createBody!.input.image_input).toEqual(["data:image/png;base64,QUJD"]);
  });

  it("polls when the create response is not terminal", async () => {
    let polled = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/predictions")) {
        return new Response(JSON.stringify({ status: "processing", urls: { get: "https://api.replicate.com/v1/predictions/abc" } }), { status: 200 });
      }
      if (u.endsWith("/predictions/abc")) {
        polled = true;
        return new Response(JSON.stringify({ status: "succeeded", output: "https://img/out.jpg" }), { status: 200 });
      }
      return new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/jpeg" } });
    }));

    const out = await runReplicateImage({ env: env("r8_x"), model: "google/nano-banana-2", prompt: "x" });
    expect(polled).toBe(true);
    expect(out.imageBase64.length).toBeGreaterThan(0);
  });

  it("throws when the prediction fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ status: "failed", error: "nsfw content" }), { status: 200 }),
    ));
    await expect(
      runReplicateImage({ env: env("r8_x"), model: "google/nano-banana-2", prompt: "x" }),
    ).rejects.toThrow(/failed: nsfw content/);
  });

  it("throws on a non-2xx create response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad token", { status: 401 })));
    await expect(
      runReplicateImage({ env: env("r8_x"), model: "google/nano-banana-2", prompt: "x" }),
    ).rejects.toThrow(/Replicate API error \(401\)/);
  });
});
