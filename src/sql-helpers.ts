export type SqlRow = Record<string, unknown>;

export function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

export function epochToIso(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return new Date(0).toISOString();
  }
  return new Date(num * 1000).toISOString();
}

export class SqlHelper {
  constructor(private readonly sql: { exec(query: string, ...bindings: unknown[]): unknown }) {}

  exec(query: string, ...bindings: unknown[]): void {
    this.sql.exec(query, ...bindings);
  }

  all(query: string, ...bindings: unknown[]): SqlRow[] {
    return Array.from(this.sql.exec(query, ...bindings) as Iterable<SqlRow>);
  }

  one(query: string, ...bindings: unknown[]): SqlRow | null {
    return this.all(query, ...bindings)[0] ?? null;
  }
}
