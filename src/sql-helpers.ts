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
