// Throwaway worker: does leaseBrowser reuse land on the previous tab on
// real Browser Run? Deploy, hit /, then delete:
//   npx wrangler deploy -c scripts/probes/reuse-probe.wrangler.jsonc
//   npx wrangler delete -c scripts/probes/reuse-probe.wrangler.jsonc
// Expect reused:true, rawPages containing firstAt, and secondAt == firstAt.
import puppeteer from "@cloudflare/puppeteer";
import { leaseBrowser } from "../../src/browser/cdp-session";
const href = async (s: { send(m: string, p?: unknown): Promise<unknown> }) =>
  ((await s.send("Runtime.evaluate", { expression: "location.href", returnByValue: true })) as any).result.value;
export default {
  async fetch(_req: Request, env: any): Promise<Response> {
    const out: any = {};
    try {
      const a = await leaseBrowser(env.BROWSER, "probe");
      await a.session.send("Page.navigate", { url: "https://example.com/" });
      await new Promise((r) => setTimeout(r, 2500));
      out.firstAt = await href(a.session);
      const sid = a.session.browserSessionId!;
      await a.release(true);
      // Raw view of what puppeteer sees on reconnect.
      const br = await puppeteer.connect(env.BROWSER, sid);
      out.rawPages = (await br.pages()).map((p) => p.url());
      out.rawTargets = br.targets().map((t) => `${t.type()} ${t.url()}`);
      await br.disconnect();
      const b = await leaseBrowser(env.BROWSER, "probe");
      out.reused = b.reused;
      out.secondAt = await href(b.session);
      out.debug = b.session.getDebugLog(20).filter((e) => e.type !== "send" && e.type !== "receive");
      await b.session.close();
    } catch (e) { out.error = String(e); }
    return Response.json(out);
  },
};
