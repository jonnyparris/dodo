/**
 * Session lifecycle helpers.
 *
 * Extracted from src/index.ts and src/mcp.ts so the snapshot → register →
 * import → cleanup pipeline has a single source of truth.
 *
 * No Hono / no Request context required — callers pass env + owner email.
 *
 * Note: `UserControl.alarm()` deliberately does NOT call these helpers.
 * From inside a UserControl DO, calling `getUserControlStub(env, email).fetch(...)`
 * targets the same DO we're already executing in, which deadlocks under the
 * input gate. Alarm code writes directly to the local DB via
 * `registerScheduledFreshSession` / `forkScheduledSession` on the DO class
 * instead.
 */

import { getAgentByName } from "agents";
import { getUserControlStub } from "./auth";
import type { Env } from "./types";

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
