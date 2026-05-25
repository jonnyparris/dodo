import { describe, expect, it } from "vitest";
import { buildDiagnosePrompt, buildSupervisorPrompt, resolveAutopilotOwner } from "../src/autopilot";
import type { Env } from "../src/types";

describe("buildDiagnosePrompt", () => {
  it("includes target area when set", () => {
    const prompt = buildDiagnosePrompt({ targetArea: "session creation" });
    expect(prompt).toContain("session creation");
    expect(prompt).toContain("Target area");
  });

  it("falls back to a 'pick the highest-impact' instruction when no target", () => {
    const prompt = buildDiagnosePrompt({});
    expect(prompt).toContain("highest-impact");
  });

  it("includes supervisor notes when provided", () => {
    const prompt = buildDiagnosePrompt({ contextNotes: "skip migrations" });
    expect(prompt).toContain("skip migrations");
    expect(prompt).toContain("Supervisor notes");
  });

  it("uses the provided sinceHours value in the fetch_worker_logs hint", () => {
    const prompt = buildDiagnosePrompt({ sinceHours: 48 });
    expect(prompt).toContain("sinceHours=48");
  });

  it("defaults sinceHours to 24", () => {
    const prompt = buildDiagnosePrompt({});
    expect(prompt).toContain("sinceHours=24");
  });

  it("uses the provided branch prefix", () => {
    const prompt = buildDiagnosePrompt({ branchPrefix: "ap/test" });
    expect(prompt).toContain("ap/test-{short-sha}");
  });

  it("includes the hard safety rails", () => {
    const prompt = buildDiagnosePrompt({});
    expect(prompt).toContain("50 tool turns");
    expect(prompt).toContain("Draft PR only");
    expect(prompt).toContain("NEVER auto-merge");
  });
});

describe("buildSupervisorPrompt", () => {
  it("references the dispatch tool by name", () => {
    const prompt = buildSupervisorPrompt();
    expect(prompt).toContain("dispatch_autopilot_worker");
    expect(prompt).toContain("list_failed_sessions");
    expect(prompt).toContain("list_autopilot_workers");
  });

  it("caps worker dispatches at 3 per run", () => {
    const prompt = buildSupervisorPrompt();
    expect(prompt).toContain("Max 3");
    expect(prompt).toContain("max 3 per supervisor run");
  });

  it("includes the stuck-pattern detection rule", () => {
    const prompt = buildSupervisorPrompt();
    expect(prompt).toContain("third supervisor run");
    expect(prompt).toContain("autopilot paused");
  });

  it("uses default sinceHours of 12 in the log sweep", () => {
    const prompt = buildSupervisorPrompt();
    expect(prompt).toContain("sinceHours=12");
  });

  it("respects sinceHours overrides", () => {
    const prompt = buildSupervisorPrompt({ sinceHours: 6 });
    expect(prompt).toContain("sinceHours=6");
  });
});

describe("resolveAutopilotOwner", () => {
  it("returns the canonicalised admin email", () => {
    const result = resolveAutopilotOwner({ ADMIN_EMAIL: "  Admin@example.com  " } as Env);
    expect(result).toBe("admin@example.com");
  });

  it("throws when ADMIN_EMAIL is missing", () => {
    expect(() => resolveAutopilotOwner({} as Env)).toThrow(/ADMIN_EMAIL not configured/);
  });
});
