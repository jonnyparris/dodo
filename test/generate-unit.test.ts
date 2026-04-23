/**
 * Unit tests for the /generate image-generation flow.
 *
 * The live Workers AI FLUX call can't be exercised under vitest-pool-workers —
 * miniflare doesn't mock `env.AI.run()` and the handler lives inside a DO
 * (not trivially injectable). These tests cover the edges that don't need the
 * DO path:
 *
 *   - Client-side `/generate` slash command regex (public/js/dodo-chat.js)
 *   - Server-side prompt schema (max 2048 chars per FLUX docs)
 *   - Shared-index catalog separation (chat models vs image models)
 */

import { describe, expect, it } from "vitest";
import {
  FLUX_IMAGE_MODEL,
  FLUX_IMAGE_MEDIA_TYPE,
  FLUX_MAX_PROMPT_LENGTH,
  WORKERS_AI_MODELS,
  WORKERS_AI_IMAGE_MODELS,
} from "../src/shared-index";

describe("/generate slash command regex", () => {
  // Mirror of the client-side regex in public/js/dodo-chat.js. Duplicated as a
  // plain literal so a regex change there forces a change here too.
  const SLASH_REGEX = /^\/generate\s+([\s\S]+)$/i;

  it("matches a basic prompt", () => {
    const m = "/generate a cyberpunk cat".match(SLASH_REGEX);
    expect(m?.[1]).toBe("a cyberpunk cat");
  });

  it("is case-insensitive", () => {
    const m = "/GENERATE a dog".match(SLASH_REGEX);
    expect(m?.[1]).toBe("a dog");
  });

  it("preserves multi-line prompts", () => {
    const m = "/generate line one\nline two\nline three".match(SLASH_REGEX);
    expect(m?.[1]).toBe("line one\nline two\nline three");
  });

  it("does not match without a prompt segment", () => {
    // Missing whitespace + prompt entirely
    expect("/generate".match(SLASH_REGEX)).toBeNull();
    // `/generate ` has trailing whitespace but nothing else, so `[\s\S]+` has
    // nothing to capture and the match fails.
    expect("/generate ".match(SLASH_REGEX)).toBeNull();
  });

  it("matches whitespace-only prompts but the client trims them out", () => {
    // The regex itself matches because `\s+([\s\S]+)` will greedily capture
    // at least one char after the first whitespace run — including more
    // whitespace. The client-side `.trim()` + empty check is what surfaces
    // the "Add a prompt after /generate" toast. Guard the shape here so the
    // regex stays aligned with the client-side trimming contract.
    const m = "/generate   ".match(SLASH_REGEX);
    expect(m).not.toBeNull();
    expect(m![1].trim()).toBe("");
  });

  it("does not match concatenated words", () => {
    // `/generatefoo` shouldn't trigger — we require whitespace separator.
    expect("/generatefoo".match(SLASH_REGEX)).toBeNull();
  });

  it("does not match messages where /generate is not at the start", () => {
    expect("please /generate a cat".match(SLASH_REGEX)).toBeNull();
  });

  it("strips leading whitespace from the prompt", () => {
    // The capturing group starts after `\s+`, so leading whitespace is already
    // consumed — the first whitespace character after /generate is the delimiter.
    const m = "/generate   a tidy prompt".match(SLASH_REGEX);
    expect(m?.[1]).toBe("a tidy prompt");
  });
});

describe("FLUX prompt length enforcement", () => {
  it("FLUX_MAX_PROMPT_LENGTH matches the Workers AI model schema", () => {
    // Per https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/
    // the `prompt` field has `maxLength: 2048`. If Cloudflare lifts the cap we
    // should update this constant — the test exists to flag that drift.
    expect(FLUX_MAX_PROMPT_LENGTH).toBe(2048);
  });

  it("FLUX constants are exported for handler + test parity", () => {
    expect(FLUX_IMAGE_MODEL).toBe("@cf/black-forest-labs/flux-1-schnell");
    expect(FLUX_IMAGE_MEDIA_TYPE).toBe("image/jpeg");
  });
});

describe("Workers AI model catalog", () => {
  it("does not list FLUX in the chat model picker", () => {
    // FLUX is text-to-image — surfacing it in the chat model picker would let
    // users set it as their default and brick every subsequent prompt. Keep
    // image models strictly separate.
    const chatIds = WORKERS_AI_MODELS.map((m) => m.id);
    expect(chatIds).not.toContain("@cf/black-forest-labs/flux-1-schnell");
  });

  it("lists FLUX in the image-model catalog", () => {
    const imageIds = WORKERS_AI_IMAGE_MODELS.map((m) => m.id);
    expect(imageIds).toContain("@cf/black-forest-labs/flux-1-schnell");
  });

  it("image models have kind=text-to-image", () => {
    for (const m of WORKERS_AI_IMAGE_MODELS) {
      expect(m.kind).toBe("text-to-image");
    }
  });
});
