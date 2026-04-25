/**
 * Unit tests for the artifacts read path.
 *
 * Focus: the pure helpers (clone URL builder, tree listing). The
 * clone/fetch primitives go through isomorphic-git over HTTP and need
 * a real remote — covered separately by integration tests when we want
 * to exercise the cache-refresh logic end-to-end.
 *
 * For tree listing, we hand-build an InMemoryFs with a tiny working
 * copy and a fake `.git` dir to confirm:
 *   - Children of `/` are returned, `.git` hidden
 *   - Sizes + mime types come back correct
 *   - Sub-directory listing works
 *   - File reads return content
 *   - Nonexistent paths return null (so the caller falls back)
 */
import { InMemoryFs } from "@cloudflare/shell";
import { describe, expect, it } from "vitest";
import {
  type ArtifactsFsCache,
  buildArtifactsCloneUrl,
  listArtifactsTree,
  readArtifactsFile,
} from "../src/artifacts-read";

function makeCache(): ArtifactsFsCache {
  const fs = new InMemoryFs();
  fs.mkdirSync("/repo", { recursive: true });
  // Working copy
  fs.mkdirSync("/repo/src", { recursive: true });
  fs.writeFileSync("/repo/README.md", "# hello\n");
  fs.writeFileSync("/repo/package.json", '{"name":"demo"}');
  fs.writeFileSync("/repo/src/index.ts", "export const x = 1;\n");
  // Pretend `.git` exists — listArtifactsTree hides it
  fs.mkdirSync("/repo/.git/objects", { recursive: true });
  fs.writeFileSync("/repo/.git/HEAD", "ref: refs/heads/main\n");
  return { fs, dir: "/repo", dirty: false };
}

describe("buildArtifactsCloneUrl", () => {
  it("injects basic auth credentials into an https remote", () => {
    const url = buildArtifactsCloneUrl(
      "https://artifacts.example.com/repos/dodo-abc.git",
      "tok_supersecret",
    );
    expect(url).toBe("https://x:tok_supersecret@artifacts.example.com/repos/dodo-abc.git");
  });

  it("strips the ?expires= suffix from tokens before injecting them", () => {
    // Tokens minted by the artifacts binding come back with an expiry
    // query string. Leaving it on the password side of the basic-auth
    // header poisons the auth — strip it here too.
    const url = buildArtifactsCloneUrl(
      "https://artifacts.example.com/dodo-x.git",
      "tok_abc?expires=1700000000",
    );
    expect(url).toBe("https://x:tok_abc@artifacts.example.com/dodo-x.git");
  });

  it("preserves an existing path on the remote", () => {
    const url = buildArtifactsCloneUrl(
      "https://artifacts.example.com/account/123/dodo-y.git",
      "tok",
    );
    expect(url).toContain("/account/123/dodo-y.git");
  });

  it("preserves a non-default port on the remote", () => {
    // Self-hosted artifacts deployments could run on a non-443 port.
    // The URL builder must not drop or rewrite it.
    const url = buildArtifactsCloneUrl(
      "https://artifacts.example.com:8443/dodo-z.git",
      "tok",
    );
    expect(url).toBe("https://x:tok@artifacts.example.com:8443/dodo-z.git");
  });

  it("URL-encodes a token containing reserved characters", () => {
    // Tokens are opaque to us — if the artifacts service ever mints
    // one with `/`, `?`, `#`, `@`, or `:` it must be percent-encoded
    // when injected into the basic-auth slot, otherwise the URL
    // parser will misinterpret it as path/query/fragment/auth.
    const url = buildArtifactsCloneUrl(
      "https://artifacts.example.com/dodo.git",
      "tok/with:weird@chars",
    );
    // URL.password setter percent-encodes when written, so we expect
    // the encoded form back.
    const parsed = new URL(url);
    expect(parsed.username).toBe("x");
    expect(decodeURIComponent(parsed.password)).toBe("tok/with:weird@chars");
  });

  it("does not corrupt a clone URL that already has credentials", () => {
    // If the caller hands us a URL that already includes auth, we
    // overwrite — the new short-lived token replaces whatever was
    // there. This matches what isomorphic-git's onAuth callback does
    // and avoids accidentally leaking a stale credential downstream.
    const url = buildArtifactsCloneUrl(
      "https://oldUser:oldPass@artifacts.example.com/dodo.git",
      "newTok",
    );
    const parsed = new URL(url);
    expect(parsed.username).toBe("x");
    expect(parsed.password).toBe("newTok");
  });
});

describe("listArtifactsTree", () => {
  it("returns top-level children with sizes and mime types, hiding .git", async () => {
    const cache = makeCache();
    const result = await listArtifactsTree(cache, "/");
    expect(result).not.toBeNull();
    const names = result!.entries.map((e) => e.name);
    expect(names).not.toContain(".git");
    expect(names).toContain("src");
    expect(names).toContain("README.md");
    expect(names).toContain("package.json");

    const readme = result!.entries.find((e) => e.name === "README.md")!;
    expect(readme.type).toBe("file");
    expect(readme.size).toBe("# hello\n".length);
    expect(readme.mimeType).toBe("text/markdown");

    const src = result!.entries.find((e) => e.name === "src")!;
    expect(src.type).toBe("directory");
    expect(src.mimeType).toBe("inode/directory");
  });

  it("sorts directories before files, then alphabetically", async () => {
    const cache = makeCache();
    const result = await listArtifactsTree(cache, "/");
    expect(result).not.toBeNull();
    // `src` (directory) first; then files in localeCompare order, which
    // puts lowercase before uppercase under the default locale.
    const names = result!.entries.map((e) => e.name);
    expect(names).toEqual(["src", "package.json", "README.md"]);
  });

  it("lists children of a sub-directory", async () => {
    const cache = makeCache();
    const result = await listArtifactsTree(cache, "/src");
    expect(result).not.toBeNull();
    expect(result!.entries.map((e) => e.name)).toEqual(["index.ts"]);
    const index = result!.entries[0];
    expect(index.type).toBe("file");
    expect(index.mimeType).toBe("text/javascript");
    expect(index.path).toBe("/src/index.ts");
  });

  it("normalises trailing slashes on the requested path", async () => {
    const cache = makeCache();
    const result = await listArtifactsTree(cache, "/src/");
    expect(result).not.toBeNull();
    expect(result!.entries.map((e) => e.name)).toEqual(["index.ts"]);
  });

  it("returns null for a path that doesn't exist (caller falls back)", async () => {
    const cache = makeCache();
    const result = await listArtifactsTree(cache, "/does-not-exist");
    expect(result).toBeNull();
  });
});

describe("readArtifactsFile", () => {
  it("returns file content and the requested path", async () => {
    const cache = makeCache();
    const result = await readArtifactsFile(cache, "/README.md");
    expect(result).toEqual({ content: "# hello\n", path: "/README.md" });
  });

  it("normalises path without leading slash", async () => {
    const cache = makeCache();
    const result = await readArtifactsFile(cache, "package.json");
    expect(result).not.toBeNull();
    expect(result!.path).toBe("/package.json");
    expect(result!.content).toBe('{"name":"demo"}');
  });

  it("returns null for missing files (caller falls back to workspace)", async () => {
    const cache = makeCache();
    const result = await readArtifactsFile(cache, "/missing.txt");
    expect(result).toBeNull();
  });

  it("returns null for the root path (which is a directory, not a file)", async () => {
    const cache = makeCache();
    const result = await readArtifactsFile(cache, "/");
    expect(result).toBeNull();
  });
});
