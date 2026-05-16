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
 * Priority ordering, low → high. Used by webhook channels with a
 * `minPriority` filter.
 */
const PRIORITY_ORDER = ["min", "low", "default", "high", "urgent"] as const;
type Priority = (typeof PRIORITY_ORDER)[number];

function priorityRank(p: Priority | undefined): number {
  return PRIORITY_ORDER.indexOf(p ?? "default");
}

/**
 * Per-webhook configuration stored as JSON inside the encrypted secret
 * `notification_webhooks`. The blob is an array — each entry creates
 * one outbound channel.
 *
 * Body templates use `{{field}}` placeholders for `title`, `body`,
 * `priority`, `tags`, `url`. When the request body is JSON
 * (the default), values are JSON-escaped automatically so the
 * template stays valid post-substitution. For non-JSON content types,
 * values are substituted as-is.
 *
 * Header values can be inline (`headers`) or resolved from another
 * encrypted secret (`headerSecrets` maps header name → secret key).
 * This keeps auth tokens out of the channel config blob itself.
 */
type WebhookConfig = {
  id: string;
  url: string;
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  headerSecrets?: Record<string, string>;
  bodyTemplate: string;
  contentType?: string;
  minPriority?: Priority;
};

/** Render `{{field}}` placeholders. When `jsonEscape` is true (the
 *  default for JSON bodies), substitutes JSON-escaped string contents
 *  so the surrounding template stays parseable. Exported for unit
 *  testing — production code uses it via the webhook channel. */
export function renderTemplate(
  template: string,
  payload: NotificationPayload,
  jsonEscape: boolean,
): string {
  const fields: Record<string, string> = {
    title: payload.title,
    body: payload.body,
    priority: payload.priority ?? "default",
    tags: payload.tags ?? "",
    url: payload.url ?? "",
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = fields[key] ?? "";
    if (!jsonEscape) return value;
    // JSON.stringify wraps in quotes — slice them off so the template
    // can decide its own quoting.
    return JSON.stringify(value).slice(1, -1);
  });
}

/** Resolve a header map by merging literal headers with secret-backed
 *  ones. Header secrets that fail to resolve are silently dropped so a
 *  missing token doesn't surface as a notification crash — the
 *  resulting request just goes out without that header. */
async function resolveWebhookHeaders(
  env: Env,
  ownerEmail: string | undefined,
  config: WebhookConfig,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...(config.headers ?? {}) };
  headers["Content-Type"] ??= config.contentType ?? "application/json";
  if (config.headerSecrets && ownerEmail) {
    for (const [headerName, secretKey] of Object.entries(config.headerSecrets)) {
      const value = await readUserSecret(env, ownerEmail, secretKey);
      if (value) headers[headerName] = value;
    }
  }
  return headers;
}

/** Build a single webhook channel from its config. The returned
 *  channel renders the body template per-call and respects
 *  `minPriority` if set. */
function buildWebhookChannel(
  env: Env,
  ownerEmail: string | undefined,
  config: WebhookConfig,
): NotificationChannel {
  return {
    id: `webhook:${config.id}`,
    async send(payload) {
      if (config.minPriority && priorityRank(payload.priority) < priorityRank(config.minPriority)) {
        return;
      }
      const contentType = config.contentType ?? "application/json";
      const jsonEscape = contentType.includes("json");
      const body = renderTemplate(config.bodyTemplate, payload, jsonEscape);
      const headers = await resolveWebhookHeaders(env, ownerEmail, config);
      await fetch(config.url, {
        method: config.method ?? "POST",
        headers,
        body,
      }).catch(() => {
        // Silently ignore — notification failures are non-fatal.
      });
    },
  };
}

/** Load configured webhooks from the encrypted secret
 *  `notification_webhooks`. Malformed JSON or missing required fields
 *  on individual entries are ignored — a broken entry must not stop
 *  other channels from delivering. */
async function loadWebhookConfigs(env: Env, ownerEmail?: string): Promise<WebhookConfig[]> {
  if (!ownerEmail) return [];
  const raw = await readUserSecret(env, ownerEmail, "notification_webhooks");
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is WebhookConfig => {
      if (typeof entry !== "object" || entry === null) return false;
      const e = entry as Record<string, unknown>;
      return typeof e.id === "string" && typeof e.url === "string" && typeof e.bodyTemplate === "string";
    });
  } catch {
    return [];
  }
}

/**
 * Resolve all enabled notification channels for an owner. Channels
 * are independent — one returning undefined doesn't stop the others.
 *
 * Channel order today:
 *   1. ntfy (per-user secret or env fallback)
 *   2. generic webhooks (zero or more, from `notification_webhooks` secret)
 *
 * Future channels (email, etc.) plug in here.
 */
async function resolveChannels(env: Env, ownerEmail?: string): Promise<NotificationChannel[]> {
  const channels: NotificationChannel[] = [];
  const ntfy = await buildNtfyChannel(env, ownerEmail);
  if (ntfy) channels.push(ntfy);
  const webhookConfigs = await loadWebhookConfigs(env, ownerEmail);
  for (const config of webhookConfigs) {
    channels.push(buildWebhookChannel(env, ownerEmail, config));
  }
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
