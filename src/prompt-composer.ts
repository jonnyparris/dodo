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
  /** Hard cap on prompt length in bytes. */
  maxLengthBytes?: number;
}

/**
 * Assemble the final system prompt from its constituent parts.
 *
 * Ordering (outermost → innermost):
 * 1. User prefix (if any) — placed at the very top.
 * 2. Static base prompt.
 * 3. Skill manifest (if any).
 * 4. Browser section (if any).
 * 5. Workspace summary (if any).
 * 6. Project instructions (if any).
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

  if (inputs.workspaceSummary) {
    parts.push("## Current workspace\n\n" + inputs.workspaceSummary);
  }

  if (inputs.projectInstructions) {
    parts.push("## Project instructions\n\n" + inputs.projectInstructions);
  }

  let prompt = parts.join("\n\n");

  if (inputs.userPrefix) {
    prompt = `${inputs.userPrefix}\n\n---\n\n${prompt}`;
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
