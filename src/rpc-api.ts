/**
 * Cap'n Web RPC API definitions for Dodo.
 *
 * These classes extend RpcTarget and define the methods available to
 * RPC clients. They provide a typed, permission-scoped API surface.
 *
 * API hierarchy:
 *   DodoPublicApi     — unauthenticated (health, version)
 *   DodoAuthenticatedApi — authenticated user (list sessions, create session)
 *   DodoSessionApi    — scoped to a specific session (send message, read files, presence)
 */

import { RpcTarget } from "capnweb";
import type { PresenceEntry } from "./presence";
import type { Env } from "./types";
import { getUserControlStub, isAdmin } from "./auth";

// ─── Shared types ───

export interface RpcUserInfo {
  email: string;
  displayName?: string;
  isAdmin: boolean;
}

export interface RpcSessionSummary {
  id: string;
  title: string | null;
  status: string;
  ownerEmail: string;
}

export interface RpcPresenceEntry {
  email: string;
  displayName: string;
  permission: string;
  connectedAt: number;
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

  /**
   * Authenticate with a user email and return a user-scoped API.
   * In production, this would verify a CF Access JWT. For now, we accept
   * the email directly (the Worker's auth middleware already verified it).
   */
  authenticate(email: string): DodoAuthenticatedApi {
    const env = this.env;
    return new DodoAuthenticatedApi({
      userInfo: { email, isAdmin: isAdmin(email, env) },
      listSessions: async () => {
        const stub = getUserControlStub(env, email);
        const res = await stub.fetch("https://user-control/sessions");
        const body = (await res.json()) as { sessions: RpcSessionSummary[] };
        return body.sessions;
      },
      createSession: async () => {
        const sessionId = crypto.randomUUID();
        const stub = getUserControlStub(env, email);
        await stub.fetch("https://user-control/sessions", {
          body: JSON.stringify({ id: sessionId, ownerEmail: email, createdBy: email }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        return sessionId;
      },
    });
  }
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

// ─── Session API (permission-scoped) ───

export class DodoSessionApi extends RpcTarget {
  private sessionId: string;
  private permission: string;
  private getPresenceFn: () => PresenceEntry[];

  constructor(opts: {
    sessionId: string;
    permission: string;
    getPresence: () => PresenceEntry[];
  }) {
    super();
    this.sessionId = opts.sessionId;
    this.permission = opts.permission;
    this.getPresenceFn = opts.getPresence;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getPermission(): string {
    return this.permission;
  }

  getPresence(): RpcPresenceEntry[] {
    return this.getPresenceFn().map((p) => ({
      connectedAt: p.connectedAt,
      displayName: p.displayName,
      email: p.email,
      permission: p.permission,
    }));
  }
}
