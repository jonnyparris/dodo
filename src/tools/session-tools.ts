/**
 * Session tools the agent calls on its own session:
 *
 * - schedule_prompt / list_schedules / cancel_schedule — the same cron jobs
 *   the UI and POST /session/:id/cron create. Without these, "check this in
 *   2 minutes" made the model `sleep`.
 * - request_user_input — the agent needs a human (login, CAPTCHA, a
 *   decision). Marks the session "needs input" so callers (UI, MCP clients
 *   like Signal Agent) can hand the person the Live View link, then the
 *   agent ends its turn.
 */
import { tool, zodSchema } from "ai";
import { z } from "zod";

/** Per-session cap on schedules the agent can hold at once. */
export const MAX_AGENT_SCHEDULES = 20;
/** Shortest repeat the agent can ask for. */
export const MIN_INTERVAL_SECONDS = 60;
/** Furthest ahead a one-off can be set (1 year). */
export const MAX_DELAY_SECONDS = 366 * 24 * 3600;

export type ScheduleSpec =
  | { type: "delayed"; delayInSeconds: number }
  | { type: "scheduled"; date: string }
  | { type: "cron"; cron: string }
  | { type: "interval"; intervalSeconds: number };

export interface ScheduleRecord {
  id: string;
  description: string;
  prompt: string;
  scheduleType: string;
  nextRunAt: string | null;
}

export type InputKind = "login" | "captcha" | "confirm" | "question" | "other";

export interface NeedsInput {
  kind: InputKind;
  reason: string;
  /** True when the session browser was open: the person can use Live View. */
  liveView: boolean;
  at: string;
}

export interface SessionToolHost {
  createSchedule(input: { description: string; prompt: string } & ScheduleSpec): Promise<ScheduleRecord>;
  listSchedules(): ScheduleRecord[];
  cancelSchedule(id: string): Promise<boolean>;
  requestUserInput(input: { kind: InputKind; reason: string }): Promise<NeedsInput>;
}

const CRON_RE = /^\s*(\S+\s+){4}\S+\s*$/;

/** Validate a when-spec. Returns an error string or null. Pure. */
export function checkScheduleSpec(spec: ScheduleSpec, now = Date.now()): string | null {
  if (spec.type === "delayed") {
    if (!Number.isInteger(spec.delayInSeconds) || spec.delayInSeconds < 1) return "delayInSeconds must be a whole number ≥ 1";
    if (spec.delayInSeconds > MAX_DELAY_SECONDS) return "delayInSeconds is more than a year away";
    return null;
  }
  if (spec.type === "scheduled") {
    const t = Date.parse(spec.date);
    if (Number.isNaN(t)) return "date must be an ISO 8601 date-time, e.g. 2026-10-20T08:00:00Z";
    if (t <= now) return `date ${spec.date} is in the past (now ${new Date(now).toISOString()})`;
    if (t - now > MAX_DELAY_SECONDS * 1000) return "date is more than a year away";
    return null;
  }
  if (spec.type === "cron") {
    if (!CRON_RE.test(spec.cron)) return "cron must have 5 fields (minute hour day month weekday), e.g. '0 8 * * 1-5'";
    // "* * * * *" and "*/N" under a minute aren't possible in 5 fields; any
    // per-minute cron is still too chatty for an agent turn.
    if (/^\s*\*\s/.test(spec.cron) || /^\s*\*\/1\s/.test(spec.cron)) return "cron fires every minute; pick a coarser schedule";
    return null;
  }
  if (!Number.isInteger(spec.intervalSeconds) || spec.intervalSeconds < MIN_INTERVAL_SECONDS) {
    return `intervalSeconds must be a whole number ≥ ${MIN_INTERVAL_SECONDS}`;
  }
  return null;
}

const whenSchema = z.object({
  inSeconds: z.number().int().positive().optional().describe("Run once, this many seconds from now"),
  at: z.string().optional().describe("Run once at this ISO 8601 date-time. Include the offset, e.g. 2026-10-20T08:00:00+01:00"),
  cron: z.string().optional().describe("Repeat on a 5-field cron, in UTC, e.g. '0 7 * * 1-5' = weekdays 07:00 UTC"),
  everySeconds: z.number().int().positive().optional().describe(`Repeat every N seconds (≥ ${MIN_INTERVAL_SECONDS})`),
});

/** Map the model-facing `when` object to one ScheduleSpec. Pure. */
export function toScheduleSpec(when: z.infer<typeof whenSchema>): ScheduleSpec | { error: string } {
  const set = [when.inSeconds !== undefined, when.at !== undefined, when.cron !== undefined, when.everySeconds !== undefined].filter(Boolean).length;
  if (set !== 1) return { error: "Set exactly one of when.inSeconds, when.at, when.cron, when.everySeconds" };
  if (when.inSeconds !== undefined) return { type: "delayed", delayInSeconds: when.inSeconds };
  if (when.at !== undefined) {
    const t = Date.parse(when.at);
    return { type: "scheduled", date: Number.isNaN(t) ? when.at : new Date(t).toISOString() };
  }
  if (when.cron !== undefined) return { type: "cron", cron: when.cron.trim() };
  return { type: "interval", intervalSeconds: when.everySeconds! };
}

export function buildSessionTools(host: SessionToolHost) {
  return {
    schedule_prompt: tool({
      description:
        "Schedule a prompt to run later in THIS session (same files, browser profile and history). Use it instead of sleeping or waiting " +
        "whenever something should happen later: 'check again in 10 minutes', 'every weekday at 8', 'remind me on Friday'. " +
        "When it fires, `prompt` is sent as a new message and you handle it then. Write the prompt so it stands on its own (what to do, " +
        "what to report). The current turn carries on; tell the user what you scheduled. Times are UTC unless `at` has an offset.",
      inputSchema: zodSchema(z.object({
        description: z.string().min(1).max(200).describe("Short label shown in the schedule list"),
        prompt: z.string().min(1).max(8000).describe("The message to run when it fires"),
        when: whenSchema,
      })),
      execute: async ({ description, prompt, when }) => {
        const spec = toScheduleSpec(when);
        if ("error" in spec) return { error: spec.error };
        const bad = checkScheduleSpec(spec);
        if (bad) return { error: bad };
        if (host.listSchedules().length >= MAX_AGENT_SCHEDULES) {
          return { error: `This session already has ${MAX_AGENT_SCHEDULES} schedules. Cancel one first (list_schedules, cancel_schedule).` };
        }
        try {
          const job = await host.createSchedule({ description, prompt, ...spec });
          return { scheduled: true, id: job.id, type: job.scheduleType, nextRunAt: job.nextRunAt };
        } catch (err) {
          return { error: `Could not schedule: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    }),
    list_schedules: tool({
      description: "List this session's scheduled prompts (one-off and repeating) with ids and next run times.",
      inputSchema: zodSchema(z.object({})),
      execute: async () => ({ schedules: host.listSchedules() }),
    }),
    cancel_schedule: tool({
      description: "Cancel one of this session's scheduled prompts by id (from schedule_prompt or list_schedules).",
      inputSchema: zodSchema(z.object({ id: z.string().min(1) })),
      execute: async ({ id }) => {
        const known = host.listSchedules().some((s) => s.id === id);
        if (!known) return { error: `No schedule with id ${id} in this session` };
        return { cancelled: await host.cancelSchedule(id), id };
      },
    }),
    request_user_input: tool({
      description:
        "Hand over to the person when only they can continue: a login or 2FA screen, a CAPTCHA, a payment/confirmation step, " +
        "or a decision you must not guess. The session is marked 'needs input' and, if the browser is open, the person gets a " +
        "Live View link to act in this exact browser. After calling it, END YOUR TURN with one short line saying what they need to do. " +
        "Do not keep working or poll; their reply arrives as the next message. Never ask for passwords in chat.",
      inputSchema: zodSchema(z.object({
        kind: z.enum(["login", "captcha", "confirm", "question", "other"]),
        reason: z.string().min(1).max(500).describe("What the person must do, e.g. 'Sign in to github.com, then reply done'"),
      })),
      execute: async ({ kind, reason }) => {
        const state = await host.requestUserInput({ kind, reason });
        return {
          ok: true,
          liveView: state.liveView,
          next: state.liveView
            ? "The person will get a Live View link to this browser. End your turn now with one line saying what they need to do."
            : "No browser is open, so there is no Live View. End your turn now with your question.",
        };
      },
    }),
  };
}
