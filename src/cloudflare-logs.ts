/**
 * Cloudflare Workers Observability (Logs Engine) wrapper.
 *
 * Lets the admin (and the autopilot session) query Dodo's own worker logs
 * via the public API. Used by:
 *
 * - `dodo_fetch_worker_logs` / `dodo_fetch_session_logs` MCP tools
 * - The autopilot self-diagnose loop (Ask 4c)
 *
 * Requires three env values:
 *
 * - `CLOUDFLARE_API_TOKEN` (wrangler secret) — needs Workers Scripts:Read +
 *   Workers Observability:Read on the account that runs the worker.
 * - `CLOUDFLARE_ACCOUNT_ID` (wrangler var) — account id for the worker.
 * - `DODO_WORKER_NAME` (wrangler var) — the worker script name to filter on.
 *
 * If any of those are unset the helpers return a structured "disabled" result
 * rather than throwing, so the calling MCP tool can surface a useful message
 * instead of leaking a 500 to the user.
 */

import type { Env } from "./types";

export interface LogsConfigError {
  ok: false;
  reason: "not_configured" | "api_error" | "unknown";
  message: string;
}

export interface LogsConfig {
  ok: true;
  apiToken: string;
  accountId: string;
  workerName: string;
}

/**
 * Resolve the three required env values into a typed config, or an error
 * the caller can render. Centralised so every helper applies the same gate.
 */
export function resolveLogsConfig(env: Env): LogsConfig | LogsConfigError {
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const workerName = env.DODO_WORKER_NAME?.trim();
  if (!apiToken || !accountId || !workerName) {
    return {
      ok: false,
      reason: "not_configured",
      message: "Workers Observability not configured. Set CLOUDFLARE_API_TOKEN (secret), CLOUDFLARE_ACCOUNT_ID (var), and DODO_WORKER_NAME (var) on the Worker.",
    };
  }
  return { ok: true, apiToken, accountId, workerName };
}

export interface LogQueryFilter {
  /** Field name in the log record (e.g. `$metadata.service`, `$workers.outcome`). */
  key: string;
  operation:
    | "includes" | "not_includes" | "starts_with" | "regex" | "exists"
    | "is_null" | "in" | "not_in" | "eq" | "neq"
    | "gt" | "gte" | "lt" | "lte";
  type: "string" | "number" | "boolean";
  value: string | number | boolean;
}

export interface LogQueryOptions {
  /** Window start, milliseconds since epoch. Defaults to 1 hour before `to`. */
  fromMs?: number;
  /** Window end, milliseconds since epoch. Defaults to now. */
  toMs?: number;
  /** Additional filters AND-ed on top of the worker-name filter. */
  filters?: LogQueryFilter[];
  /** Full-text needle. Combined with filters via AND. */
  needle?: string;
  /** Max results. Caps at 200 for sanity (API hard cap is 2000). */
  limit?: number;
  /** View type. `events` returns individual log lines; `invocations` groups. */
  view?: "events" | "invocations" | "calculations" | "requests";
}

export interface LogEvent {
  timestamp: number;
  outcome?: string;
  message?: string;
  service?: string;
  error?: string;
  /** Full raw record for the LLM to inspect. */
  raw: Record<string, unknown>;
}

export interface LogQueryResult {
  ok: true;
  events: LogEvent[];
  total: number;
  fromMs: number;
  toMs: number;
}

/**
 * Query Workers Observability for log events related to the Dodo worker.
 *
 * Default window is the last hour; default view is `events` (individual
 * log lines). The worker-name filter is always applied so admins can't
 * accidentally query their entire account's logs.
 */
export async function queryWorkerLogs(env: Env, options: LogQueryOptions = {}): Promise<LogQueryResult | LogsConfigError> {
  const cfg = resolveLogsConfig(env);
  if (!cfg.ok) return cfg;

  const toMs = options.toMs ?? Date.now();
  const fromMs = options.fromMs ?? toMs - 60 * 60 * 1000;
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const view = options.view ?? "events";

  // Always scope to the configured worker name; admin queries should never
  // sweep across other workers on the same account.
  const workerFilter: LogQueryFilter = {
    key: "$metadata.service",
    operation: "eq",
    type: "string",
    value: cfg.workerName,
  };

  const filters = [workerFilter, ...(options.filters ?? [])];

  const body = {
    queryId: "",
    timeframe: { from: fromMs, to: toMs },
    view,
    limit,
    parameters: {
      datasets: ["cloudflare-workers"],
      filterCombination: "AND" as const,
      filters: filters.map((f) => ({ ...f, kind: "filter" as const })),
      ...(options.needle ? { needle: { value: options.needle, isRegex: false, matchCase: false } } : {}),
    },
  };

  let response: Response;
  try {
    response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/workers/observability/telemetry/query`,
      {
        method: "POST",
        headers: {
          "authorization": `Bearer ${cfg.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
  } catch (error) {
    return {
      ok: false,
      reason: "api_error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      reason: "api_error",
      message: `Cloudflare API ${response.status}: ${text.slice(0, 400)}`,
    };
  }

  const payload = await response.json().catch(() => null) as
    | { success?: boolean; result?: { events?: unknown[]; invocations?: unknown[]; total?: number } }
    | null;

  if (!payload || payload.success === false) {
    return {
      ok: false,
      reason: "api_error",
      message: "Unexpected response shape from Workers Observability",
    };
  }

  const rawEvents = (payload.result?.events ?? payload.result?.invocations ?? []) as Array<Record<string, unknown>>;
  const events: LogEvent[] = rawEvents.map((raw) => ({
    timestamp: Number((raw["$workers.eventTimestampMs"] as number) ?? (raw.timestamp as number) ?? 0),
    outcome: typeof raw["$workers.outcome"] === "string" ? raw["$workers.outcome"] as string : undefined,
    message: typeof raw["$metadata.message"] === "string" ? raw["$metadata.message"] as string : undefined,
    service: typeof raw["$metadata.service"] === "string" ? raw["$metadata.service"] as string : undefined,
    error: typeof raw["$metadata.error"] === "string" ? raw["$metadata.error"] as string : undefined,
    raw,
  }));

  return {
    ok: true,
    events,
    total: Number(payload.result?.total ?? events.length),
    fromMs,
    toMs,
  };
}

/**
 * Fetch recent exception/error events from the worker. Convenience wrapper
 * over `queryWorkerLogs` that pins the filter to error outcomes.
 */
export async function queryRecentExceptions(env: Env, options: { sinceHours?: number; limit?: number } = {}): Promise<LogQueryResult | LogsConfigError> {
  const hours = options.sinceHours ?? 24;
  const toMs = Date.now();
  const fromMs = toMs - hours * 60 * 60 * 1000;
  return queryWorkerLogs(env, {
    fromMs,
    toMs,
    limit: options.limit ?? 50,
    view: "events",
    filters: [
      {
        key: "$metadata.error",
        operation: "exists",
        type: "string",
        value: "",
      },
    ],
  });
}

/**
 * Fetch log events tied to a specific session id. Relies on Dodo writing
 * `sessionId` into log fields via `log("info", "...", { sessionId })` —
 * already done across most of coding-agent.ts / index.ts.
 */
export async function querySessionLogs(env: Env, sessionId: string, options: { sinceHours?: number; limit?: number } = {}): Promise<LogQueryResult | LogsConfigError> {
  if (!sessionId) {
    return { ok: false, reason: "api_error", message: "sessionId required" };
  }
  const hours = options.sinceHours ?? 24;
  const toMs = Date.now();
  const fromMs = toMs - hours * 60 * 60 * 1000;
  return queryWorkerLogs(env, {
    fromMs,
    toMs,
    limit: options.limit ?? 100,
    view: "events",
    needle: sessionId,
  });
}
