/**
 * Completion webhook ("doorbell"). A caller passes `callbackUrl` with a
 * prompt; whenever a prompt in that session finishes, Dodo POSTs
 * `{ event, sessionId, promptId, status, needsInput }` to it. No output is
 * sent: the receiver fetches the result through its normal, authenticated
 * path (MCP get_messages). A forged or replayed doorbell can only make the
 * receiver check early.
 */

const WEBHOOK_TIMEOUT_MS = 10_000;
const WEBHOOK_ATTEMPTS = 2;

/** Returns an error message, or null when the URL is acceptable. Empty string = clear. Pure. */
export function checkCallbackUrl(raw: string): string | null {
  if (raw === "") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "callbackUrl must be an absolute https URL";
  }
  if (url.protocol !== "https:") return "callbackUrl must use https";
  if (url.username || url.password) return "callbackUrl must not embed credentials";
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || /^[\d.]+$/.test(host) || host.includes(":")) {
    return "callbackUrl must use a public hostname";
  }
  return null;
}

export async function postCompletionWebhook(url: string, body: string, fetcher: typeof fetch = fetch): Promise<void> {
  let lastError = "";
  for (let attempt = 1; attempt <= WEBHOOK_ATTEMPTS; attempt++) {
    try {
      const res = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "dodo-completion-webhook/1" },
        body,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) break; // receiver said no; don't retry
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`completion webhook: ${lastError}`);
}
