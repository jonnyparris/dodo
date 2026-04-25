/**
 * Cap'n Web RPC API definitions for Dodo.
 *
 * These classes extend RpcTarget and define the methods available to
 * RPC clients. They provide a typed, permission-scoped API surface.
 *
 * The API is constructed in the Hono handler (`/rpc`) directly bound to
 * the authenticated email. There is NO `authenticate(email)` factory that
 * lets a caller assert their identity — the email is fixed by the Worker's
 * auth middleware and cannot be changed by the RPC client. (audit finding H1)
 */

import { RpcTarget } from "capnweb";
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
//
// Retains a `health()` method that exposes nothing user-specific. Anything
// requiring authentication MUST live on `DodoAuthenticatedApi`, which is
// constructed from a server-validated email — never from a client claim.

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
