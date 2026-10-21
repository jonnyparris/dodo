import { describe, expect, it } from "vitest";
import {
  extractJevChoice,
  extractJevNoul,
  triageUrls,
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
