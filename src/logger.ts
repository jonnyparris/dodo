/**
 * Structured JSON logger for key operations.
 *
 * Outputs one JSON object per line to console — picked up by
 * Workers Logs / Logpush automatically.
 */
export function log(level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>): void {
  console[level](JSON.stringify({ level, message, ts: new Date().toISOString(), ...context }));
}
