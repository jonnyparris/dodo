/**
 * Scaffolding for a future Cap'n Web RPC feature.
 *
 * Only DodoAuthenticatedApi is wired today — it is constructed in the
 * /rpc Hono route (src/index.ts) and served via @hono/capnweb's
 * newRpcResponse().
 *
 * AgentConnectionTransport is instantiated by the WebSocket branch in
 * coding-agent.ts when a client connects with ?protocol=capnweb, but
 * there is currently no RpcSession that consumes the delivered messages.
 * The transport stores messages in a queue so a future RpcSession can
 * receive() them; for now this is a no-op pipeline that preserves the
 * existing behaviour.
 *
 * DodoPublicApi is kept because it is exercised in unit tests, but it is
 * not instantiated in production code paths.
 */

import { RpcTarget } from "capnweb";
import type { Connection } from "agents";
import type { RpcTransport } from "capnweb";
import type { Env } from "./types";
import { canonicalizeEmail, getUserControlStub, isAdmin } from "./auth";

// ─── Shared types ───

interface RpcUserInfo {
  email: string;
  displayName?: string;
  isAdmin: boolean;
}

interface RpcSessionSummary {
  id: string;
  title: string | null;
  status: string;
  ownerEmail: string;
}

// ─── Public API (no auth required) ───

export class DodoPublicApi extends RpcTarget {
  private env: Env;

  constructor(env: Env) {
    super();
    this.env = env;
  }

  health(): { status: string; version: string } {
    return { status: "ok", version: this.env.DODO_VERSION ?? "unknown" };
  }
}

/** Build a user-scoped RPC API for a server-authenticated email.
 *  Callers (Hono handlers) MUST have validated the email against the
 *  Access JWT or dev-mode bypass before invoking this. */
export function buildAuthenticatedApi(env: Env, email: string): DodoAuthenticatedApi {
  const canonical = canonicalizeEmail(email);
  if (!canonical) {
    throw new Error("buildAuthenticatedApi: a non-empty email is required");
  }

  return new DodoAuthenticatedApi({
    userInfo: { email: canonical, isAdmin: isAdmin(canonical, env) },
    listSessions: async () => {
      const stub = getUserControlStub(env, canonical);
      const res = await stub.fetch("https://user-control/sessions", {
        headers: { "x-owner-email": canonical },
      });
      const body = (await res.json()) as { sessions: RpcSessionSummary[] };
      return body.sessions;
    },
    createSession: async () => {
      const sessionId = crypto.randomUUID();
      const stub = getUserControlStub(env, canonical);
      await stub.fetch("https://user-control/sessions", {
        body: JSON.stringify({ id: sessionId, ownerEmail: canonical, createdBy: canonical }),
        headers: { "content-type": "application/json", "x-owner-email": canonical },
        method: "POST",
      });
      return sessionId;
    },
  });
}

// ─── Authenticated API (user-scoped) ───

export class DodoAuthenticatedApi extends RpcTarget {
  private userInfo: RpcUserInfo;
  private listSessionsFn: () => Promise<RpcSessionSummary[]>;
  private createSessionFn: () => Promise<string>;

  constructor(opts: {
    userInfo: RpcUserInfo;
    listSessions: () => Promise<RpcSessionSummary[]>;
    createSession: () => Promise<string>;
  }) {
    super();
    this.userInfo = opts.userInfo;
    this.listSessionsFn = opts.listSessions;
    this.createSessionFn = opts.createSession;
  }

  whoami(): RpcUserInfo {
    return this.userInfo;
  }

  async listSessions(): Promise<RpcSessionSummary[]> {
    return this.listSessionsFn();
  }

  async createSession(): Promise<string> {
    return this.createSessionFn();
  }
}

// ─── Transport adapter ───

export class AgentConnectionTransport implements RpcTransport {
  private messageQueue: string[] = [];
  private messageResolve?: (msg: string) => void;
  private messageReject?: (err: Error) => void;
  private closed = false;

  constructor(private connection: Connection) {}

  async send(message: string): Promise<void> {
    if (this.closed) throw new Error("Transport closed");
    this.connection.send(message);
  }

  async receive(): Promise<string> {
    if (this.messageQueue.length > 0) {
      return this.messageQueue.shift()!;
    }
    if (this.closed) {
      throw new Error("Transport closed");
    }
    return new Promise<string>((resolve, reject) => {
      this.messageResolve = resolve;
      this.messageReject = reject;
    });
  }

  /**
   * Called by the CodingAgent's onMessage handler to feed incoming
   * WebSocket messages into the transport's receive() pipeline.
   */
  deliver(message: string): void {
    if (this.messageResolve) {
      const resolve = this.messageResolve;
      this.messageResolve = undefined;
      this.messageReject = undefined;
      resolve(message);
    } else {
      this.messageQueue.push(message);
    }
  }

  /**
   * Called when the connection closes. Rejects any pending receive().
   */
  close(): void {
    this.closed = true;
    if (this.messageReject) {
      const reject = this.messageReject;
      this.messageResolve = undefined;
      this.messageReject = undefined;
      reject(new Error("Transport closed"));
    }
  }

  abort(reason: unknown): void {
    this.closed = true;
    const message = reason instanceof Error ? reason.message : "Transport aborted";
    if (this.messageReject) {
      const reject = this.messageReject;
      this.messageResolve = undefined;
      this.messageReject = undefined;
      reject(new Error(message));
    }
  }
}
