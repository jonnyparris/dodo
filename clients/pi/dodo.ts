/**
 * Dodo client for pi.
 *
 * Attach your local pi to a Dodo session: what you type goes to Dodo, Dodo's
 * replies and tool calls show in pi's transcript as they happen, and the
 * session keeps running on Dodo when you close the laptop. Re-attach from any
 * machine with the same credentials.
 *
 *   /dodo                 pick a session (or start a new one) and attach
 *   /dodo new [prompt]    new session, attach, optionally send a first prompt
 *   /dodo attach <id>     attach by id or id prefix
 *   /dodo detach          stop forwarding; pi talks to its local model again
 *   /dodo model [id]      set this session's model (picker without an id); "default" clears
 *   /dodo abort           stop the running prompt
 *   /dodo status          model, status, tokens, context use
 *   /dodo open            open the session in the browser
 *
 * Setup (see clients/pi/README.md): DODO_URL plus a Cloudflare Access service
 * token, from env vars or the macOS keychain service "dodo-pi-client".
 */
import { execFileSync, spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text, type TUI, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatModelLabel, modelLabel } from "./model-label";

// ─── Types (Dodo's HTTP/SSE shapes) ───

interface SessionState {
  sessionId: string;
  status: "idle" | "running" | "deleted";
  model: string;
  nextModel?: string;
  modelOverride?: { model?: string; exploreModel?: string; taskModel?: string };
  contextUsagePercent?: number;
  contextWindow?: number;
  totalTokenInput?: number;
  totalTokenOutput?: number;
}
interface SessionSummary { id: string; title: string | null; status: string; updatedAt: string; kind?: string }
interface ChatMessage { id: string; role: "user" | "assistant" | "system" | "tool"; content: string; authorEmail?: string | null; model?: string | null }
interface Credentials { url: string; clientId: string; clientSecret: string }

interface MessageEntry { id: string; role: string; content: string; author?: string | null; model?: string | null; sessionId: string }
interface ToolEntry { name: string; input: string; output: string; ms: number }
interface NoteEntry { level: "info" | "warning" | "error"; text: string }
interface AttachEntry { id: string; title?: string | null; fresh?: boolean }

const KEYCHAIN_SERVICE = "dodo-pi-client";
const HISTORY_ON_ATTACH = 6;
const LIVE_LINES = 10;
const IDLE_MS = 75_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Strip terminal control characters (ESC/OSC/C1) from remote text before it
 * reaches the terminal: tool output and shared-session messages are untrusted.
 */
const clean = (s: string) => s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");

// ─── Credentials ───

function keychain(account: string): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function loadCredentials(): Credentials | string {
  const url = process.env.DODO_URL || keychain("url");
  const clientId = process.env.DODO_ACCESS_CLIENT_ID || keychain("client_id");
  const clientSecret = process.env.DODO_ACCESS_CLIENT_SECRET || keychain("client_secret");
  if (!url || !clientId || !clientSecret) {
    return `Dodo client not configured. Set DODO_URL, DODO_ACCESS_CLIENT_ID, DODO_ACCESS_CLIENT_SECRET, or add them to the keychain service "${KEYCHAIN_SERVICE}" (accounts url, client_id, client_secret). See clients/pi/README.md in the Dodo repo.`;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `DODO_URL is not a URL: ${url}`;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !local) return `DODO_URL must be https (the Access secret is sent on every request): ${url}`;
  return { url: url.replace(/\/+$/, ""), clientId, clientSecret };
}

// ─── HTTP ───

class DodoApi {
  constructor(readonly creds: Credentials) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { "CF-Access-Client-Id": this.creds.clientId, "CF-Access-Client-Secret": this.creds.clientSecret, ...extra };
  }

  async request<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const res = await fetch(`${this.creds.url}${path}`, {
      method: init.method ?? "GET",
      headers: this.headers(init.body !== undefined ? { "content-type": "application/json" } : undefined),
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      redirect: "manual",
      signal: init.signal,
    });
    if (res.status >= 300 && res.status < 400) throw new Error("Cloudflare Access refused the service token (redirected to login). Check the token is in the Dodo app's service-auth policy.");
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Dodo ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!res.ok) throw new Error(`Dodo ${res.status}: ${(data as { error?: string }).error ?? text.slice(0, 200)}`);
    return data as T;
  }

  /**
   * Stream SSE events until the signal aborts or the server closes. The server
   * sends a heartbeat every 30s; after IDLE_MS of silence (laptop sleep, dead
   * NAT) the connection is treated as lost so the caller reconnects.
   */
  async events(sessionId: string, signal: AbortSignal, onEvent: (type: string, data: unknown) => void): Promise<void> {
    const idle = new AbortController();
    const onAbort = () => idle.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let timer = setTimeout(() => idle.abort(), IDLE_MS);
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(), IDLE_MS);
    };
    try {
      const res = await fetch(`${this.creds.url}/session/${sessionId}/events`, {
        headers: this.headers({ accept: "text/event-stream" }),
        redirect: "manual",
        signal: idle.signal,
      });
      if (res.status >= 300 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        throw new FatalStreamError(res.status >= 300 && res.status < 400 ? "Cloudflare Access refused the service token" : `HTTP ${res.status}`);
      }
      if (!res.ok || !res.body) throw new Error(`events: HTTP ${res.status}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        bump();
        buf += value;
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let type = "message";
          const data: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          }
          if (data.length === 0) continue;
          try {
            onEvent(type, JSON.parse(data.join("\n")));
          } catch {
            // Ignore malformed frames; the next ready/state event resyncs.
          }
        }
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/** The stream can't succeed by retrying (auth refused, session gone). */
class FatalStreamError extends Error {}

// ─── Helpers ───

const short = (id: string) => id.slice(0, 8);
const oneLine = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};
function summariseInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return oneLine(input, 100);
  const o = input as Record<string, unknown>;
  for (const key of ["path", "command", "query", "url", "pattern", "description", "task", "code"]) {
    if (typeof o[key] === "string") return oneLine(o[key] as string, 100);
  }
  return oneLine(JSON.stringify(input), 100);
}
function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** The live area above the editor while a Dodo prompt runs. */
class LiveView {
  text = "";
  tool: { name: string; input: string; started: number } | undefined;
  header = "";
  /** Set by a `model_wait` frame: the turn is queued for a Workers AI budget slot. */
  wait: { model: string; until: number } | undefined;
  tui: TUI | undefined;

  render(width: number): string[] {
    const lines: string[] = [truncateToWidth(this.header, width)];
    if (this.text) {
      const wrapped = wrapTextWithAnsi(this.text, Math.max(10, width - 2)).map((l) => `  ${l}`);
      lines.push(...wrapped.slice(-LIVE_LINES));
    }
    if (this.tool) {
      const secs = ((Date.now() - this.tool.started) / 1000).toFixed(0);
      lines.push(truncateToWidth(`  ⚙ ${this.tool.name} ${this.tool.input} · ${secs}s`, width));
    }
    // Past `until` the budget wait is over and the request is in flight, so the line goes away
    // (a further wait sends a new model_wait frame).
    const waitMs = this.wait ? this.wait.until - Date.now() : 0;
    if (waitMs <= 0) this.wait = undefined;
    else lines.push(truncateToWidth(`  ⏳ waiting for model capacity (${this.wait!.model}) · ~${Math.max(1, Math.round(waitMs / 1000))}s`, width));
    return lines;
  }
  invalidate(): void {}
  refresh(): void {
    this.tui?.requestRender();
  }
}

// ─── Extension ───

export default function dodo(pi: ExtensionAPI) {
  let api: DodoApi | undefined;
  let ctxRef: ExtensionContext | undefined;
  let attached: { id: string; title: string | null } | undefined;
  let state: SessionState | undefined;
  let stream: AbortController | undefined;
  let seen = new Set<string>();
  let live = new LiveView();
  let liveShown = false;
  let pendingTools = new Map<string, { name: string; input: string; started: number }>();
  let ticker: ReturnType<typeof setInterval> | undefined;
  let attachGen = 0;
  let loading = 0;

  const client = (): DodoApi => {
    if (api) return api;
    const creds = loadCredentials();
    if (typeof creds === "string") throw new Error(creds);
    api = new DodoApi(creds);
    return api;
  };

  const ui = () => ctxRef?.ui;
  const notify = (msg: string, level: "info" | "warning" | "error" = "info") => ui()?.notify(msg, level);
  const note = (level: NoteEntry["level"], text: string) => pi.appendEntry<NoteEntry>("dodo-note", { level, text });

  /** My default model (/api/config): the next-model fallback for servers that don't report `nextModel`. */
  let defaultModel: string | undefined;
  /** The running prompt's model while one runs (plus `→ next` if the next prompt changes it), else the next prompt's. */
  const modelOf = (s?: SessionState) => formatModelLabel(modelLabel(s, defaultModel));

  function updateStatus(): void {
    if (!attached) {
      ui()?.setStatus("dodo", undefined);
      return;
    }
    const running = state?.status === "running";
    const ctxPct = state?.contextUsagePercent !== undefined ? ` · ctx ${state.contextUsagePercent}%` : "";
    ui()?.setStatus("dodo", `🦤 ${oneLine(attached.title ?? short(attached.id), 30)} · ${modelOf(state)}${ctxPct}${running ? " · running" : ""}`);
    live.header = `🦤 Dodo · ${oneLine(attached.title ?? short(attached.id), 40)} · ${modelOf(state)} · ${running ? "running" : state?.status ?? "…"}`;
    live.refresh();
  }

  function showLive(on: boolean): void {
    const u = ui();
    if (!u || on === liveShown) return;
    liveShown = on;
    if (on) {
      u.setWidget("dodo-live", (tui) => {
        live.tui = tui;
        return live;
      });
      ticker = setInterval(() => (live.tool || live.wait) && live.refresh(), 1000);
    } else {
      u.setWidget("dodo-live", undefined);
      if (ticker) clearInterval(ticker);
      ticker = undefined;
    }
  }

  function flushLiveText(): void {
    const text = live.text.trim();
    if (text) pi.appendEntry<{ content: string }>("dodo-text", { content: clean(text) });
    live.text = "";
  }

  function renderMessage(m: ChatMessage, sessionId: string): void {
    if (seen.has(m.id) || (m.role !== "user" && m.role !== "assistant")) return;
    seen.add(m.id);
    pi.appendEntry<MessageEntry>("dodo-message", {
      id: m.id,
      role: m.role,
      content: clean(m.content ?? ""),
      author: m.authorEmail ? clean(m.authorEmail) : null,
      model: m.model ? clean(m.model) : null,
      sessionId,
    });
  }

  /** Render any messages the client missed (reconnect, or pi was closed). */
  async function catchUp(sessionId: string, limit?: number): Promise<void> {
    const { messages } = await client().request<{ messages: ChatMessage[] }>(`/session/${sessionId}/messages`);
    if (attached?.id !== sessionId) return;
    const fresh = messages.filter((m) => !seen.has(m.id) && (m.role === "user" || m.role === "assistant"));
    const skipped = limit !== undefined ? Math.max(0, fresh.length - limit) : 0;
    if (skipped > 0) {
      for (const m of fresh.slice(0, skipped)) seen.add(m.id);
      note("info", `${skipped} earlier message${skipped === 1 ? "" : "s"} not shown. /dodo open for the full history.`);
    }
    for (const m of fresh.slice(skipped)) renderMessage(m, sessionId);
  }

  function onEvent(sessionId: string, type: string, data: unknown): void {
    if (attached?.id !== sessionId) return;
    switch (type) {
      case "ready":
      case "state": {
        // Full session details (have `model`) replace the state, so a cleared
        // override disappears; the lifecycle's control snapshot only patches it.
        const frame = data as Partial<SessionState>;
        state = "model" in frame ? (frame as SessionState) : ({ ...state, ...frame } as SessionState);
        updateStatus();
        if (state.status === "running") showLive(true);
        else {
          flushLiveText();
          live.tool = undefined;
          live.wait = undefined;
          pendingTools.clear();
          showLive(false);
        }
        if (type === "ready") void catchUp(sessionId).catch(() => {});
        return;
      }
      case "model_wait": {
        // The server holds this turn until a model-budget slot frees up; show
        // a countdown instead of a silent stall. Cleared when the countdown
        // ends, or earlier by text, a tool call, an assistant message, an error or idle.
        const d = data as { model?: unknown; waitMs?: unknown } | null;
        const ms = Math.max(1000, Number(d?.waitMs) || 0);
        live.wait = { model: clean(typeof d?.model === "string" && d.model ? d.model : modelOf(state)), until: Date.now() + ms };
        showLive(true);
        live.refresh();
        return;
      }
      case "text_delta": {
        live.wait = undefined;
        live.text += clean((data as { delta: string }).delta);
        showLive(true);
        live.refresh();
        return;
      }
      case "tool_call": {
        const d = data as { toolCallId: string; toolName: string; input: unknown };
        flushLiveText();
        live.wait = undefined;
        const t = { name: clean(d.toolName), input: clean(summariseInput(d.input)), started: Date.now() };
        pendingTools.set(d.toolCallId, t);
        live.tool = t;
        showLive(true);
        live.refresh();
        return;
      }
      case "tool_result": {
        const d = data as { toolCallId: string; output?: string };
        const t = pendingTools.get(d.toolCallId);
        pendingTools.delete(d.toolCallId);
        if (!t) return;
        pi.appendEntry<ToolEntry>("dodo-tool", { name: t.name, input: t.input, output: clean((d.output ?? "").slice(0, 4000)), ms: Date.now() - t.started });
        live.tool = [...pendingTools.values()].at(-1);
        live.refresh();
        return;
      }
      case "message": {
        const m = data as ChatMessage;
        if (m.role === "assistant") {
          live.text = "";
          live.wait = undefined;
        }
        renderMessage(m, sessionId);
        return;
      }
      case "error_message":
        live.wait = undefined;
        live.refresh();
        note("error", clean((data as { message: string }).message ?? ""));
        return;
      case "needs_input": {
        const d = data as { reason?: string; liveView?: string } | null;
        if (!d) return;
        const text = clean(`Dodo needs you: ${d.reason ?? "input required"}${d.liveView ? `\nLive view: ${d.liveView}` : ""}`);
        note("warning", text);
        notify(text, "warning");
        return;
      }
      default:
        return;
    }
  }

  async function connect(sessionId: string): Promise<void> {
    if (attached?.id !== sessionId) return;
    stream?.abort();
    const ctl = new AbortController();
    stream = ctl;
    let backoff = 1000;
    while (!ctl.signal.aborted && attached?.id === sessionId) {
      try {
        await client().events(sessionId, ctl.signal, (type, data) => {
          backoff = 1000;
          onEvent(sessionId, type, data);
        });
      } catch (err) {
        if (ctl.signal.aborted) return;
        if (err instanceof FatalStreamError) {
          note("error", `Dodo stream stopped: ${err.message}. Detached.`);
          notify(`Dodo stream stopped: ${err.message}. Detached.`, "error");
          detachQuiet();
          pi.appendEntry("dodo-detach", {});
          return;
        }
        if (backoff >= 8000) notify(`Dodo stream: ${(err as Error).message}. Retrying…`, "warning");
      }
      if (ctl.signal.aborted) return;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }

  /** Returns true when this call ended up attached (false if a newer attach or a detach overtook it). */
  async function attach(rawId: string, rawTitle: string | null, opts: { history?: number; record?: boolean; fresh?: boolean } = {}): Promise<boolean> {
    const id = rawId;
    const title = rawTitle ? clean(rawTitle) : null;
    // Each attach takes a generation; an older attach that resumes after a
    // newer one started gives up instead of overwriting it.
    const gen = ++attachGen;
    loading++;
    try {
      return await attachInner(gen, id, title, opts);
    } finally {
      loading--;
    }
  }

  async function attachInner(gen: number, id: string, title: string | null, opts: { history?: number; record?: boolean; fresh?: boolean }): Promise<boolean> {
    const [s, config] = await Promise.all([
      client().request<SessionState>(`/session/${id}`),
      client().request<{ model?: string }>("/api/config").catch(() => ({ model: undefined })),
    ]);
    if (gen !== attachGen) return false;
    // Any id answers 200 (with an empty sessionId) for the admin, so check it
    // is real: a prompted session reports its id; a fresh one reports "" until
    // its first prompt but is in my session list.
    // `fresh` = POST /session just returned it (it may live in a delegated
    // owner's list, not mine).
    if (!opts.fresh && s.sessionId !== id && !(await listSessions()).some((x) => x.id === id)) throw new Error(`No Dodo session ${short(id)}.`);
    if (gen !== attachGen) return false;
    detachQuiet();
    attached = { id, title };
    state = s;
    defaultModel = config.model;
    if (opts.record !== false) pi.appendEntry<AttachEntry>("dodo-attach", { id, title, ...(opts.fresh ? { fresh: true } : {}) });
    updateStatus();
    try {
      await catchUp(id, opts.history ?? HISTORY_ON_ATTACH);
    } catch (err) {
      if (gen === attachGen) note("warning", `Could not load history: ${(err as Error).message}`);
    }
    if (gen !== attachGen) return false;
    void connect(id);
    notify(`Attached to Dodo session ${short(id)}. Your input now goes to Dodo. /dodo detach to stop.`);
    return true;
  }

  function detachQuiet(): void {
    stream?.abort();
    stream = undefined;
    showLive(false);
    live = new LiveView();
    pendingTools = new Map();
    attached = undefined;
    state = undefined;
    updateStatus();
  }

  async function listSessions(): Promise<SessionSummary[]> {
    const { sessions } = await client().request<{ sessions: SessionSummary[] }>("/session");
    return sessions
      .filter((s) => s.status !== "deleted" && (s.kind ?? "user") === "user")
      .map((s) => ({ ...s, title: s.title ? clean(s.title) : null }));
  }

  async function resolveSession(prefix: string): Promise<SessionSummary> {
    const sessions = await listSessions();
    const hits = sessions.filter((s) => s.id.startsWith(prefix));
    if (hits.length === 1) return hits[0]!;
    if (hits.length === 0) {
      // Not in my list: only a full id (e.g. a session shared with me) is
      // worth a direct lookup; attach() checks it really exists.
      if (!UUID.test(prefix)) throw new Error(`No Dodo session matches "${prefix}".`);
      return { id: prefix.toLowerCase(), title: null, status: "idle", updatedAt: new Date().toISOString() };
    }
    throw new Error(`"${prefix}" matches ${hits.length} sessions; use more characters.`);
  }

  async function pickAndAttach(ctx: ExtensionContext): Promise<void> {
    const sessions = (await listSessions()).slice(0, 40);
    const NEW = "+ New session";
    const labels = sessions.map((s) => `${s.status === "running" ? "● " : "  "}${oneLine(s.title ?? "(untitled)", 60)}  ·  ${ago(s.updatedAt)} ago  ·  ${short(s.id)}`);
    const choice = await ctx.ui.select("Attach to a Dodo session", [NEW, ...labels]);
    if (!choice) return;
    if (choice === NEW) return newSession("");
    const s = sessions[labels.indexOf(choice)]!;
    await attach(s.id, s.title);
    return;
  }

  async function newSession(prompt: string): Promise<void> {
    const { id } = await client().request<{ id: string }>("/session", { method: "POST" });
    const ok = await attach(id, prompt ? oneLine(prompt, 60) : null, { history: 0, fresh: true });
    if (!prompt) return;
    if (ok && attached?.id === id) return sendPrompt(prompt);
    notify(`Created session ${short(id)}, but another attach took over, so the prompt was not sent. It is back in the editor.`, "warning");
    ui()?.setEditorText(prompt);
  }

  async function sendPrompt(content: string, images?: Array<{ data: string; mimeType: string }>): Promise<void> {
    if (!attached) return;
    const body: Record<string, unknown> = { content };
    if (images?.length) body.images = images.map((i) => ({ data: i.data, mediaType: i.mimeType }));
    const r = await client().request<{ promptId?: string; queued?: boolean; position?: number }>(`/session/${attached.id}/prompt`, { method: "POST", body });
    if (r.queued) notify(`Queued behind the running prompt${r.position ? ` (#${r.position})` : ""}.`);
  }

  async function setModel(ctx: ExtensionContext, arg: string): Promise<void> {
    if (!attached) throw new Error("Not attached. /dodo first.");
    let model = arg.trim();
    if (!model) {
      const config = await client().request<{ model: string; activeGateway?: string }>("/api/config");
      defaultModel = config.model;
      const { models } = await client().request<{ models: Array<{ id: string; name?: string }> }>(`/api/models?gateway=${encodeURIComponent(config.activeGateway ?? "")}`);
      const DEFAULT = `(my default: ${config.model})`;
      const labels = models.map((m) => (m.name && m.name !== m.id ? `${m.id}  ·  ${m.name}` : m.id));
      const choice = await ctx.ui.select(`Model for ${short(attached.id)} (now ${modelOf(state)})`, [DEFAULT, ...labels]);
      if (!choice) return;
      model = choice === DEFAULT ? "" : models[labels.indexOf(choice)]!.id;
    } else if (model === "default" || model === "clear") {
      model = "";
    }
    const id = attached.id;
    const r = await client().request<{ modelOverride: SessionState["modelOverride"] }>(`/session/${id}/model-override`, { method: "PUT", body: { model } });
    // Re-read the details: the server resolves `model`/`nextModel` against the owner's config.
    const fresh = await client().request<SessionState>(`/session/${id}`).catch(() => undefined);
    if (attached?.id === id && state) state = fresh ?? { ...state, modelOverride: r.modelOverride, nextModel: undefined };
    updateStatus();
    const running = state?.status === "running" ? " The running prompt keeps its main model." : "";
    notify(model ? `Session model → ${model}.${running}` : `Session model → your default.${running}`);
  }

  // ─── Renderers ───

  pi.registerEntryRenderer<MessageEntry>("dodo-message", (entry, _opts, theme) => {
    const m = entry.data;
    if (!m) return undefined;
    if (m.role === "user") {
      const box = new Box(1, 0, (t) => theme.bg("userMessageBg", t));
      const who = m.author ? theme.fg("dim", ` ${m.author}`) : "";
      box.addChild(new Text(`${theme.fg("accent", "🦤 →")}${who}\n${m.content}`, 0, 0));
      return box;
    }
    const box = new Box(1, 0);
    box.addChild(new Text(theme.fg("dim", `🦤 dodo${m.model ? ` · ${m.model}` : ""}`), 0, 0));
    box.addChild(new Markdown(m.content || theme.fg("dim", "(empty response)"), 0, 0, getMarkdownTheme()));
    return box;
  });

  pi.registerEntryRenderer<{ content: string }>("dodo-text", (entry, _opts, theme) => {
    if (!entry.data) return undefined;
    return new Text(theme.fg("muted", entry.data.content), 1, 0);
  });

  pi.registerEntryRenderer<ToolEntry>("dodo-tool", (entry, { expanded }, theme) => {
    const t = entry.data;
    if (!t) return undefined;
    const head = `${theme.fg("dim", "⚙")} ${theme.fg("accent", t.name)} ${theme.fg("dim", `${t.input} · ${(t.ms / 1000).toFixed(1)}s`)}`;
    if (!expanded || !t.output) return new Text(head, 1, 0);
    return new Text(`${head}\n${theme.fg("muted", t.output)}`, 1, 0);
  });

  pi.registerEntryRenderer<NoteEntry>("dodo-note", (entry, _opts, theme) => {
    const n = entry.data;
    if (!n) return undefined;
    const color = n.level === "error" ? "error" : n.level === "warning" ? "warning" : "dim";
    return new Text(theme.fg(color, `🦤 ${n.text}`), 1, 0);
  });

  pi.registerEntryRenderer<AttachEntry>("dodo-attach", (entry, _opts, theme) => {
    const a = entry.data;
    if (!a) return undefined;
    return new Text(theme.fg("accent", `── attached to Dodo ${short(a.id)}${a.title ? ` · ${oneLine(a.title, 60)}` : ""} ──`), 0, 0);
  });
  pi.registerEntryRenderer("dodo-detach", (_entry, _opts, theme) => new Text(theme.fg("dim", "── detached from Dodo ──"), 0, 0));

  // ─── Input forwarding ───

  pi.on("input", async (event, ctx) => {
    if (!attached || event.source === "extension") return { action: "continue" };
    const text = event.text.trim();
    // Leave pi's own commands and inline shell alone.
    if (!text || text.startsWith("/") || text.startsWith("!")) return { action: "continue" };
    ctxRef = ctx;
    try {
      await sendPrompt(text, event.images);
    } catch (err) {
      ctx.ui.notify(`Dodo: ${(err as Error).message}`, "error");
      ctx.ui.setEditorText(event.text);
    }
    return { action: "handled" };
  });

  // ─── Command ───

  const SUBCOMMANDS = ["list", "new", "attach", "detach", "model", "abort", "status", "open"];

  pi.registerCommand("dodo", {
    description: "Attach pi to a Dodo session (list, new, attach, detach, model, abort, status, open)",
    getArgumentCompletions: (prefix) => {
      if (prefix.includes(" ")) return null;
      return SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
    },
    handler: async (args, ctx) => {
      ctxRef = ctx;
      const [sub = "", ...rest] = args.trim().split(/\s+/);
      const arg = args.trim().slice(sub.length).trim();
      try {
        switch (sub) {
          case "":
          case "list":
            return await pickAndAttach(ctx);
          case "new":
            return await newSession(arg);
          case "attach": {
            if (!rest[0]) return await pickAndAttach(ctx);
            const s = await resolveSession(rest[0]);
            await attach(s.id, s.title);
            return;
          }
          case "detach":
            attachGen++; // also cancels an attach that is still loading
            if (!attached) return notify(loading > 0 ? "Cancelled the attach that was loading." : "Not attached.");
            detachQuiet();
            pi.appendEntry("dodo-detach", {});
            return notify("Detached. Input goes to the local model again; the Dodo session keeps running.");
          case "model":
            return await setModel(ctx, arg);
          case "abort":
            if (!attached) return notify("Not attached.");
            await client().request(`/session/${attached.id}/abort`, { method: "POST" });
            return notify("Abort sent.");
          case "status": {
            if (!attached) return notify("Not attached. /dodo to pick a session.");
            state = await client().request<SessionState>(`/session/${attached.id}`);
            updateStatus();
            const m = modelLabel(state, defaultModel);
            const running = state.status === "running";
            return notify(
              [
                `Session ${attached.id}`,
                `Status: ${state.status}`,
                running ? `Model: ${m.current} (this prompt)` : `Model: ${m.current} (${m.nextSource})`,
                ...(m.next ? [`Next prompt: ${m.next} (${m.nextSource})`] : []),
                `Context: ${state.contextUsagePercent ?? "?"}% of ${state.contextWindow ?? "?"}`,
                `Tokens: ${state.totalTokenInput ?? 0} in / ${state.totalTokenOutput ?? 0} out`,
              ].join("\n"),
            );
          }
          case "open": {
            const id = attached?.id ?? rest[0];
            const url = `${client().creds.url}/${id ? `#session=${id}` : ""}`;
            const [cmd, ...cmdArgs] = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
            const child = spawn(cmd!, cmdArgs, { detached: true, stdio: "ignore" });
            child.on("error", () => notify(`Could not open a browser. URL: ${url}`, "warning"));
            child.unref();
            return;
          }
          default:
            return notify(`Unknown subcommand "${sub}". Try: ${SUBCOMMANDS.join(", ")}`, "warning");
        }
      } catch (err) {
        notify(`Dodo: ${(err as Error).message}`, "error");
      }
    },
  });

  // ─── Lifecycle ───

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    if (!ctx.hasUI) return;
    // Rebuild what this pi session already showed, and re-attach if the last
    // Dodo action on this branch was an attach.
    seen = new Set();
    let last: AttachEntry | undefined;
    for (const e of ctx.sessionManager.getBranch()) {
      if (e.type !== "custom") continue;
      if (e.customType === "dodo-message") seen.add((e.data as MessageEntry).id);
      else if (e.customType === "dodo-attach") last = e.data as AttachEntry;
      else if (e.customType === "dodo-detach") last = undefined;
    }
    if (!last) return;
    try {
      await attach(last.id, last.title ?? null, { record: false, fresh: last.fresh });
    } catch (err) {
      const msg = (err as Error).message;
      ctx.ui.notify(`Dodo: could not re-attach to ${short(last.id)}: ${msg}`, "warning");
      // The session is gone or no longer ours: stop trying on every start.
      if (/^No Dodo session|^Dodo (403|404)/.test(msg)) pi.appendEntry("dodo-detach", {});
    }
  });

  pi.on("session_shutdown", async () => {
    attachGen++;
    detachQuiet();
    ctxRef = undefined;
  });
}
