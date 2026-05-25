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

/** Semantic kind of notification — drives priority mapping and filtering. */
export type NotificationKind =
  | "prompt-complete"
  | "prompt-error"
  | "prompt-aborted"
  | "watchdog-stalled"
  | "run-done"
  | "run-failed"
  | "autopilot";

/** Input to the pure planning phase. */
export interface NotificationInput extends NotificationPayload {
  kind: NotificationKind;
}

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
 * Resolved, plain-data channel configuration. Produced by the impure
 * `resolveNotificationConfig` and consumed by the pure `planNotification`.
 */
export interface ResolvedNtfyConfig {
  type: "ntfy";
  topic: string;
  /**
   * Base URL the publish is POSTed to, with no trailing slash. When
   * unset, defaults to `https://ntfy.sh`. Self-hosted deployments
   * point this at an ntfy-compatible worker URL.
   */
  baseUrl?: string;
  /**
   * Optional bearer token sent as `Authorization: Bearer <token>` on
   * publish. Per-user `ntfy_token` secret overrides the `NTFY_TOKEN`
   * env var so the workspace token can be replaced per owner without
   * a redeploy.
   */
  token?: string;
}

export interface ResolvedWebhookConfig {
  type: "webhook";
  id: string;
  url: string;
  method?: "POST" | "PUT";
  headers: Record<string, string>;
  bodyTemplate: string;
  contentType?: string;
  minPriority?: Priority;
}

export type ResolvedChannelConfig = ResolvedNtfyConfig | ResolvedWebhookConfig;

/**
 * Per-user notification configuration resolved from secrets/env.
 * This is the bridge between the impure secret-resolution world and
 * the pure planning world.
 */
export interface UserNotificationConfig {
  channels: ResolvedChannelConfig[];
  /** Optional per-kind priority overrides. When absent, the input's own priority is used. */
  priorities?: Partial<Record<NotificationKind, Priority>>;
}

/** One rendered message ready for a specific channel. */
export interface PlannedChannelMessage {
  channel: ResolvedChannelConfig;
  body: string;
  title: string;
  priority: Priority;
  tags?: string;
  url?: string;
}

/** The result of pure planning — a manifest of what to send and what was skipped. */
export interface NotificationPlan {
  perChannelMessages: PlannedChannelMessage[];
  skipped: Array<{ channelType: string; channelId?: string; reason: string }>;
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
 * Resolve all enabled notification channels for an owner into plain
 * data configs. This is the impure boundary — it reads secrets and
 * env vars. The result is fed into the pure `planNotification`.
 */
export async function resolveNotificationConfig(env: Env, ownerEmail?: string): Promise<UserNotificationConfig> {
  const channels: ResolvedChannelConfig[] = [];

  // ntfy
  let topic: string | undefined;
  if (ownerEmail) topic = await readUserSecret(env, ownerEmail, "ntfy_topic");
  if (!topic) topic = env.NTFY_TOPIC;
  if (topic) {
    // Trim trailing slashes so we can append `/${topic}` unconditionally.
    const baseUrl = (env.NTFY_BASE_URL ?? "https://ntfy.sh").replace(/\/+$/, "");
    let token: string | undefined;
    if (ownerEmail) token = await readUserSecret(env, ownerEmail, "ntfy_token");
    if (!token) token = env.NTFY_TOKEN;
    channels.push({ type: "ntfy", topic, baseUrl, token });
  }

  // webhooks
  const webhookConfigs = await loadWebhookConfigs(env, ownerEmail);
  for (const config of webhookConfigs) {
    const headers = await resolveWebhookHeaders(env, ownerEmail, config);
    channels.push({
      type: "webhook",
      id: config.id,
      url: config.url,
      method: config.method,
      headers,
      bodyTemplate: config.bodyTemplate,
      contentType: config.contentType,
      minPriority: config.minPriority,
    });
  }

  return { channels };
}

/**
 * Pure function: given a notification input and resolved user config,
 * produce a plan of exactly which messages go to which channels and
 * which channels are skipped (with reasons).
 *
 * No fetch, no waitUntil, no storage access. Testable as plain data.
 */
export function planNotification(input: NotificationInput, config: UserNotificationConfig): NotificationPlan {
  const perChannelMessages: PlannedChannelMessage[] = [];
  const skipped: NotificationPlan["skipped"] = [];

  const effectivePriority: Priority = config.priorities?.[input.kind] ?? input.priority ?? "default";

  for (const channel of config.channels) {
    if (channel.type === "ntfy") {
      perChannelMessages.push({
        channel,
        title: input.title,
        body: input.body,
        priority: effectivePriority,
        tags: input.tags,
        url: input.url,
      });
      continue;
    }

    if (channel.type === "webhook") {
      if (channel.minPriority && priorityRank(effectivePriority) < priorityRank(channel.minPriority)) {
        skipped.push({
          channelType: "webhook",
          channelId: channel.id,
          reason: `priority ${effectivePriority} below minPriority ${channel.minPriority}`,
        });
        continue;
      }
      const contentType = channel.contentType ?? "application/json";
      const jsonEscape = contentType.includes("json");
      const body = renderTemplate(channel.bodyTemplate, { ...input, priority: effectivePriority }, jsonEscape);
      perChannelMessages.push({
        channel,
        title: input.title,
        body,
        priority: effectivePriority,
        tags: input.tags,
        url: input.url,
      });
    }
  }

  return { perChannelMessages, skipped };
}

/**
 * Impure function: execute a notification plan by iterating
 * `perChannelMessages` and firing each over its channel. Failures
 * are swallowed per-channel so one failing target doesn't block
 * the others.
 */
export async function sendNotification(plan: NotificationPlan, _env: Env): Promise<void> {
  await Promise.all(
    plan.perChannelMessages.map(async (message) => {
      const channel = message.channel;
      try {
        if (channel.type === "ntfy") {
          const headers: Record<string, string> = {
            Title: message.title,
            Priority: message.priority,
          };
          if (message.tags) headers.Tags = message.tags;
          if (message.url) headers.Click = message.url;
          if (channel.token) headers.Authorization = `Bearer ${channel.token}`;

          const baseUrl = (channel.baseUrl ?? "https://ntfy.sh").replace(/\/+$/, "");
          await fetch(`${baseUrl}/${channel.topic}`, {
            body: message.body,
            headers,
            method: "POST",
          });
        } else if (channel.type === "webhook") {
          await fetch(channel.url, {
            method: channel.method ?? "POST",
            headers: channel.headers,
            body: message.body,
          });
        }
      } catch {
        // Silently ignore — notification failures are non-fatal.
      }
    }),
  );
}

/**
 * Convenience: resolve config, plan, and dispatch inside `waitUntil`.
 * Returns the plan synchronously so callers can observe what was
 * composed. This is the stable public surface for existing call sites.
 */
export function dispatchNotification(
  env: Env,
  ctx: { waitUntil: (promise: Promise<unknown>) => void },
  input: NotificationInput,
): void {
  ctx.waitUntil(
    (async () => {
      const config = await resolveNotificationConfig(env, input.ownerEmail);
      const plan = planNotification(input, config);
      if (plan.perChannelMessages.length === 0) return;
      await sendNotification(plan, env);
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
  const statusConfig = RUN_STATUS_NOTIFY_CONFIG[run.status];
  if (!statusConfig) return;

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

  dispatchNotification(env, ctx, {
    kind: run.status === "done" ? "run-done" : "run-failed",
    title: `Dodo: ${run.title} ${statusConfig.titleSuffix}`,
    body: lines.join("\n"),
    priority: statusConfig.priority,
    tags: statusConfig.tags,
    ownerEmail,
  });
}
