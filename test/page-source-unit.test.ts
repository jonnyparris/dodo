import { describe, expect, it } from "vitest";
import { WebFetchError } from "agents/webfetch";
import { createDodoPageSource, isChallengePage, PageCache, type BrowserMarkdownFetcher } from "../src/browser/page-source";
import { createWebFetchTools, renderBrowserMarkdown, type JevAi } from "../src/browser/web-fetch";

function stubFetch(
  body: BodyInit | null,
  init: ResponseInit = {},
  seen: Request[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL, reqInit?: RequestInit) => {
    seen.push(new Request(input, reqInit));
    return new Response(body, init);
  }) as typeof fetch;
}

/** Workers AI stub: toMarkdown returns `data`; Clef returns `noul`. */
function stubAi(data: string, noul = 0.9, calls: string[] = []): JevAi {
  return {
    toMarkdown: async (file: MarkdownDocument | MarkdownDocument[]) => {
      calls.push((file as { name: string }).name);
      return { id: "1", name: "x", mimeType: "text/html", format: "markdown", tokens: 1, data };
    },
    run: async () => ({ answers: { has_answer: { type: "noul", noul } } }),
  } as unknown as JevAi;
}

/** What Browser Run CDP returned for www.npmjs.com/package/agents on preview, 10-21 (shape, not byte-exact). */
const CF_INTERSTITIAL = `---
title: Just a moment...
---

# www.npmjs.com

## Performing security verification

This website uses a security service to protect against malicious bots. This page is displayed while the website verifies you are not a bot.

Ray ID: 9a1b2c3d4e5f6789

Performance and Security by Cloudflare`;

const LONG_MD = `# Title\n\n${"Some real content here. ".repeat(20)}`;
const html = { headers: { "content-type": "text/html; charset=utf-8" } };

function browserStub(markdown: string | null, seen: string[] = []): BrowserMarkdownFetcher {
  return async (url, errors) => {
    seen.push(url);
    if (markdown === null) {
      errors.push("quickAction: down");
      return null;
    }
    return { markdown, via: "quickAction" };
  };
}

describe("createDodoPageSource", () => {
  it("negotiates markdown first, skips conversion, and caches the page", async () => {
    const seen: Request[] = [];
    const calls: string[] = [];
    const source = createDodoPageSource({
      ai: stubAi("unused", 0.9, calls) as unknown as Ai,
      cache: new PageCache(),
      fetch: stubFetch(LONG_MD, { headers: { "content-type": "text/markdown" } }, seen),
    });
    const first = await source.fetch({ url: "https://example.com/docs" });
    const second = await source.fetch({ url: "https://example.com/docs" });
    expect(first).toMatchObject({ via: "markdown-negotiated", status: 200, content: LONG_MD });
    expect(second).toBe(first);
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.get("accept")?.startsWith("text/markdown")).toBe(true);
    expect(calls).toEqual([]);
  });

  it("converts HTML with Workers AI", async () => {
    const calls: string[] = [];
    const source = createDodoPageSource({
      ai: stubAi(LONG_MD, 0.9, calls) as unknown as Ai,
      cache: new PageCache(),
      fetch: stubFetch("<html><body>hi</body></html>", html),
    });
    const page = await source.fetch({ url: "https://example.com/" });
    expect(page.via).toBe("converted");
    expect(calls).toHaveLength(1);
  });

  it("falls back to Browser Run on a 403 page", async () => {
    const seen: string[] = [];
    const source = createDodoPageSource({
      ai: stubAi(LONG_MD) as unknown as Ai,
      cache: new PageCache(),
      fetch: stubFetch("<html>Forbidden</html>", { status: 403, ...html }),
      browser: browserStub("# From browser", seen),
    });
    const page = await source.fetch({ url: "https://e.com/protected" });
    expect(page).toMatchObject({ via: "rendered", content: "# From browser", status: 200 });
    expect((page as { notes?: string[] }).notes?.[0]).toContain("HTTP 403");
    expect(seen).toEqual(["https://e.com/protected"]);
  });

  it("falls back to Browser Run on a bot challenge", async () => {
    const source = createDodoPageSource({
      ai: stubAi(LONG_MD) as unknown as Ai,
      cache: new PageCache(),
      fetch: stubFetch("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } }),
      browser: browserStub("# Past the challenge"),
    });
    const page = await source.fetch({ url: "https://e.com/" });
    expect(page.content).toBe("# Past the challenge");
  });

  it("reports blocked when Browser Run renders the challenge interstitial", async () => {
    const cache = new PageCache();
    const source = createDodoPageSource({
      ai: stubAi(LONG_MD) as unknown as Ai,
      cache,
      fetch: stubFetch("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } }),
      browser: async () => ({ markdown: CF_INTERSTITIAL, via: "cdp" }),
    });
    const failure = source.fetch({ url: "https://www.npmjs.com/package/agents" });
    await expect(failure).rejects.toMatchObject({ code: "web_fetch_blocked" });
    await expect(failure).rejects.toThrow(/Browser Run \(cdp\) got a bot-challenge page/);
    expect(cache.get("auto https://www.npmjs.com/package/agents")).toBeNull();
  });

  it("does not return a plain-fetch challenge page as content when the browser fails", async () => {
    const source = createDodoPageSource({
      ai: stubAi(CF_INTERSTITIAL) as unknown as Ai,
      cache: new PageCache(),
      fetch: stubFetch("<html>challenge</html>", { status: 403, ...html }),
      browser: browserStub(null),
    });
    await expect(source.fetch({ url: "https://e.com/" })).rejects.toMatchObject({ code: "web_fetch_blocked" });
  });

  it("sends a 200 challenge page to the browser", async () => {
    const source = createDodoPageSource({
      ai: stubAi(CF_INTERSTITIAL) as unknown as Ai,
      cache: new PageCache(),
      fetch: stubFetch("<html>challenge</html>", html),
      browser: browserStub("# The real page"),
    });
    const page = await source.fetch({ url: "https://e.com/" });
    expect(page.content).toBe("# The real page");
    expect((page as { notes?: string[] }).notes?.[0]).toContain("bot-challenge page");
  });

  it("does not use the browser for a 404", async () => {
    const seen: string[] = [];
    const source = createDodoPageSource({
      ai: stubAi(LONG_MD) as unknown as Ai,
      cache: new PageCache(),
      fetch: stubFetch("", { status: 404 }),
      browser: browserStub("# unused", seen),
    });
    await expect(source.fetch({ url: "https://e.com/missing" })).rejects.toMatchObject({
      code: "web_fetch_http_error",
      status: 404,
    });
    expect(seen).toEqual([]);
  });

  it("keeps a thin SPA shell with a note when the browser fails", async () => {
    const source = createDodoPageSource({
      ai: stubAi("Loading...") as unknown as Ai,
      cache: new PageCache(),
      fetch: stubFetch("<div id=app></div>", html),
      browser: browserStub(null),
    });
    const page = await source.fetch({ url: "https://spa.e.com/" });
    expect(page.content).toBe("Loading...");
    const notes = (page as { notes?: string[] }).notes ?? [];
    expect(notes[0]).toContain("client-rendered");
    expect(notes).toContain("quickAction: down");
  });

  it("keeps the quick-action error in the notes when CDP rescues the page", async () => {
    const source = createDodoPageSource({
      ai: stubAi("Loading...") as unknown as Ai,
      cache: new PageCache(),
      fetch: stubFetch("<div id=app></div>", html),
      browser: async (_url, errors) => {
        errors.push("quickAction: boom");
        return { markdown: LONG_MD, via: "cdp" };
      },
    });
    const page = await source.fetch({ url: "https://spa2.e.com/" });
    const notes = (page as { notes?: string[] }).notes ?? [];
    expect(notes[0]).toContain("Rendered with Browser Run (cdp)");
    expect(notes).toContain("quickAction: boom");
  });

  it("ignores frontmatter when spotting a thin shell", async () => {
    const shell = `---\ntitle: Free, collaborative whiteboard\ndescription: ${"An app. ".repeat(30)}\n---\n\nLoading`;
    const source = createDodoPageSource({
      ai: stubAi(shell) as unknown as Ai,
      cache: new PageCache(),
      fetch: stubFetch("<div id=root></div>", html),
      browser: browserStub("# Rendered app"),
    });
    expect((await source.fetch({ url: "https://app.e.com/" })).via).toBe("rendered");
  });

  it("refuses private hosts before fetching", async () => {
    const seen: Request[] = [];
    const source = createDodoPageSource({
      ai: stubAi("") as unknown as Ai,
      cache: new PageCache(),
      fetch: stubFetch("x", {}, seen),
    });
    for (const bad of ["http://localhost:3000", "http://127.0.0.1", "http://192.168.1.4", "http://[::1]/", "file:///etc/passwd"]) {
      await expect(source.fetch({ url: bad }), bad).rejects.toBeInstanceOf(WebFetchError);
    }
    expect(seen).toEqual([]);
  });

  it("times out a slow plain fetch without falling back", async () => {
    const slow = ((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const source = createDodoPageSource({
      ai: stubAi("") as unknown as Ai,
      cache: new PageCache(),
      fetch: slow,
      directTimeoutMs: 50,
      browser: browserStub("# unused"),
    });
    await expect(source.fetch({ url: "https://slow.e.com/" })).rejects.toMatchObject({ code: "web_fetch_timeout" });
  });
});

describe("isChallengePage", () => {
  it.each([
    ["Cloudflare managed challenge", CF_INTERSTITIAL],
    ["Cloudflare JS challenge", "# Just a moment...\n\nChecking if the site connection is secure\n\nexample.com needs to review the security of your connection before proceeding."],
    ["Cloudflare block page", "# Attention Required! | Cloudflare\n\nSorry, you have been blocked"],
    ["Turnstile", "Verify you are human by completing the action below."],
    ["PerimeterX", "# Access to this page has been denied\n\nPress & Hold to confirm you are a human (and not a bot)."],
    ["DataDome", "Please enable JS and disable any ad blocker\n\n![](https://geo.captcha-delivery.com/captcha/?initialCid=x)"],
    // Live plain fetch of g2.com / etsy.com, 2026-10-21: toMarkdown keeps only this line.
    ["DataDome (text only)", "Please enable JS and disable any ad blocker"],
    ["Imperva", "Request unsuccessful. Incapsula incident ID: 123-456"],
    ["Akamai", "# Access Denied\n\nYou don't have permission to access \"http://e.com/\" on this server.\n\nReference #18.abc"],
  ])("spots %s", (_name, markdown) => {
    expect(isChallengePage(markdown)).toBe(true);
  });

  it("leaves real pages alone, including long ones that discuss challenges", () => {
    expect(isChallengePage(LONG_MD)).toBe(false);
    expect(isChallengePage("# Just a moment in time\n\nA short story.")).toBe(false);
    const article = `# How Cloudflare's challenge works\n\nThe page says "Performing security verification" while it runs.\n\n${"Detail. ".repeat(400)}`;
    expect(isChallengePage(article)).toBe(false);
  });
});

describe("browser_markdown (agents/webfetch/ai-sdk)", () => {
  type Tool = {
    execute: (input: Record<string, unknown>, options?: object) => Promise<unknown>;
    toModelOutput: (options: { output: unknown }) => { type: string; value: string };
  };
  const toolFor = (ai: JevAi, fetchImpl: typeof fetch, browser?: Fetcher) =>
    createWebFetchTools({ ai, fetch: fetchImpl, browser, cache: new PageCache() }).browser_markdown as Tool;

  it("windows long pages, reads window 2 from cache, and renders the SDK header", async () => {
    let fetches = 0;
    const body = `${"a line of text\n".repeat(3000)}`;
    const fetchImpl = (async () => {
      fetches++;
      return new Response(body, { headers: { "content-type": "text/markdown" } });
    }) as typeof fetch;
    const tool = toolFor(stubAi(""), fetchImpl);
    const first = (await tool.execute({ url: "https://e.com/long" })) as { nextOffset: number | null };
    expect(first.nextOffset).toBeGreaterThan(0);
    const text = tool.toModelOutput({ output: first }).value;
    expect(text).toMatch(/^web_fetch: https:\/\/e\.com\/long · 200 · text\/markdown → markdown · chars 0–\d+ of 45000 · continue with offset=\d+/);
    expect(text).toContain("<untrusted_web_content>");
    const second = (await tool.execute({ url: "https://e.com/long", offset: first.nextOffset })) as { offset: number };
    expect(second.offset).toBe(first.nextOffset);
    expect(fetches).toBe(1);
  });

  it("adds the Clef verdict when a query is passed", async () => {
    const tool = toolFor(stubAi("", 0.83), stubFetch(LONG_MD, { headers: { "content-type": "text/markdown" } }));
    const output = await tool.execute({ url: "https://e.com/", query: "what is this" });
    expect(output).toMatchObject({ verdict: { hasAnswer: 0.83 } });
    expect(tool.toModelOutput({ output }).value).toContain("hasAnswer: 0.83");
  });

  it("returns the SDK's model-facing error as error-text", async () => {
    const tool = toolFor(stubAi(""), stubFetch("", { status: 404 }));
    const output = await tool.execute({ url: "https://e.com/missing" });
    expect(output).toMatchObject({ code: "web_fetch_http_error" });
    const rendered = tool.toModelOutput({ output });
    expect(rendered.type).toBe("error-text");
    expect(rendered.value).toContain("HTTP 404");
  });

  it("tries CDP after a challenged quick action, then reports blocked with a browser_execute hint", async () => {
    const browser = {
      quickAction: async () =>
        new Response(JSON.stringify({ result: CF_INTERSTITIAL }), { headers: { "content-type": "application/json" } }),
      // No CDP in unit tests: the connect attempt fails, which is the "CDP also failed" case.
      fetch: async () => new Response("no cdp", { status: 500 }),
    } as unknown as Fetcher;
    const tool = toolFor(stubAi(""), stubFetch("", { status: 403, headers: { "cf-mitigated": "challenge" } }), browser);
    const output = await tool.execute({ url: "https://www.npmjs.com/package/agents" });
    expect(output).toMatchObject({ code: "web_fetch_blocked" });
    const rendered = tool.toModelOutput({ output });
    expect(rendered.type).toBe("error-text");
    expect(rendered.value).toContain("bot challenge");
    expect(rendered.value).toContain("browser_execute");
    expect(rendered.value).not.toContain("Performing security verification");
  });

  it("treats a quick action whose meta says 403 as blocked, even with title-only Markdown", async () => {
    // Live /markdown for g2.com (DataDome), 2026-10-21: the quick action answers 200,
    // meta.status is 403 and result is just frontmatter, which no text pattern catches.
    const browser = {
      quickAction: async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: "---\ntitle: g2.com\n---",
            meta: { status: 403, title: "g2.com", headers: { server: "cloudflare", "x-datadome": "protected" } },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      fetch: async () => new Response("no cdp", { status: 500 }),
    } as unknown as Fetcher;
    const tool = toolFor(stubAi(""), stubFetch("", { status: 403 }), browser);
    const output = await tool.execute({ url: "https://www.g2.com/products/slack/reviews" });
    expect(output).toMatchObject({ code: "web_fetch_blocked" });
    const rendered = tool.toModelOutput({ output });
    expect(rendered.value).toContain("browser_execute");
    expect(rendered.value).not.toContain("title: g2.com");
  });

  it("treats a quick action whose meta has cf-mitigated as blocked", async () => {
    const browser = {
      quickAction: async () =>
        new Response(
          JSON.stringify({ result: "# Some page", meta: { status: 200, headers: { "CF-Mitigated": "challenge" } } }),
          { headers: { "content-type": "application/json" } },
        ),
      fetch: async () => new Response("no cdp", { status: 500 }),
    } as unknown as Fetcher;
    const tool = toolFor(stubAi(""), stubFetch("", { status: 403 }), browser);
    const output = await tool.execute({ url: "https://e.com/mitigated" });
    expect(output).toMatchObject({ code: "web_fetch_blocked" });
    expect(tool.toModelOutput({ output }).value).not.toContain("# Some page");
  });

  it("returns quick action content when meta.status is 200", async () => {
    const browser = {
      quickAction: async () =>
        new Response(
          JSON.stringify({ result: "# Example Domain", meta: { status: 200, headers: { server: "cloudflare" } } }),
          { headers: { "content-type": "application/json" } },
        ),
    } as unknown as Fetcher;
    const tool = toolFor(stubAi(""), stubFetch("", { status: 429 }), browser);
    const output = await tool.execute({ url: "https://e.com/ok" });
    expect(output).toMatchObject({ via: "rendered", content: "# Example Domain" });
  });

  it("uses the Browser Run quick action when blocked and says so", async () => {
    const browser = {
      quickAction: async () =>
        new Response(JSON.stringify({ result: "# From browser" }), { headers: { "content-type": "application/json" } }),
    } as unknown as Fetcher;
    const tool = toolFor(stubAi(""), stubFetch("", { status: 429 }), browser);
    const output = await tool.execute({ url: "https://e.com/rate-limited" });
    expect(output).toMatchObject({ via: "rendered", content: "# From browser" });
    const text = renderBrowserMarkdown(output as Parameters<typeof renderBrowserMarkdown>[0]);
    expect(text).toContain("→ rendered markdown");
    expect(text).toContain("note: Rendered with Browser Run (quickAction)");
  });

  it("calls quickAction as a method on an RPC-stub-like binding (no .bind)", async () => {
    // Real bindings are RPC stubs: property access on a method returns another
    // remote stub, so quickAction.bind(...) calls a remote "bind" and throws.
    const quickAction = new Proxy(
      async () =>
        new Response(JSON.stringify({ result: "# From stub" }), { headers: { "content-type": "application/json" } }),
      {
        get(target, prop) {
          if (prop === "bind" || prop === "call" || prop === "apply") {
            return () => {
              throw new TypeError(`The RPC receiver does not implement the method "${String(prop)}".`);
            };
          }
          return Reflect.get(target, prop);
        },
      },
    );
    const browser = { quickAction } as unknown as Fetcher;
    const tool = toolFor(stubAi(""), stubFetch("", { status: 429 }), browser);
    const output = await tool.execute({ url: "https://e.com/stub" });
    expect(output).toMatchObject({ via: "rendered", content: "# From stub" });
  });
});
