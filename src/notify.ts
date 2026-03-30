import { getUserControlStub } from "./auth";
import type { Env } from "./types";

/**
 * Resolve the ntfy topic for notifications.
 * Tries per-user encrypted secret first, falls back to env var.
 */
async function resolveNtfyTopic(env: Env, ownerEmail?: string): Promise<string | undefined> {
  // Try per-user secret
  if (ownerEmail) {
    try {
      const stub = getUserControlStub(env, ownerEmail);
      const response = await stub.fetch("https://user-control/internal/secret/ntfy_topic", {
        headers: { "x-owner-email": ownerEmail },
      });
      if (response.ok) {
        const { value } = (await response.json()) as { value: string };
        if (value) return value;
      }
    } catch {
      // Fall through to env var
    }
  }

  return env.NTFY_TOPIC;
}

export function sendNotification(
  env: Env,
  ctx: { waitUntil: (promise: Promise<unknown>) => void },
  options: { title: string; body: string; priority?: "min" | "low" | "default" | "high" | "urgent"; tags?: string; url?: string; ownerEmail?: string },
): void {
  ctx.waitUntil(
    (async () => {
      const topic = await resolveNtfyTopic(env, options.ownerEmail);
      if (!topic) return;

      const headers: Record<string, string> = {
        Title: options.title,
        Priority: options.priority ?? "default",
      };
      if (options.tags) {
        headers.Tags = options.tags;
      }
      if (options.url) {
        headers.Click = options.url;
      }

      await fetch(`https://ntfy.sh/${topic}`, {
        body: options.body,
        headers,
        method: "POST",
      }).catch(() => {
        // Silently ignore notification failures
      });
    })(),
  );
}
