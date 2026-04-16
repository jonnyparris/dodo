// Shadow-commit stubs for the Dodo Artifacts migration.
// Phase 2 wires these hooks into every file-write path. Phase 3 will
// implement the actual commit body once the Artifacts beta API is
// documented.
//
// See memory/workload/plans/2026-04-16-dodo-artifacts-adoption.md.

import type { ArtifactsRepo } from "./artifacts-types";

export interface ShadowCommitDeps {
  /** Lazily obtain the Artifacts repo for this session. Returns null if Artifacts is not configured. */
  getRepo: () => Promise<ArtifactsRepo | null>;
  /** Log errors without throwing (shadow commits must not break the primary write path). */
  onError?: (err: unknown, ctx: { op: string; path: string }) => void;
}

export type ShadowOp = "write" | "replace" | "delete";

/**
 * Record a file mutation as a commit in the session's Artifacts repo.
 * This is fire-and-forget and must never throw — a broken Artifacts
 * shadow must not break the primary workspace write path.
 */
export async function shadowCommit(
  deps: ShadowCommitDeps,
  op: ShadowOp,
  path: string,
  content: string | Uint8Array | null,
  opts?: { message?: string; authorEmail?: string | null },
): Promise<void> {
  try {
    const repo = await deps.getRepo();
    if (!repo) return;
    // TODO(artifacts-beta): implement the actual commit via the Artifacts
    // REST or binding API once the beta docs confirm the shape. For now
    // this is a no-op hook that proves the plumbing works.
    void op;
    void path;
    void content;
    void opts;
    // Example of what we expect to call later:
    //   await repo.commit({ path, content, message, author });
  } catch (err) {
    deps.onError?.(err, { op, path });
  }
}
