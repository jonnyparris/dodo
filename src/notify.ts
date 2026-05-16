import { getUserControlStub } from "./auth";
import type { Env, WorkerRunRecord, WorkerRunStatus } from "./types";

/**
 * Outbound notification payload, target-agnostic. Channels translate
 * these fields into their own delivery format (ntfy headers today;
 * webhook templates, email, etc. in future).
 */
export type NotificationPayload = {
  title: string;
  body: string;
  priority?: "min" | "low" | "default" | "high" | "urgent";
  /** ntfy-flavoured hint; channels that don't understand tags ignore it. */
  tags?: string;
  /** Click-through URL (ntfy `Click` header, webhook templates, etc.). */
  url?: string;
  ownerEmail?: string;
};

/**
 * A configured delivery target. Implementations are stateless — each
 * `send()` is a one-shot fetch. Failures must not throw out of
 * `send()`; channels swallow errors so one failing target doesn't
 * block the others.
 */
export interface NotificationChannel {
  readonly id: string;
  send(payload: NotificationPayload): Promise<void>;
}

/**
 * Resolve a per-user secret, falling back to undefined.
 * Returns undefined on any error so notification failures stay non-fatal.
 */
async function readUserSecret(env: Env, ownerEmail: string, key: string): Promise<string | undefined> {
  try {
    const stub = getUserControlStub(env, ownerEmail);
    const response = await stub.fetch(`https://user-control/internal/secret/${encodeURIComponent(key)}`, {
      headers: { "x-owner-email": ownerEmail },
    });
    if (response.ok) {
      const { value } = (await response.json()) as { value: string };
      if (value) return value;
    }
  } catch {
    // Fall through
  }
  return undefined;
}

/**
 * Build the ntfy channel for this owner, if a topic is configured.
 * Tries per-user encrypted secret `ntfy_topic` first, then falls back
 * to the shared `NTFY_TOPIC` env var. Returns undefined when neither
 * is set — caller skips the channel.
 */
async function buildNtfyChannel(env: Env, ownerEmail?: string): Promise<NotificationChannel | undefined> {
  let topic: string | undefined;
  if (ownerEmail) topic = await readUserSecret(env, ownerEmail, "ntfy_topic");
  if (!topic) topic = env.NTFY_TOPIC;
  if (!topic) return undefined;

  return {
    id: "ntfy",
    async send(payload) {
      const headers: Record<string, string> = {
        Title: payload.title,
        Priority: payload.priority ?? "default",
      };
      if (payload.tags) headers.Tags = payload.tags;
      if (payload.url) headers.Click = payload.url;

      await fetch(`https://ntfy.sh/${topic}`, {
        body: payload.body,
        headers,
        method: "POST",
      }).catch(() => {
        // Silently ignore — notification failures are non-fatal.
      });
    },
  };
}

/**
 * Resolve all enabled notification channels for an owner. Today this
 * is just ntfy; future channels (generic webhook, email, etc.) plug
 * in here. Channels are independent — one returning undefined doesn't
 * stop the others.
 */
async function resolveChannels(env: Env, ownerEmail?: string): Promise<NotificationChannel[]> {
  const channels: NotificationChannel[] = [];
  const ntfy = await buildNtfyChannel(env, ownerEmail);
  if (ntfy) channels.push(ntfy);
  return channels;
}

/**
 * Dispatch a notification to every configured channel for this owner.
 * Fire-and-forget via `ctx.waitUntil` — the call returns immediately
 * and delivery happens out-of-band. Per-channel failures are swallowed
 * inside each channel's `send()`.
 */
export function sendNotification(
  env: Env,
  ctx: { waitUntil: (promise: Promise<unknown>) => void },
  options: NotificationPayload,
): void {
  ctx.waitUntil(
    (async () => {
      const channels = await resolveChannels(env, options.ownerEmail);
      if (channels.length === 0) return;
      await Promise.all(channels.map((channel) => channel.send(options).catch(() => {})));
    })(),
  );
}

const RUN_STATUS_NOTIFY_CONFIG: Partial<Record<WorkerRunStatus, { titleSuffix: string; priority: "default" | "high"; tags: string }>> = {
  done: { titleSuffix: "done", priority: "default", tags: "white_check_mark,robot" },
  failed: { titleSuffix: "failed", priority: "high", tags: "x,robot" },
};

/**
 * Send a push notification when a worker run transitions to a notable
 * status. Only fires for terminal statuses (done, failed) to avoid
 * notification spam on every intermediate state change.
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
