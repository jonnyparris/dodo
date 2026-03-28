import type { Env } from "./types";

export function sendNotification(
  env: Env,
  ctx: { waitUntil: (promise: Promise<unknown>) => void },
  options: { title: string; body: string; priority?: "min" | "low" | "default" | "high" | "urgent"; tags?: string; url?: string },
): void {
  if (!env.NTFY_TOPIC) {
    return;
  }

  const headers: Record<string, string> = {
    "Title": options.title,
    "Priority": options.priority ?? "default",
  };
  if (options.tags) {
    headers["Tags"] = options.tags;
  }
  if (options.url) {
    headers["Click"] = options.url;
  }

  ctx.waitUntil(
    fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
      body: options.body,
      headers,
      method: "POST",
    }).catch(() => {
      // Silently ignore notification failures
    }),
  );
}
