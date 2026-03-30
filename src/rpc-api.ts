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
  private version: string;

  constructor(version: string) {
    super();
    this.version = version;
  }

  health(): { status: string; version: string } {
    return { status: "ok", version: this.version };
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
