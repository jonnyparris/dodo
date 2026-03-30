/**
 * Presence tracking for realtime multiplayer sessions.
 * Tracks connected users across WebSocket and SSE connections.
 */

export interface PresenceEntry {
  email: string;
  displayName: string;
  permission: string;
  connectedAt: number;
  lastActivity: number;
  isTyping: boolean;
}

export class PresenceTracker {
  private entries = new Map<string, PresenceEntry>();

  join(connectionId: string, entry: Omit<PresenceEntry, "lastActivity" | "isTyping">): void {
    this.entries.set(connectionId, {
      ...entry,
      lastActivity: Date.now(),
      isTyping: false,
    });
  }

  leave(connectionId: string): void {
    this.entries.delete(connectionId);
  }

  setTyping(connectionId: string, isTyping: boolean): void {
    const entry = this.entries.get(connectionId);
    if (entry) {
      entry.isTyping = isTyping;
      entry.lastActivity = Date.now();
    }
  }

  updateActivity(connectionId: string): void {
    const entry = this.entries.get(connectionId);
    if (entry) {
      entry.lastActivity = Date.now();
    }
  }

  get(connectionId: string): PresenceEntry | undefined {
    return this.entries.get(connectionId);
  }

  getAll(): PresenceEntry[] {
    return [...this.entries.values()];
  }

  count(): number {
    return this.entries.size;
  }

  has(connectionId: string): boolean {
    return this.entries.has(connectionId);
  }

  /** Track last-seen message count per connection for reconnection. */
  setLastSeenMessage(connectionId: string, messageId: string): void {
    const entry = this.entries.get(connectionId);
    if (entry) {
      (entry as PresenceEntry & { lastSeenMessageId?: string }).lastSeenMessageId = messageId;
    }
  }

  /** Get last-seen message ID for a connection. */
  getLastSeenMessage(connectionId: string): string | null {
    const entry = this.entries.get(connectionId) as (PresenceEntry & { lastSeenMessageId?: string }) | undefined;
    return entry?.lastSeenMessageId ?? null;
  }

  /** Get deduplicated users by email (a user may have multiple connections). */
  getUniqueUsers(): PresenceEntry[] {
    const seen = new Map<string, PresenceEntry>();
    for (const entry of this.entries.values()) {
      const existing = seen.get(entry.email);
      // Keep the most recently active entry per email
      if (!existing || entry.lastActivity > existing.lastActivity) {
        seen.set(entry.email, entry);
      }
    }
    return [...seen.values()];
  }
}
