import { getUserControlStub } from "./auth";
import type { Env, WorkerRunRecord, WorkerRunStatus } from "./types";

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

const RUN_STATUS_NOTIFY_CONFIG: Partial<Record<WorkerRunStatus, { titleSuffix: string; priority: "default" | "high"; tags: string }>> = {
  done: { titleSuffix: "done", priority: "default", tags: "white_check_mark,robot" },
  failed: { titleSuffix: "failed", priority: "high", tags: "x,robot" },
};

/**
 * Send an ntfy push notification when a worker run transitions to a notable status.
 * Only fires for terminal statuses (done, failed) to avoid notification spam on every
 * intermediate state change.
 */
export function sendRunNotification(
  env: Env,
  ctx: { waitUntil: (promise: Promise<unknown>) => void },
  run: WorkerRunRecord,
  oldStatus: WorkerRunStatus,
  ownerEmail?: string,
): void {
  if (run.status === oldStatus) return;
  const config = RUN_STATUS_NOTIFY_CONFIG[run.status];
  if (!config) return;

  const lines: string[] = [
    `Branch: ${run.branch}`,
    `Session: ${run.sessionId}`,
  ];
  if (run.lastError) {
    lines.push(`Error: ${run.lastError.slice(0, 200)}`);
  }
  if (run.failureSnapshotId) {
    lines.push(`Snapshot: ${run.failureSnapshotId}`);
  }

  sendNotification(env, ctx, {
    title: `Dodo: ${run.title} ${config.titleSuffix}`,
    body: lines.join("\n"),
    priority: config.priority,
    tags: config.tags,
    ownerEmail,
  });
}
