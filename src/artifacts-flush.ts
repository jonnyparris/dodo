import { createWorkspaceGit } from "./git";
import { log } from "./logger";
import type { Workspace } from "@cloudflare/shell";

export interface FlushInput {
  workspace: Workspace;
  remote: string;
  tokenSecret: string;
  message: string;
  author?: { name: string; email: string };
}

/**
 * Commit all workspace changes and push them to the session's Artifacts remote.
 * Fire-and-forget: never throws. Returns true if a commit was pushed, false otherwise.
 */
export async function flushTurnToArtifacts(input: FlushInput): Promise<boolean> {
  try {
    const git = createWorkspaceGit(input.workspace);

    // Ensure the workspace is a git repo. isomorphic-git's init is idempotent.
    try {
      await git.status();
    } catch {
      await git.init({ defaultBranch: "main" });
    }

    // Add the artifacts remote if not already configured.
    const remotes = (await git.remote({ list: true })) as unknown as Array<{ remote: string; url: string }>;
    if (!remotes.some((r) => r.remote === "artifacts")) {
      await git.remote({ add: { name: "artifacts", url: input.remote } });
    }

    // Stage everything, bail if nothing changed.
    await git.add({ filepath: "." });
    const status = await git.status();
    if (status.length === 0) return false;

    // Commit + push.
    const author = input.author ?? { name: "Dodo", email: "dodo@workers.dev" };
    await git.commit({ message: input.message, author });
    await git.push({ remote: "artifacts", ref: "main", token: input.tokenSecret });
    return true;
  } catch (err) {
    log("warn", "[artifacts-flush] failed", { err: String(err) });
    return false;
  }
}
