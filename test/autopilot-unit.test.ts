import { describe, expect, it } from "vitest";
import {
  buildDiagnoseGoal,
  buildDiagnosePrompt,
  buildSupervisorGoal,
  buildSupervisorPrompt,
  resolveAutopilotOwner,
} from "../src/autopilot";
import type { Env } from "../src/types";

describe("buildDiagnoseGoal", () => {
  it("includes target area when set", () => {
    const prompt = buildDiagnoseGoal({ targetArea: "session creation" });
    expect(prompt).toContain("session creation");
    expect(prompt).toContain("Target area");
  });

  it("falls back to a 'pick the highest-impact' instruction when no target", () => {
    const prompt = buildDiagnoseGoal({});
    expect(prompt).toContain("highest-impact");
  });

  it("includes supervisor notes when provided", () => {
    const prompt = buildDiagnoseGoal({ contextNotes: "skip migrations" });
    expect(prompt).toContain("skip migrations");
    expect(prompt).toContain("Supervisor notes");
  });

  it("uses the provided sinceHours value in the fetch_worker_logs hint", () => {
    const prompt = buildDiagnoseGoal({ sinceHours: 48 });
    expect(prompt).toContain("sinceHours=48");
  });

  it("defaults sinceHours to 24", () => {
    const prompt = buildDiagnoseGoal({});
    expect(prompt).toContain("sinceHours=24");
  });

  it("uses the provided branch prefix", () => {
    const prompt = buildDiagnoseGoal({ branchPrefix: "ap/test" });
    expect(prompt).toContain("ap/test-{short-sha}");
  });

  it("includes the hard safety rails (no auto-merge, no force-push, no migrations)", () => {
    const prompt = buildDiagnoseGoal({});
    expect(prompt).toContain("Draft PR only");
    expect(prompt).toContain("NEVER auto-merge");
    expect(prompt).toContain("force-push");
  });

  it("instructs the worker to call set_goal_status at terminal states", () => {
    const prompt = buildDiagnoseGoal({});
    expect(prompt).toContain("set_goal_status");
    expect(prompt).toContain("done");
    expect(prompt).toContain("blocked");
    expect(prompt).toContain("needs_input");
  });

  it("buildDiagnosePrompt is an alias for buildDiagnoseGoal", () => {
    // Back-compat for any caller still importing the old name.
    expect(buildDiagnosePrompt).toBe(buildDiagnoseGoal);
  });
});

describe("buildSupervisorGoal", () => {
  it("references the dispatch tool by name", () => {
    const prompt = buildSupervisorGoal();
    expect(prompt).toContain("dispatch_autopilot_worker");
    expect(prompt).toContain("list_failed_sessions");
    expect(prompt).toContain("list_autopilot_workers");
  });

  it("caps worker dispatches at 3 per run", () => {
    const prompt = buildSupervisorGoal();
    expect(prompt).toContain("Max 3");
    expect(prompt).toContain("max 3 per supervisor run");
  });

  it("includes the stuck-pattern detection rule", () => {
    const prompt = buildSupervisorGoal();
    expect(prompt).toContain("third supervisor run");
    expect(prompt).toContain("autopilot paused");
  });

  it("uses default sinceHours of 12 in the log sweep", () => {
    const prompt = buildSupervisorGoal();
    expect(prompt).toContain("sinceHours=12");
  });

  it("respects sinceHours overrides", () => {
    const prompt = buildSupervisorGoal({ sinceHours: 6 });
    expect(prompt).toContain("sinceHours=6");
  });

  it("buildSupervisorPrompt is an alias for buildSupervisorGoal", () => {
    expect(buildSupervisorPrompt).toBe(buildSupervisorGoal);
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
