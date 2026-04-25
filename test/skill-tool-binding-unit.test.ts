/**
 * Regression test for the `this`-binding bug discovered in production
 * session 7ac07871-450b-4349-a1fb-adff01cbe4ea (first live test of the
 * skills feature). The bug:
 *
 *   const render = parent.renderSkillForTool;   // strips `this`
 *   render(name);                                 // throws inside method
 *
 * `renderSkillForTool` calls `this.getSkillByName(...)` internally; with
 * `this` lost, the lookup throws "Cannot read properties of undefined
 * (reading 'getSkillByName')" and the model surfaces that to the user.
 *
 * The fix: call methods on `parent` directly. This test pins the
 * contract — buildSkillTool's execute() must be safe to invoke against
 * a parent-like object whose methods rely on `this`.
 */
import { describe, expect, it } from "vitest";
import { buildToolsForThink } from "../src/agentic";

describe("skill tool — `this` binding", () => {
  it("does not strip `this` when invoking parent.renderSkillForTool", async () => {
    // Build a minimal parent-agent stub with the same shape CodingAgent
    // exposes. The methods reference `this` to mirror the real bug shape.
    const parent = {
      _skills: new Map([
        [
          "demo-skill",
          {
            name: "demo-skill",
            description: "demo description",
            body: "# Demo body content",
            source: "personal" as const,
            location: "test://demo",
            assetPaths: [] as string[],
            enabled: true,
          },
        ],
      ]),
      getSkillByName(name: string) {
        // This explicitly relies on `this` — reproduces the original bug
        // shape exactly. If `this` is lost, the next line throws.
        return this._skills.get(name) ?? null;
      },
      renderSkillForTool(name: string): string | null {
        const skill = this.getSkillByName(name);
        if (!skill) return null;
        return `<skill_content name="${skill.name}">${skill.body}</skill_content>`;
      },
      listSkillNames() {
        return [...this._skills.values()].map((s) => ({
          name: s.name,
          source: s.source,
        }));
      },
      // Stubs for the rest of the parentAgent contract so buildToolsForThink
      // doesn't choke on missing methods.
      runExploreFacet: async () => ({ ok: true as const, facetName: "x", summary: "", tokenInput: 0, tokenOutput: 0 }),
      runTaskFacet: async () => ({ ok: true as const, facetName: "x", summary: "", workspaceMode: "shared" as const, tokenInput: 0, tokenOutput: 0 }),
    };

    // Build the tool set with our stub as the parent agent. We don't need
    // a real workspace, env, or config for the skill tool path — they're
    // only used by other tools.
    const env = {} as never;
    const workspace = {} as never;
    const config = { activeGateway: "opencode", model: "test", aiGatewayBaseURL: "", gitAuthorEmail: "", gitAuthorName: "", opencodeBaseURL: "" } as never;

    const tools = buildToolsForThink(env, workspace, config, {
      parentAgent: parent as never,
    });

    expect(tools.skill).toBeDefined();
    const skillTool = tools.skill as { execute: (args: { name: string }) => Promise<string> };

    // The bug surfaced as: "Cannot read properties of undefined (reading 'getSkillByName')"
    // If the binding is correct, this returns the rendered content.
    const out = await skillTool.execute({ name: "demo-skill" });
    expect(out).toContain("# Demo body content");
    expect(out).not.toContain("Cannot read properties of undefined");
  });

  it("returns a not-found message with the available skills list", async () => {
    const parent = {
      _skills: new Map([
        [
          "real-skill",
          {
            name: "real-skill",
            description: "d",
            body: "b",
            source: "personal" as const,
            location: "x",
            assetPaths: [],
            enabled: true,
          },
        ],
      ]),
      getSkillByName(name: string) {
        return this._skills.get(name) ?? null;
      },
      renderSkillForTool(name: string): string | null {
        const skill = this.getSkillByName(name);
        if (!skill) return null;
        return `<skill_content>${skill.body}</skill_content>`;
      },
      listSkillNames() {
        return [...this._skills.values()].map((s) => ({ name: s.name, source: s.source }));
      },
      runExploreFacet: async () => ({ ok: true as const, facetName: "x", summary: "", tokenInput: 0, tokenOutput: 0 }),
      runTaskFacet: async () => ({ ok: true as const, facetName: "x", summary: "", workspaceMode: "shared" as const, tokenInput: 0, tokenOutput: 0 }),
    };

    const tools = buildToolsForThink({} as never, {} as never, { activeGateway: "opencode", model: "test", aiGatewayBaseURL: "", gitAuthorEmail: "", gitAuthorName: "", opencodeBaseURL: "" } as never, {
      parentAgent: parent as never,
    });
    const skillTool = tools.skill as { execute: (args: { name: string }) => Promise<string> };

    const out = await skillTool.execute({ name: "does-not-exist" });
    expect(out).toContain("not found");
    expect(out).toContain("real-skill");
  });
});
