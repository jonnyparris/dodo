/**
 * Loop detection — pure decision functions over the own-loop's
 * `recentToolCalls` history.
 *
 * The own-loop in `coding-agent.ts` tracks tool calls as
 * `"toolName:argsJSON"` strings. These pure functions read that buffer
 * and decide whether the model is in a loop pattern.
 *
 * Three signals, in increasing severity:
 *
 *  1. **Doom-loop** — identical tool+args repeated. Strong signal of
 *     stuck retry behaviour. Lives in `coding-agent.ts` already; not
 *     duplicated here.
 *  2. **Same-tool repetition** — same tool name with *different* args
 *     repeated. Catches speculative-exploration loops (e.g. 10 codemode
 *     calls in a row with different code, no text answer).
 *
 * Each function is total (no side effects, no logging) so callers can
 * compose them and react in their own way.
 */

/**
 * Did the last `threshold` tool calls all use the same tool *name*
 * (regardless of args)? Pass entries as `"toolName:argsJSON"` strings,
 * as the own-loop already stores them.
 *
 * Returns the repeated tool name, or null if the pattern isn't there.
 *
 * @param recentToolCalls Most recent first OR oldest first — only the
 *   tail is inspected, so ordering of older entries doesn't matter.
 * @param threshold How many in a row must match before we say "yes".
 *   Must be at least 2.
 */
export function detectSameToolRepetition(
  recentToolCalls: ReadonlyArray<string>,
  threshold: number,
): string | null {
  if (threshold < 2) return null;
  if (recentToolCalls.length < threshold) return null;
  const lastN = recentToolCalls.slice(-threshold);
  const firstName = lastN[0].split(":")[0];
  for (let i = 1; i < lastN.length; i++) {
    if (lastN[i].split(":")[0] !== firstName) return null;
  }
  return firstName;
}
