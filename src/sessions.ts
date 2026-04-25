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
import { log } from "./logger";
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
 * Steps:
 *   1. GET source /snapshot from CodingAgent
 *   2. POST snapshot bytes to UserControl /fork-snapshots, get a snapshot id
 *   3. Register a new session in UserControl
 *   4. POST /snapshot/import on the new CodingAgent with the snapshot id
 *   5. DELETE the snapshot from UserControl
 *
 * Source existence is verified against the source owner's UserControl, not
 * the caller's. When the caller has been granted access to a session they
 * don't own, pass `sourceOwnerEmail` so the existence check hits the right
 * DO. Without it, the caller would get a spurious SourceSessionMissingError
 * for any session they didn't create themselves. (audit finding M5)
 *
 * Throws SourceSessionMissingError if the source session is not registered
 * in the resolved owner's UserControl.
 */
export async function forkSessionInternal(
  env: Env,
  ownerEmail: string,
  sourceSessionId: string,
  title: string | null,
  sourceOwnerEmail?: string | null,
): Promise<{ id: string; sourceId: string }> {
  // Verify source exists in the source owner's UserControl. Falls back to
  // the caller when no source owner is provided (legacy behaviour, kept
  // for the same-owner case).
  const checkOwner = sourceOwnerEmail && sourceOwnerEmail !== ownerEmail
    ? sourceOwnerEmail
    : ownerEmail;
  const checkRes = await userControlFetch(
    env,
    checkOwner,
    `/sessions/${encodeURIComponent(sourceSessionId)}/check`,
  );
  if (!checkRes.ok) {
    throw new SourceSessionMissingError(sourceSessionId);
  }

  // 1. Snapshot the source session.
  const sourceAgent = await getAgentByName(env.CODING_AGENT as never, sourceSessionId);
  const exportStart = Date.now();
  const snapshotResponse = await sourceAgent.fetch(
    new Request("https://coding-agent/snapshot", { method: "GET" }),
  );
  if (!snapshotResponse.ok) {
    const errBody = await snapshotResponse.text().catch(() => "");
    log("error", "fork: snapshot export failed", {
      sourceSessionId,
      status: snapshotResponse.status,
      bodyPreview: errBody.slice(0, 256),
    });
    throw new Error(`Failed to snapshot source session: ${snapshotResponse.status} ${errBody.slice(0, 256)}`);
  }
  const snapshot = await snapshotResponse.text();
  const exportMs = Date.now() - exportStart;
  log("info", "fork: snapshot exported", {
    sourceSessionId,
    bytes: snapshot.length,
    sizeMB: (snapshot.length / 1024 / 1024).toFixed(2),
    ms: exportMs,
  });

  // 2. Store the snapshot in UserControl.
  // Track the precise size and duration so we can correlate failures with
  // workerd memory / DO storage limits. The /fork-snapshots handler often
  // returns 400 with an opaque message — capture the body so the caller
  // sees the real error instead of just the status code. (audit follow-up:
  // diagnostics for fork-snapshot failures, plan
  // 2026-04-25-dodo-seed-fork-large-snapshot.md phase 0.)
  const storeStart = Date.now();
  const snapshotStoreResponse = await userControlFetch(env, ownerEmail, "/fork-snapshots", {
    body: snapshot,
    headers: {
      "content-type": "application/json",
      "content-length": String(snapshot.length),
    },
    method: "POST",
  });
  if (!snapshotStoreResponse.ok) {
    const errBody = await snapshotStoreResponse.text().catch(() => "");
    log("error", "fork: snapshot store failed", {
      sourceSessionId,
      ownerEmail,
      status: snapshotStoreResponse.status,
      bytes: snapshot.length,
      sizeMB: (snapshot.length / 1024 / 1024).toFixed(2),
      bodyPreview: errBody.slice(0, 512),
      ms: Date.now() - storeStart,
    });
    throw new Error(`Failed to store fork snapshot: ${snapshotStoreResponse.status} ${errBody.slice(0, 256)}`);
  }
  const { id: snapshotId } = (await snapshotStoreResponse.json()) as { id: string };
  log("info", "fork: snapshot stored", {
    sourceSessionId,
    snapshotId,
    bytes: snapshot.length,
    ms: Date.now() - storeStart,
  });

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
  const importStart = Date.now();
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
  const importMs = Date.now() - importStart;
  // 5. Always attempt snapshot cleanup, even if import failed.
  await userControlFetch(
    env,
    ownerEmail,
    `/fork-snapshots/${encodeURIComponent(snapshotId)}`,
    { method: "DELETE" },
  );

  if (!importResponse.ok) {
    const text = await importResponse.text().catch(() => "");
    log("error", "fork: snapshot import failed", {
      sessionId,
      sourceSessionId,
      snapshotId,
      status: importResponse.status,
      bodyPreview: text.slice(0, 512),
      ms: importMs,
    });
    throw new Error(`Failed to import snapshot into forked session: ${importResponse.status} ${text.slice(0, 256)}`);
  }
  log("info", "fork: snapshot imported", { sessionId, sourceSessionId, snapshotId, ms: importMs });

  return { id: sessionId, sourceId: sourceSessionId };
}
