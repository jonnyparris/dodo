/**
 * Which model the pi client shows for a session. Pure, no pi imports, so the
 * Worker test suite can cover it (test/pi-client-model-label-unit.test.ts).
 *
 * GET /session/:id reports `model` as the model the running prompt uses while
 * one runs, and as the next prompt's model when idle, plus `nextModel` (the
 * next prompt's model, resolved against the session owner's config). Older
 * servers have no `nextModel`; then the client falls back to the override,
 * else `defaultModel` (the requester's default from /api/config, which is the
 * owner's only when you own the session).
 */
export interface ModelView {
  status?: string;
  model?: string;
  nextModel?: string;
  modelOverride?: { model?: string };
}

export interface ModelLabel {
  /** The model to show: the running prompt's while one runs, else the next prompt's. */
  current: string;
  /** Set only while a prompt runs and the next prompt will use another model. */
  next?: string;
  /** Where the next prompt's model comes from. */
  nextSource: "session override" | "default";
}

export function modelLabel(s: ModelView | undefined, defaultModel: string | undefined): ModelLabel {
  const override = s?.modelOverride?.model;
  const nextModel = s?.nextModel ?? override ?? defaultModel ?? s?.model;
  const nextSource = override ? "session override" : "default";
  if (s?.status === "running") {
    const current = s.model || "?";
    return { current, nextSource, ...(nextModel && nextModel !== current ? { next: nextModel } : {}) };
  }
  return { current: nextModel || "?", nextSource };
}

/** One-line form for the footer and live header: `model` or `model → next`. */
export function formatModelLabel(label: ModelLabel): string {
  return label.next ? `${label.current} → ${label.next}` : label.current;
}
