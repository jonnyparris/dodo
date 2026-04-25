/**
 * Unit tests for the skill registry — the SKILL.md frontmatter parser,
 * manifest renderer, tool-output formatter, and merge logic. Pure unit
 * tests with no DO/network dependencies.
 *
 * The skill registry is the storage-and-merge layer for Dodo's
 * Claude/OpenCode-compatible SKILL.md feature. See src/skill-registry.ts
 * for the full design rationale.
 */

import { describe, expect, it } from "vitest";
import {
  mergeSkills,
  normalizeFrontmatter,
  parseSkillFile,
  renderManifest,
  renderSkillContent,
  SkillFrontmatterError,
  type Skill,
} from "../src/skill-registry";

describe("parseSkillFile", () => {
  it("parses the canonical SKILL.md shape", () => {
    const raw = [
      "---",
      "name: backlog-groom",
      "description: Triage a JIRA backlog ticket-by-ticket.",
      "---",
      "",
      "# Body",
      "",
      "Goes here.",
    ].join("\n");
    const { frontmatter, body } = parseSkillFile(raw);
    expect(frontmatter.name).toBe("backlog-groom");
    expect(frontmatter.description).toBe("Triage a JIRA backlog ticket-by-ticket.");
    expect(body).toContain("# Body");
    expect(body).toContain("Goes here.");
  });

  it("strips a leading BOM", () => {
    const raw = "\uFEFF---\nname: x\ndescription: y\n---\nbody";
    const { frontmatter } = parseSkillFile(raw);
    expect(frontmatter.name).toBe("x");
  });

  it("throws when the file does not start with frontmatter", () => {
    expect(() => parseSkillFile("# Just a markdown")).toThrow(SkillFrontmatterError);
  });

  it("throws when the frontmatter is unterminated", () => {
    expect(() => parseSkillFile("---\nname: x\nno terminator")).toThrow(SkillFrontmatterError);
  });

  it("preserves extra frontmatter fields verbatim (loose validation)", () => {
    // OpenCode tolerates extra fields. Make sure we do too — the codex
    // skill in the agent-hq workspace ships `version`, `last_updated`,
    // `rfc_coverage`, etc.
    const raw = [
      "---",
      "name: codex",
      "description: engineering codex",
      'version: "1.2.0"',
      "rfc_coverage:",
      "  - rfc-1",
      "  - rfc-2",
      "---",
      "body",
    ].join("\n");
    const { frontmatter } = parseSkillFile(raw);
    expect(frontmatter.version).toBe("1.2.0");
    expect(frontmatter.rfc_coverage).toEqual(["rfc-1", "rfc-2"]);
  });

  it("handles block-scalar descriptions (description: |)", () => {
    const raw = [
      "---",
      "name: long-desc",
      "description: |",
      "  Multi-line description",
      "  spanning two lines.",
      "---",
      "body",
    ].join("\n");
    const { frontmatter } = parseSkillFile(raw);
    expect(frontmatter.description).toContain("Multi-line description");
    expect(frontmatter.description).toContain("spanning two lines");
  });
});

describe("normalizeFrontmatter", () => {
  it("returns a SkillInput when fields are valid", () => {
    const out = normalizeFrontmatter(
      { name: "ok-skill", description: "desc" },
      "body content",
    );
    expect(out.name).toBe("ok-skill");
    expect(out.description).toBe("desc");
    expect(out.body).toBe("body content");
  });

  it("rejects missing name", () => {
    expect(() =>
      normalizeFrontmatter({ description: "desc" }, "body"),
    ).toThrow(SkillFrontmatterError);
  });

  it("rejects missing description", () => {
    expect(() =>
      normalizeFrontmatter({ name: "x" }, "body"),
    ).toThrow(SkillFrontmatterError);
  });

  it("rejects names with bad characters", () => {
    expect(() =>
      normalizeFrontmatter({ name: "Bad Name!", description: "d" }, "b"),
    ).toThrow(SkillFrontmatterError);
  });

  it("clamps description to 1024 chars", () => {
    const long = "x".repeat(2000);
    const out = normalizeFrontmatter({ name: "x", description: long }, "b");
    expect(out.description.length).toBe(1024);
  });

  it("middle-truncates body over the size cap", () => {
    const huge = "a".repeat(40_000);
    const out = normalizeFrontmatter({ name: "x", description: "d" }, huge);
    expect(out.body).toContain("[... truncated");
    expect(out.body.length).toBeLessThan(huge.length);
  });

  it("warns but does not throw on dirName mismatch", () => {
    // Loose validation — log only. (OpenCode is strict here; we are not
    // because it breaks third-party imports.)
    const out = normalizeFrontmatter(
      { name: "real-name", description: "d" },
      "b",
      { dirName: "other-name" },
    );
    expect(out.name).toBe("real-name");
  });
});

describe("renderManifest", () => {
  const baseSkill = (name: string, source: Skill["source"]): Skill => ({
    name,
    description: `${name} description`,
    body: "body",
    source,
    location: "test://x",
    assetPaths: [],
    enabled: true,
  });

  it("emits the OpenCode-shaped <available_skills> block", () => {
    const out = renderManifest([
      baseSkill("alpha", "personal"),
      baseSkill("beta", "workspace"),
      baseSkill("gamma", "builtin"),
    ]);
    expect(out).toContain("<available_skills>");
    expect(out).toContain("</available_skills>");
    expect(out).toContain("<name>alpha</name>");
    expect(out).toContain("<source>personal</source>");
    expect(out).toContain("<source>workspace</source>");
    expect(out).toContain("<source>builtin</source>");
  });

  it("returns an empty string when there are no skills", () => {
    expect(renderManifest([])).toBe("");
  });

  it("filters out disabled skills", () => {
    const skills = [
      { ...baseSkill("on", "personal") },
      { ...baseSkill("off", "personal"), enabled: false },
    ];
    const out = renderManifest(skills);
    expect(out).toContain("<name>on</name>");
    expect(out).not.toContain("<name>off</name>");
  });

  it("orders by source rank (personal → workspace → builtin)", () => {
    const out = renderManifest([
      baseSkill("z-builtin", "builtin"),
      baseSkill("a-workspace", "workspace"),
      baseSkill("m-personal", "personal"),
    ]);
    const personalIdx = out.indexOf("m-personal");
    const workspaceIdx = out.indexOf("a-workspace");
    const builtinIdx = out.indexOf("z-builtin");
    expect(personalIdx).toBeLessThan(workspaceIdx);
    expect(workspaceIdx).toBeLessThan(builtinIdx);
  });

  it("escapes XML special chars in name and description", () => {
    const out = renderManifest([
      {
        ...baseSkill("ok", "personal"),
        description: "uses < and > and & symbols",
      },
    ]);
    expect(out).toContain("uses &lt; and &gt; and &amp; symbols");
    expect(out).not.toContain("uses < and > and &");
  });

  it("truncates with a marker when the rendered manifest exceeds the cap", () => {
    // Each entry is ~150 bytes; 100 of them well exceeds the 4 KB budget.
    const many: Skill[] = [];
    for (let i = 0; i < 100; i++) {
      many.push({
        ...baseSkill(`s${String(i).padStart(3, "0")}`, "personal"),
        description: "x".repeat(200),
      });
    }
    const out = renderManifest(many);
    expect(out).toContain("<truncated count=");
    expect(out.length).toBeLessThan(5000);
  });
});

describe("renderSkillContent", () => {
  it("emits the on-demand skill_content tool output", () => {
    const out = renderSkillContent({
      name: "demo",
      description: "demo desc",
      body: "# Demo body",
      source: "personal",
      location: "do://test/demo",
      assetPaths: ["scripts/run.sh", "references/notes.md"],
      enabled: true,
    });
    expect(out).toContain('<skill_content name="demo">');
    expect(out).toContain("</skill_content>");
    expect(out).toContain("# Demo body");
    expect(out).toContain("Source: personal");
    expect(out).toContain("<file>scripts/run.sh</file>");
    expect(out).toContain("<file>references/notes.md</file>");
  });

  it("omits the file list when there are no bundled files", () => {
    const out = renderSkillContent({
      name: "lite",
      description: "no assets",
      body: "body",
      source: "builtin",
      location: "builtin://lite",
      assetPaths: [],
      enabled: true,
    });
    expect(out).not.toContain("<skill_files>");
  });
});

describe("mergeSkills", () => {
  const make = (name: string, source: Skill["source"]): Skill => ({
    name,
    description: `${source}/${name}`,
    body: "b",
    source,
    location: source,
    assetPaths: [],
    enabled: true,
  });

  it("deduplicates by name with personal > workspace > builtin precedence", () => {
    const personal = [make("foo", "personal")];
    const workspace = [make("foo", "workspace"), make("bar", "workspace")];
    const builtin = [make("foo", "builtin"), make("baz", "builtin")];

    const merged = mergeSkills(personal, workspace, builtin);
    expect(merged.map((s) => s.name)).toEqual(["foo", "bar", "baz"]);
    const foo = merged.find((s) => s.name === "foo");
    expect(foo?.source).toBe("personal");
    const bar = merged.find((s) => s.name === "bar");
    expect(bar?.source).toBe("workspace");
  });

  it("returns an empty list when all sources are empty", () => {
    expect(mergeSkills([], [], [])).toEqual([]);
  });
});
