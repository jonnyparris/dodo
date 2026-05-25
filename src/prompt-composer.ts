/**
 * Prompt composer — pure assembly of the system prompt from its parts.
 *
 * Extracted from CodingAgent.getSystemPrompt() so the composition logic
 * can be unit-tested without booting a Worker + DO.
 */

export interface PromptComposeInputs {
  /** The main SYSTEM_PROMPT constant body. */
  staticBase: string;
  /** Pre-rendered skill manifest (from `renderSkillManifest`). Omit if none. */
  skillManifest?: string;
  /** Browser automation section (only when browser is enabled). */
  browserSection?: string;
  /** Workspace root listing (only on the first turn). */
  workspaceSummary?: string;
  /** Project instructions from AGENTS.md / CLAUDE.md. */
  projectInstructions?: string;
  /** User-supplied prefix (systemPromptPrefix in DodoConfig). */
  userPrefix?: string;
  /**
   * Admin-managed global prefix applied to every session across every user.
   * Sits above `userPrefix` so layering is `admin > user > base`. Same 4 KB
   * cap as `userPrefix`. Loaded from SharedIndex `global_config`.
   */
  adminPrefix?: string;
  /**
   * Optional `## Your goal` section. Sits between the skill manifest and
   * the project instructions so the model sees its goal in roughly the
   * same spot every turn (prompt-cache friendly).
   */
  goalSection?: string;
  /** Hard cap on prompt length in bytes. */
  maxLengthBytes?: number;
}

/**
 * Assemble the final system prompt from its constituent parts.
 *
 * Ordering (outermost → innermost):
 * 1. Admin prefix (if any) — placed at the very top, applies to every session.
 * 2. User prefix (if any) — per-user preamble, below admin prefix.
 * 3. Static base prompt.
 * 4. Skill manifest (if any).
 * 5. Browser section (if any).
 * 6. Workspace summary (if any).
 * 7. Project instructions (if any).
 *
 * If `maxLengthBytes` is set and the assembled prompt exceeds it, the
 * optional sections are dropped in reverse priority order until it fits.
 */
export function assembleSystemPrompt(inputs: PromptComposeInputs): string {
  const parts: string[] = [inputs.staticBase];

  if (inputs.skillManifest) {
    parts.push(inputs.skillManifest);
  }

  if (inputs.browserSection) {
    parts.push(inputs.browserSection);
  }

  if (inputs.goalSection) {
    parts.push(inputs.goalSection);
  }

  if (inputs.workspaceSummary) {
    parts.push("## Current workspace\n\n" + inputs.workspaceSummary);
  }

  if (inputs.projectInstructions) {
    parts.push("## Project instructions\n\n" + inputs.projectInstructions);
  }

  let prompt = parts.join("\n\n");

  // User prefix layers above the base; admin prefix layers above that. Both
  // are joined with `---` so the model can recognise the boundary.
  if (inputs.userPrefix) {
    prompt = `${inputs.userPrefix}\n\n---\n\n${prompt}`;
  }

  if (inputs.adminPrefix) {
    prompt = `${inputs.adminPrefix}\n\n---\n\n${prompt}`;
  }

  if (inputs.maxLengthBytes && prompt.length > inputs.maxLengthBytes) {
    prompt = truncateToBytes(prompt, inputs.maxLengthBytes);
  }

  return prompt;
}

/** Simple middle-truncation when a hard byte limit is exceeded. */
function truncateToBytes(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text;
  const marker = "\n\n[...truncated...]\n\n";
  const available = maxBytes - marker.length;
  if (available <= 0) return text.slice(0, maxBytes);
  const head = text.slice(0, Math.floor(available * 0.7));
  const tail = text.slice(-Math.floor(available * 0.3));
  return `${head}${marker}${tail}`;
}
