import { describe, expect, it } from "vitest";
import { createWorkspaceTools, fuzzyReplace, type WorkspaceOperations } from "../src/tools/workspace-tools";

function memWorkspace(files: Record<string, string> = {}): WorkspaceOperations & { files: Map<string, string> } {
  const map = new Map(Object.entries(files));
  const dirs = () => new Set([...map.keys()].flatMap((p) => p.split("/").slice(1, -1).map((_, i, a) => `/${a.slice(0, i + 1).join("/")}`)));
  const globRe = (g: string) =>
    new RegExp(`^/?${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "\u0001").replace(/\*/g, "[^/]*").replace(/\?/g, ".").replace(/\u0001/g, "(?:.*/)?")}$`);
  return {
    files: map,
    readFile: async (p) => map.get(p) ?? null,
    stat: async (p) => (map.has(p) ? { type: "file", size: map.get(p)!.length } : dirs().has(p) ? { type: "directory" } : null),
    writeFile: async (p, c) => void map.set(p, c),
    mkdir: async () => {},
    readDir: async (d) => [...map.keys()].filter((p) => p.startsWith(`${d.replace(/\/$/, "")}/`)).map((p) => ({ name: p.split("/").pop()!, type: "file", size: map.get(p)!.length })),
    glob: async (g) => [...map.keys()].filter((p) => globRe(g).test(p)).map((p) => ({ path: p, type: "file", size: map.get(p)!.length })),
    rm: async (p) => void map.delete(p),
  };
}
const run = (t: unknown, input: unknown) => (t as { execute: (i: unknown, o: unknown) => Promise<any> }).execute(input, { toolCallId: "t", messages: [] });

describe("workspace tools (ported from Think)", () => {
  it("exposes the same tool names", () => {
    expect(Object.keys(createWorkspaceTools(memWorkspace())).sort()).toEqual(["delete", "edit", "find", "grep", "list", "read", "write"]);
  });

  it("read numbers lines and pages with offset/limit", async () => {
    const t = createWorkspaceTools(memWorkspace({ "/a.txt": "one\ntwo\nthree" }));
    expect(await run(t.read, { path: "/a.txt", offset: 2, limit: 1 })).toEqual({ path: "/a.txt", content: "2\ttwo", totalLines: 3, fromLine: 2, toLine: 2 });
    expect(await run(t.read, { path: "/nope" })).toEqual({ error: "File not found: /nope" });
  });

  it("edit keeps $& and $1 in the replacement literal (Think's string replace expanded them)", async () => {
    const ws = memWorkspace({ "/s.sh": 'echo "OLD"\n' });
    const t = createWorkspaceTools(ws);
    expect((await run(t.edit, { path: "/s.sh", old_string: '"OLD"', new_string: '"$1 costs $&"' })).replaced).toBe(true);
    expect(ws.files.get("/s.sh")).toBe('echo "$1 costs $&"\n');
  });

  it("edit: unique match required, whitespace-tolerant fallback", async () => {
    const ws = memWorkspace({ "/f.ts": "a();\na();\n  if (x)  {\n" });
    const t = createWorkspaceTools(ws);
    expect((await run(t.edit, { path: "/f.ts", old_string: "a();", new_string: "b();" })).error).toContain("appears 2 times");
    const fuzzy = await run(t.edit, { path: "/f.ts", old_string: "if (x) {", new_string: "if (y) {" });
    expect(fuzzy.fuzzyMatch).toBe(true);
    expect(ws.files.get("/f.ts")).toContain("  if (y) {");
    expect(fuzzyReplace("a  b\na b", "a b", "z")).toBe("ambiguous");
  });

  it("grep finds matches with context; find globs; write and delete", async () => {
    const ws = memWorkspace({ "/src/x.ts": "const a = 1;\nconst needle = 2;\n", "/src/y.md": "needle" });
    const t = createWorkspaceTools(ws);
    const g = await run(t.grep, { query: "needle", include: "**/*.ts", contextLines: 1 });
    expect(g.totalMatches).toBe(1);
    expect(g.matches[0].context).toContain("> 2\tconst needle = 2;");
    expect((await run(t.find, { pattern: "**/*.md" })).files).toEqual(["/src/y.md"]);
    await run(t.write, { path: "/new/z.txt", content: "hi" });
    expect(ws.files.get("/new/z.txt")).toBe("hi");
    await run(t.delete, { path: "/new/z.txt" });
    expect(ws.files.has("/new/z.txt")).toBe(false);
  });
});
