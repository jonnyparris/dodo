/**
 * Session lifecycle helpers.
 *
 * Extracted from src/index.ts and src/mcp.ts so they can be called from any
 * context (Hono route, UserControl alarm, MCP tool) without duplicating the
 * DO-hopping logic.
 *
 * No Hono / no Request context required — callers just pass env + owner email.
 */

import { getAgentByName } from "agents";
import { getUserControlStub } from "./auth";
import type { AppConfig, Env } from "./types";

/** Thrown by `forkSessionInternal` when the source session is gone. */
export class SourceSessionMissingError extends Error {
  constructor(sessionId: string) {
    super(`Source session '${sessionId}' not found.`);
    this.name = "SourceSessionMissingError";
  }
}

async function userControlFetch(
  env: Env,
  ownerEmail: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const stub = getUserControlStub(env, ownerEmail);
  const headers = new Headers(init?.headers);
  headers.set("x-owner-email", ownerEmail);
  return stub.fetch(`https://user-control${path}`, { ...init, headers });
}

/**
 * Create a fresh, empty session registered to `ownerEmail`.
 *
 * Mirrors the `POST /session` code path in src/index.ts minus delegation /
 * account-permissions / stats-increment — callers that need those can add
 * them. Used by the scheduled-session alarm path where we already know the
 * owner and delegation isn't relevant.
 */
export async function createFreshSessionInternal(
  env: Env,
  ownerEmail: string,
  title: string | null,
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const res = await userControlFetch(env, ownerEmail, "/sessions", {
    body: JSON.stringify({ id, title, ownerEmail, createdBy: ownerEmail }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to register session: ${res.status} ${text}`);
  }
  return { id };
}

/**
 * Fork an existing session into a new session owned by `ownerEmail`.
 *
 * Extracted from the `POST /session/:id/fork` route (src/index.ts) and the
 * `fork_session` MCP tool (src/mcp.ts) — both previously copy-pasted this
 * sequence:
 *
 *   1. GET source /snapshot from CodingAgent
 *   2. POST snapshot bytes to UserControl /fork-snapshots, get a snapshot id
 *   3. Register a new session in UserControl
 *   4. POST /snapshot/import on the new CodingAgent with the snapshot id
 *   5. DELETE the snapshot from UserControl
 *
 * Throws SourceSessionMissingError if the source session is not registered
 * in the owner's UserControl.
 */
export async function forkSessionInternal(
  env: Env,
  ownerEmail: string,
  sourceSessionId: string,
  title: string | null,
): Promise<{ id: string; sourceId: string }> {
  // Verify source exists in owner's UserControl.
  const checkRes = await userControlFetch(
    env,
    ownerEmail,
    `/sessions/${encodeURIComponent(sourceSessionId)}/check`,
  );
  if (!checkRes.ok) {
    throw new SourceSessionMissingError(sourceSessionId);
  }

  // 1. Snapshot the source session.
  const sourceAgent = await getAgentByName(env.CODING_AGENT as never, sourceSessionId);
  const snapshotResponse = await sourceAgent.fetch(
    new Request("https://coding-agent/snapshot", { method: "GET" }),
  );
  if (!snapshotResponse.ok) {
    throw new Error(`Failed to snapshot source session: ${snapshotResponse.status}`);
  }
  const snapshot = await snapshotResponse.text();

  // 2. Store the snapshot in UserControl.
  const snapshotStoreResponse = await userControlFetch(env, ownerEmail, "/fork-snapshots", {
    body: snapshot,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!snapshotStoreResponse.ok) {
    throw new Error(`Failed to store fork snapshot: ${snapshotStoreResponse.status}`);
  }
  const { id: snapshotId } = (await snapshotStoreResponse.json()) as { id: string };

  // 3. Register the new session.
  const sessionId = crypto.randomUUID();
  const registerRes = await userControlFetch(env, ownerEmail, "/sessions", {
    body: JSON.stringify({ id: sessionId, title, ownerEmail, createdBy: ownerEmail }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!registerRes.ok) {
    const text = await registerRes.text();
    throw new Error(`Failed to register forked session: ${registerRes.status} ${text}`);
  }

  // 4. Import the snapshot into the target agent.
  const targetAgent = await getAgentByName(env.CODING_AGENT as never, sessionId);
  const importResponse = await targetAgent.fetch(
    new Request(
      `https://coding-agent/snapshot/import?snapshotId=${encodeURIComponent(snapshotId)}`,
      {
        headers: {
          "x-dodo-session-id": sessionId,
          "x-owner-email": ownerEmail,
        },
        method: "POST",
      },
    ),
  );
  // 5. Always attempt snapshot cleanup, even if import failed.
  await userControlFetch(
    env,
    ownerEmail,
    `/fork-snapshots/${encodeURIComponent(snapshotId)}`,
    { method: "DELETE" },
  );

  if (!importResponse.ok) {
    const text = await importResponse.text();
    throw new Error(`Failed to import snapshot into forked session: ${importResponse.status} ${text}`);
  }

  return { id: sessionId, sourceId: sourceSessionId };
}

/**
 * Dispatch a prompt to an existing session's CodingAgent.
 *
 * Reads the owner's current config for model/gateway (matching interactive
 * prompt behaviour — the model you get is the model set on the account when
 * the prompt runs, not when it was scheduled).
 *
 * The authorEmail defaults to ownerEmail but callers (e.g. the scheduled-
 * session alarm) can pass a sentinel like "scheduled-session" to distinguish
 * automated dispatches from user prompts in logs and message metadata.
 */
export async function dispatchPromptInternal(
  env: Env,
  sessionId: string,
  ownerEmail: string,
  prompt: string,
  opts?: { authorEmail?: string; config?: AppConfig },
): Promise<Response> {
  const config = opts?.config ?? (await readConfigInternal(env, ownerEmail));
  const authorEmail = opts?.authorEmail ?? ownerEmail;

  const agent = await getAgentByName(env.CODING_AGENT as never, sessionId);
  return agent.fetch(
    new Request(`https://coding-agent/prompt`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dodo-session-id": sessionId,
        "x-dodo-ai-base-url": config.aiGatewayBaseURL,
        "x-dodo-gateway": config.activeGateway,
        "x-dodo-model": config.model,
        "x-dodo-opencode-base-url": config.opencodeBaseURL,
        "x-author-email": authorEmail,
        "x-owner-email": ownerEmail,
      },
      body: JSON.stringify({ content: prompt }),
    }),
  );
}

async function readConfigInternal(env: Env, ownerEmail: string): Promise<AppConfig> {
  const res = await userControlFetch(env, ownerEmail, "/config");
  if (!res.ok) {
    throw new Error(`Failed to read config for ${ownerEmail}: ${res.status}`);
  }
  return (await res.json()) as AppConfig;
}
