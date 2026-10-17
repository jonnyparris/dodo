/**
 * state.writeFileBytes / readFileBytes through a real codemode sandbox.
 * Codemode sends host calls as JSON, which turned Uint8Array into
 * {"0":..} and broke binary writes (found writing a PNG in prod).
 */
import { env } from "cloudflare:workers";
import { createMemoryStateBackend } from "@cloudflare/shell";
import { describe, expect, it } from "vitest";
import { createExecuteTool, toBytes } from "../src/tools/execute-tool";
import type { Env } from "../src/types";

describe("execute tool: binary state calls", () => {
  it("writeFileBytes and readFileBytes round-trip bytes from the sandbox", async () => {
    const state = createMemoryStateBackend();
    const t = createExecuteTool({ tools: {}, state, loader: (env as unknown as Env).LOADER!, globalOutbound: null }) as unknown as {
      execute: (i: { code: string }, o: unknown) => Promise<{ result?: unknown; error?: string }>;
    };
    const out = await t.execute(
      { code: `async () => {
        await state.writeFileBytes("/a.png", new Uint8Array([137, 80, 78, 71, 0, 255]));
        await state.appendFile("/a.png", new Uint8Array([7]));
        const back = await state.readFileBytes("/a.png");
        return { len: new Uint8Array(back).length, bytes: Array.from(new Uint8Array(back)) };
      }` },
      { toolCallId: "t", messages: [] },
    );
    expect(out.error).toBeUndefined();
    expect(out.result).toEqual({ len: 7, bytes: [137, 80, 78, 71, 0, 255, 7] });
    expect(Array.from((await state.readFileBytes("/a.png"))!)).toEqual([137, 80, 78, 71, 0, 255, 7]);
  });

  it("toBytes rejects non-bytes", () => {
    expect(() => toBytes({ a: 1 })).toThrow(/expected bytes/);
    expect(Array.from(toBytes({ 0: 1, 1: 2 }))).toEqual([1, 2]);
  });
});
