/**
 * Which model the pi client shows for a session. Pure, no pi imports, so the
 * Worker test suite can cover it (test/pi-client-model-label-unit.test.ts).
 *
 * GET /session/:id reports `model` as the model the running prompt uses while
 * one runs, and as the next prompt's model when idle. `modelOverride` is the
 * session pin and applies from the next prompt, so mid-run it can differ from
 * `model`. `defaultModel` is the owner's default from /api/config: every
 * prompt re-reads it, so an idle session's stored `model` can lag behind it.
 */
export interface ModelView {
  status?: string;
  model?: string;
  modelOverride?: { model?: string };
}

export interface ModelLabel {
  /** The model to show: the running prompt's while one runs, else the next prompt's. */
  current: string;
  /** Set only while a prompt runs and the next prompt will use another model. */
  next?: string;
  /** Where the next prompt's model comes from. */
  nextSource: "session override" | "your default";
}

export function modelLabel(s: ModelView | undefined, defaultModel: string | undefined): ModelLabel {
  const override = s?.modelOverride?.model;
  const nextModel = override ?? defaultModel ?? s?.model;
  const nextSource = override ? "session override" : "your default";
  if (s?.status === "running" && s.model) {
    return { current: s.model, nextSource, ...(nextModel && nextModel !== s.model ? { next: nextModel } : {}) };
  }
  return { current: nextModel ?? "?", nextSource };
}

/** One-line form for the footer and live header: `model` or `model → next`. */
export function formatModelLabel(label: ModelLabel): string {
  return label.next ? `${label.current} → ${label.next}` : label.current;
}
