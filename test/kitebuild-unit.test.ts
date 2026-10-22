import { describe, expect, it } from "vitest";
import { buildCiRunTool, foldCiEvents, kitebuildConfigured } from "../src/tools/kitebuild";

const env = { KITEBUILD_URL: "https://kb.example/", KITEBUILD_CLIENT_ID: "id", KITEBUILD_CLIENT_SECRET: "secret" };

const ndjson = (events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

describe("kitebuild ci_run", () => {
  it("is off unless fully configured", () => {
    expect(kitebuildConfigured({})).toBe(false);
    expect(kitebuildConfigured({ KITEBUILD_URL: "x", KITEBUILD_CLIENT_ID: "y" })).toBe(false);
    expect(kitebuildConfigured(env)).toBe(true);
  });

  it("folds a failing run into per-stage results", () => {
    const r = foldCiEvents(
      ndjson([
        { t: "run", id: "run-1", stages: [] },
        { t: "stage", i: 0, status: "start" },
        { t: "out", i: 0, text: "cloned\n" },
        { t: "stage", i: 0, status: "end", code: 0, ms: 900 },
        { t: "stage", i: 1, status: "start" },
        { t: "out", i: 1, text: "FAIL test/a.test.ts\n" },
        { t: "stage", i: 1, status: "end", code: 1, ms: 4000 },
        { t: "done", code: 1, ms: 5000, timedOut: false },
      ]).split("\n"),
      ["git clone …", "npm test"],
    );
    expect(r.runId).toBe("run-1");
    expect(r.passed).toBe(false);
    expect(r.stages.map((s) => s.status)).toEqual(["passed", "failed"]);
    expect(r.stages[1]?.tail).toContain("FAIL test/a.test.ts");
  });

  it("treats a missing done event as not passed", () => {
    const r = foldCiEvents([JSON.stringify({ t: "stage", i: 0, status: "end", code: 0, ms: 1 })], ["x"]);
    expect(r.passed).toBe(false);
    expect(r.error).toMatch(/without a done event/);
  });

  it("posts clone + commands with Access headers and parses the stream", async () => {
    let sent: { url: string; headers: Headers; body: { commands: string[]; dir: string } } | undefined;
    const fetcher = (async (url: string, init: RequestInit) => {
      sent = { url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) };
      return new Response(ndjson([{ t: "run", id: "r" }, { t: "stage", i: 0, status: "end", code: 0, ms: 1 }, { t: "stage", i: 1, status: "end", code: 0, ms: 1 }, { t: "done", code: 0, ms: 2, timedOut: false }]));
    }) as unknown as typeof fetch;
    const t = buildCiRunTool(env, fetcher);
    const result = await t.execute!({ repoUrl: "https://github.com/o/r", branch: "feat/x", commands: ["npm test"] }, { toolCallId: "c", messages: [], context: {} });
    expect(sent?.url).toBe("https://kb.example/api/ci-runs");
    expect(sent?.headers.get("CF-Access-Client-Id")).toBe("id");
    expect(sent?.body.commands).toEqual(["git clone --depth 1 --branch feat/x https://github.com/o/r /tmp/repo", "npm test"]);
    expect(sent?.body.dir).toBe("/tmp/repo");
    expect((result as { passed: boolean }).passed).toBe(true);
  });

  it("rejects credentials in the clone URL and odd branch names", async () => {
    const t = buildCiRunTool(env, (async () => new Response("")) as unknown as typeof fetch);
    await expect(t.execute!({ repoUrl: "https://tok@github.com/o/r", branch: "main", commands: ["x"] }, { toolCallId: "c", messages: [], context: {} })).rejects.toThrow(/credentials/);
    await expect(t.execute!({ repoUrl: "https://github.com/o/r", branch: "main; rm -rf /", commands: ["x"] }, { toolCallId: "c", messages: [], context: {} })).rejects.toThrow(/branch/);
  });
});
