/**
 * Real just-bash in a dynamic Worker, through the CodingAgent workspace.
 * @cloudflare/computer's fs adapter dropped just-bash's "binary" write
 * encoding, so every redirect wrote stdout (a latin1 byte string) as UTF-8:
 * `base64 -d > x.png` gained a 0xC2 before 0x89. UTF-8 text happened to
 * survive; the text checks guard the fix against breaking it.
 * src/tools/shell-patch.ts fixes the adapter.
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it, vi } from "vitest";
import { runShellBatch } from "../src/tools/shell";
import type { Env } from "../src/types";

vi.mock("../src/agentic", async () => await import("./helpers/agentic-mock"));
vi.mock("../src/pi/models", async () => await import("./helpers/pi-models-mock"));

const PNG_HEAD = "iVBORw0KGgo="; // 89 50 4E 47 0D 0A 1A 0A
const inDO = runInDurableObject as unknown as <T>(stub: unknown, fn: (instance: any) => Promise<T>) => Promise<T>;

describe("shell redirects write bytes, not UTF-8 re-encoded text", () => {
  it("binary and non-ASCII text survive > and >>", async () => {
    const stub = await getAgentByName((env as unknown as Env).CODING_AGENT as never, crypto.randomUUID());
    await inDO(stub, async (instance) => {
      const runtime = instance.computerWorkspace.runtime;
      const r = await runShellBatch(runtime, {
        commands: [
          `echo '${PNG_HEAD}' | base64 -d > /a.png`,
          `echo '/wE=' | base64 -d >> /a.png`, // FF 01 (just-bash printf '\\377' emits UTF-8 U+00FF, unlike bash)
          `echo 'héllo ✓' > /t.txt`,
          `printf 'ü' >> /t.txt`,
        ],
      });
      expect(r.results.map((x) => x.exit)).toEqual([0, 0, 0, 0]);
      const png = await instance.workspace.readFileBytes("/a.png");
      expect(Array.from(png)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x01]);
      expect(await instance.workspace.readFile("/t.txt")).toBe("héllo ✓\nü");
      // And the shell reads them back the same way.
      const back = await runShellBatch(runtime, { commands: ["base64 /a.png", "cat /t.txt"] });
      expect(back.results[0]!.stdout.trim()).toBe("iVBORw0KGgr/AQ==");
      expect(back.results[1]!.stdout).toBe("héllo ✓\nü");
    });
  });
});

describe("patchShellSource", () => {
  it("throws when the upstream adapter changes shape, and is idempotent", async () => {
    const { patchShellSource, byteSafeShellModules } = await import("../src/tools/shell-patch");
    expect(() => patchShellSource("class X {}")).toThrow(/changed shape/);
    const patched = byteSafeShellModules()["shell.js"]!.js;
    expect(patched).toContain("__dodoEncodeContent(content, options)");
    expect(patchShellSource(patched)).toBe(patched);
  });
});
