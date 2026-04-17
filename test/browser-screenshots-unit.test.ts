import { describe, expect, it } from "vitest";
import { extractScreenshots } from "../src/browser/tools";

// Tiny 1×1 PNG — enough bytes (base64 > 100) for extractScreenshots to
// consider it a real screenshot rather than a random short string.
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

describe("extractScreenshots", () => {
  it("pulls a screenshot out of the raw CDP Page.captureScreenshot shape", () => {
    const input = { data: TINY_PNG, format: "png" };
    const { images, scrubbed } = extractScreenshots(input);
    expect(images).toHaveLength(1);
    expect(images[0].mediaType).toBe("image/png");
    expect(images[0].data).toBe(TINY_PNG);
    // `data` has been stripped, `format` preserved, placeholder marker added
    expect(scrubbed).toEqual({ format: "png", _attachmentPlaceholder: true });
  });

  it("handles the docstring shape { screenshot, format }", () => {
    const input = { screenshot: TINY_PNG, format: "jpeg", encoding: "base64" };
    const { images, scrubbed } = extractScreenshots(input);
    expect(images).toHaveLength(1);
    expect(images[0].mediaType).toBe("image/jpeg");
    expect(scrubbed).toEqual({ format: "jpeg", encoding: "base64", _attachmentPlaceholder: true });
  });

  it("recurses into nested objects", () => {
    const input = {
      result: { data: TINY_PNG, format: "webp" },
      meta: { navigated: true },
    };
    const { images, scrubbed } = extractScreenshots(input);
    expect(images).toHaveLength(1);
    expect(images[0].mediaType).toBe("image/webp");
    expect(scrubbed).toEqual({
      result: { format: "webp", _attachmentPlaceholder: true },
      meta: { navigated: true },
    });
  });

  it("recurses into arrays", () => {
    const input = [
      { data: TINY_PNG, format: "png" },
      { data: TINY_PNG, format: "jpeg" },
    ];
    const { images } = extractScreenshots(input);
    expect(images).toHaveLength(2);
    expect(images[0].mediaType).toBe("image/png");
    expect(images[1].mediaType).toBe("image/jpeg");
  });

  it("ignores objects without a known format", () => {
    const input = { data: TINY_PNG, format: "tiff" };
    const { images, scrubbed } = extractScreenshots(input);
    expect(images).toHaveLength(0);
    expect(scrubbed).toEqual(input);
  });

  it("ignores data strings below the size heuristic", () => {
    // A short string that happens to have data+format shape but is too short
    // to be a real screenshot — probably not an image. Stay well below the
    // 50-char threshold used internally.
    const input = { data: "short", format: "png" };
    const { images } = extractScreenshots(input);
    expect(images).toHaveLength(0);
  });

  it("leaves non-screenshot values untouched", () => {
    const input = { title: "Example", url: "https://example.com", loaded: true };
    const { images, scrubbed } = extractScreenshots(input);
    expect(images).toHaveLength(0);
    expect(scrubbed).toEqual(input);
  });

  it("passes primitives through unchanged", () => {
    expect(extractScreenshots("hello").scrubbed).toBe("hello");
    expect(extractScreenshots(42).scrubbed).toBe(42);
    expect(extractScreenshots(null).scrubbed).toBe(null);
  });
});
