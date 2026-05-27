/**
 * SessionControlPlane — typed store of live session-status fields.
 *
 * Today this is a passthrough over the `metadata` key/value table on the
 * CodingAgent DO. It groups the fields that today are read from 100+ sites
 * by string key into a single typed surface so:
 *
 *   - The SessionLifecycle module has a real seam to consume rather than
 *     reaching into the k/v table.
 *   - Only SessionLifecycle (post-migration) writes `status` and
 *     `activePromptId`. Everyone else reads through this module.
 *   - A future migration to a dedicated SQL table is a swap of the
 *     adapter, not a change to callers.
 *
 * The current adapter wraps the existing `metadata` table — no schema
 * change yet. See ADR-0001 for the migration plan.
 */

import { nowEpoch } from "./sql-helpers";

/**
 * Session-level status (distinct from a prompt's status). Matches
 * `SessionState["status"]` in `./types`. A session is `running` while
 * any prompt is active; `idle` between prompts; `deleted` if soft-deleted.
 * Prompt-level completed/failed/aborted statuses live on the prompts row.
 */
export type SessionStatus = "idle" | "running" | "deleted";

export interface SessionControlSnapshot {
  sessionId: string | null;
  status: SessionStatus;
  activePromptId: string | null;
  title: string | null;
  ownerEmail: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SessionControlPlane {
  read(): SessionControlSnapshot;
  readActivePromptId(): string | null;
  readTitle(): string | null;
  readOwnerEmail(): string | null;
  readStatus(): SessionStatus;

  /** Set active prompt id and status=running in one logical write. */
  beginPrompt(promptId: string, title: string): void;
  /** Clear active prompt id and set status=idle. */
  endPrompt(): void;

  setStatus(status: SessionStatus): void;
  setTitle(title: string): void;
  setOwnerEmail(email: string): void;
  ensureBootstrap(sessionId: string, ownerEmail?: string | null): void;
  touchUpdated(): void;
}

/**
 * Adapter over the existing `metadata` k/v table.
 *
 * Takes a narrow port `{ read, write, delete }` so it can be unit-tested
 * with an in-memory Map. Production wiring binds it to
 * `coding-agent.ts`'s `readMetadata` / `writeMetadata` / `deleteMetadata`.
 */
export interface MetadataKv {
  read(key: string): string | null;
  write(key: string, value: string): void;
  delete(key: string): void;
}

export function createSessionControlPlane(kv: MetadataKv): SessionControlPlane {
  function read(): SessionControlSnapshot {
    return {
      sessionId: kv.read("session_id"),
      status: (kv.read("status") as SessionStatus | null) ?? "idle",
      activePromptId: kv.read("active_prompt_id"),
      title: kv.read("title"),
      ownerEmail: kv.read("owner_email"),
      createdAt: kv.read("created_at"),
      updatedAt: kv.read("updated_at"),
    };
  }

  return {
    read,
    readActivePromptId: () => kv.read("active_prompt_id"),
    readTitle: () => kv.read("title"),
    readOwnerEmail: () => kv.read("owner_email"),
    readStatus: () => (kv.read("status") as SessionStatus | null) ?? "idle",

    beginPrompt(promptId, title) {
      kv.write("active_prompt_id", promptId);
      kv.write("status", "running");
      const existingTitle = kv.read("title");
      if (!existingTitle) kv.write("title", title);
    },

    endPrompt() {
      kv.delete("active_prompt_id");
      kv.write("status", "idle");
    },

    setStatus(status) {
      kv.write("status", status);
    },

    setTitle(title) {
      kv.write("title", title);
    },

    setOwnerEmail(email) {
      kv.write("owner_email", email);
    },

    ensureBootstrap(sessionId, ownerEmail) {
      const now = nowEpoch();
      if (!kv.read("session_id")) {
        kv.write("session_id", sessionId);
        kv.write("created_at", new Date(now * 1000).toISOString());
      }
      if (ownerEmail && !kv.read("owner_email")) {
        kv.write("owner_email", ownerEmail);
      }
      if (!kv.read("status")) {
        kv.write("status", "idle");
      }
      kv.write("updated_at", new Date(now * 1000).toISOString());
    },

    touchUpdated() {
      kv.write("updated_at", new Date(nowEpoch() * 1000).toISOString());
    },
  };
}

/** In-memory adapter for tests. */
export function createInMemoryMetadataKv(initial: Record<string, string> = {}): MetadataKv {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    read: (key) => store.get(key) ?? null,
    write: (key, value) => {
      store.set(key, value);
    },
    delete: (key) => {
      store.delete(key);
    },
  };
}
