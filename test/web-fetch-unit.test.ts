import { describe, expect, it } from "vitest";
import {
  capMarkdown,
  extractJevChoice,
  extractJevNoul,
  triageUrls,
  validateTargetUrl,
  type JevAi,
} from "../src/browser/web-fetch";

describe("extractJevNoul", () => {
  it("extracts the noul probability", () => {
    const response = { answers: { has_answer: { type: "noul", noul: 0.87 } } };
    expect(extractJevNoul(response, "has_answer")).toBe(0.87);
  });

  it("returns null when the answer key is missing or the shape is wrong", () => {
    expect(extractJevNoul({}, "has_answer")).toBeNull();
    expect(extractJevNoul({ answers: { has_answer: { choice: "x" } } }, "has_answer")).toBeNull();
    expect(
      extractJevNoul({ answers: { has_answer: { noul: "high" } } }, "has_answer"),
    ).toBeNull();
  });
});

describe("extractJevChoice", () => {
  it("extracts choice and probabilities", () => {
    const response = {
      answers: {
        best_source: {
          type: "choice",
          choice: "1",
          confidence: 0.9,
          probabilities: { "0": 0.1, "1": 0.9 },
        },
      },
    };
    const choice = extractJevChoice(response, "best_source");
    expect(choice?.choice).toBe("1");
    expect(choice?.probabilities["1"]).toBe(0.9);
  });

  it("returns null on missing probabilities", () => {
    expect(
      extractJevChoice({ answers: { best_source: { choice: "1" } } }, "best_source"),
    ).toBeNull();
  });
});

describe("validateTargetUrl", () => {
  it("accepts https URLs", () => {
    const result = validateTargetUrl("https://example.com/page");
    expect("url" in result && result.url.hostname).toBe("example.com");
  });

  it("rejects non-http protocols and private hosts", () => {
    for (const bad of [
      "ftp://example.com",
      "file:///etc/passwd",
      "http://localhost:3000",
      "http://127.0.0.1",
      "http://192.168.1.4",
      "http://nas.local",
      "http://172.16.0.9",
    ]) {
      expect("error" in validateTargetUrl(bad), `expected rejection: ${bad}`).toBe(true);
    }
  });
});

describe("capMarkdown", () => {
  it("passes short content through unchanged", () => {
    expect(capMarkdown("short", 100)).toBe("short");
  });

  it("truncates long content with an explanatory note", () => {
    const long = "x".repeat(500);
    const capped = capMarkdown(long, 100);
    expect(capped.startsWith("x".repeat(100))).toBe(true);
    expect(capped).toContain("TRUNCATED");
    expect(capped).toContain("500");
  });
});

describe("triageUrls", () => {
  const failingAi = {
    run: () => {
      throw new Error("jev down");
    },
  } as unknown as JevAi;

  it("returns null (caller falls back) when Jev is unavailable", async () => {
    const result = await triageUrls(failingAi, "query", [
      { url: "https://a.com", title: "A" },
      { url: "https://b.com", title: "B" },
    ]);
    expect(result).toBeNull();
  });

  it("maps indexed probabilities back to URLs, sorted best-first", async () => {
    const ai = {
      run: async () => ({
        answers: {
          best_source: {
            type: "choice",
            choice: "1",
            confidence: 0.9,
            probabilities: { "0": 0.25, "1": 0.75 },
          },
        },
      }),
    } as unknown as JevAi;

    const result = await triageUrls(ai, "what is X", [
      { url: "https://a.com", title: "A" },
      { url: "https://b.com", title: "B", snippet: "about X" },
    ]);
    expect(result).not.toBeNull();
    expect(result?.picked).toBe("https://b.com");
    expect(result?.ranking[0].probability).toBe(0.75);
    expect(result?.ranking[1].url).toBe("https://a.com");
  });
});
