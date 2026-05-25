import { describe, expect, it } from "vitest";
import { assembleSystemPrompt } from "../src/prompt-composer";

describe("assembleSystemPrompt", () => {
  it("returns static base when no extras provided", () => {
    const result = assembleSystemPrompt({ staticBase: "You are Dodo." });
    expect(result).toBe("You are Dodo.");
  });

  it("inlines skill manifest", () => {
    const result = assembleSystemPrompt({
      staticBase: "Base.",
      skillManifest: "<skills>foo</skills>",
    });
    expect(result).toContain("Base.");
    expect(result).toContain("<skills>foo</skills>");
    // Skill manifest should come after base.
    expect(result.indexOf("Base.")).toBeLessThan(result.indexOf("<skills>"));
  });

  it("appends browser section after skill manifest", () => {
    const result = assembleSystemPrompt({
      staticBase: "Base.",
      skillManifest: "Skills.",
      browserSection: "Browser tools...",
    });
    const skillIdx = result.indexOf("Skills.");
    const browserIdx = result.indexOf("Browser tools...");
    expect(skillIdx).toBeLessThan(browserIdx);
  });

  it("prepends user prefix at the very top", () => {
    const result = assembleSystemPrompt({
      staticBase: "Base.",
      userPrefix: "Be extra concise.",
    });
    expect(result.startsWith("Be extra concise.")).toBe(true);
    expect(result).toContain("---");
    expect(result).toContain("Base.");
  });

  it("includes workspace summary when provided", () => {
    const result = assembleSystemPrompt({
      staticBase: "Base.",
      workspaceSummary: "```\nfoo.ts\nbar.ts\n```",
    });
    expect(result).toContain("## Current workspace");
    expect(result).toContain("foo.ts");
  });

  it("includes project instructions when provided", () => {
    const result = assembleSystemPrompt({
      staticBase: "Base.",
      projectInstructions: "Loaded from AGENTS.md",
    });
    expect(result).toContain("## Project instructions");
    expect(result).toContain("Loaded from AGENTS.md");
  });

  it("truncates when maxLengthBytes is exceeded", () => {
    const result = assembleSystemPrompt({
      staticBase: "A".repeat(200),
      maxLengthBytes: 100,
    });
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toContain("[...truncated...]");
  });

  it("ordering is stable: prefix → base → skills → browser → workspace → project", () => {
    const result = assembleSystemPrompt({
      staticBase: "BASE",
      skillManifest: "SKILLS",
      browserSection: "BROWSER",
      workspaceSummary: "WORKSPACE",
      projectInstructions: "PROJECT",
      userPrefix: "PREFIX",
    });
    const indices = [
      { name: "PREFIX", idx: result.indexOf("PREFIX") },
      { name: "BASE", idx: result.indexOf("BASE") },
      { name: "SKILLS", idx: result.indexOf("SKILLS") },
      { name: "BROWSER", idx: result.indexOf("BROWSER") },
      { name: "WORKSPACE", idx: result.indexOf("WORKSPACE") },
      { name: "PROJECT", idx: result.indexOf("PROJECT") },
    ];
    for (let i = 1; i < indices.length; i++) {
      expect(
        indices[i].idx,
        `${indices[i].name} should come after ${indices[i - 1].name}`,
      ).toBeGreaterThan(indices[i - 1].idx);
    }
  });

  it("admin prefix sits above user prefix", () => {
    const result = assembleSystemPrompt({
      staticBase: "BASE",
      userPrefix: "USER-PREFIX",
      adminPrefix: "ADMIN-PREFIX",
    });
    expect(result.startsWith("ADMIN-PREFIX")).toBe(true);
    const adminIdx = result.indexOf("ADMIN-PREFIX");
    const userIdx = result.indexOf("USER-PREFIX");
    const baseIdx = result.indexOf("BASE");
    expect(adminIdx).toBeLessThan(userIdx);
    expect(userIdx).toBeLessThan(baseIdx);
  });

  it("admin prefix alone works without user prefix", () => {
    const result = assembleSystemPrompt({
      staticBase: "BASE",
      adminPrefix: "ADMIN-ONLY",
    });
    expect(result.startsWith("ADMIN-ONLY")).toBe(true);
    expect(result).toContain("BASE");
    expect(result.indexOf("ADMIN-ONLY")).toBeLessThan(result.indexOf("BASE"));
  });
});
