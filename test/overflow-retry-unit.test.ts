import { describe, expect, it } from "vitest";
import { nextRetry } from "../src/overflow-retry";

describe("nextRetry", () => {
  it("aborts on non-overflow error", () => {
    const decision = nextRetry({
      previousAttempts: 0,
      maxAttempts: 1,
      error: { message: "Something went wrong" },
    });
    expect(decision.kind).toBe("abort");
    expect((decision as { reason: string }).reason).toContain("Something went wrong");
  });

  it("retries-with-truncation on first overflow error", () => {
    const decision = nextRetry({
      previousAttempts: 0,
      maxAttempts: 1,
      error: { message: "Context length exceeded" },
    });
    expect(decision.kind).toBe("retry-with-truncation");
    expect((decision as { nextAttempt: number }).nextAttempt).toBe(1);
  });

  it("aborts when max attempts exhausted", () => {
    const decision = nextRetry({
      previousAttempts: 1,
      maxAttempts: 1,
      error: { message: "max token limit reached" },
    });
    expect(decision.kind).toBe("abort");
    expect((decision as { reason: string }).reason).toContain("exhausted");
  });

  it.each([
    "context length exceeded",
    "max token limit reached",
    "request too large",
    "context overflow",
    "context window too long",
  ])("detects overflow from message: %s", (message) => {
    const decision = nextRetry({
      previousAttempts: 0,
      maxAttempts: 1,
      error: { message },
    });
    expect(decision.kind).toBe("retry-with-truncation");
  });

  it("uses custom tokensToTrim when provided", () => {
    const decision = nextRetry({
      previousAttempts: 0,
      maxAttempts: 1,
      error: { message: "context overflow" },
      tokensToTrim: 5000,
    });
    expect(decision.kind).toBe("retry-with-truncation");
    expect((decision as { tokensToTrim: number }).tokensToTrim).toBe(5000);
  });

  it("defaults tokensToTrim to 0", () => {
    const decision = nextRetry({
      previousAttempts: 0,
      maxAttempts: 1,
      error: { message: "context overflow" },
    });
    expect(decision.kind).toBe("retry-with-truncation");
    expect((decision as { tokensToTrim: number }).tokensToTrim).toBe(0);
  });
});
