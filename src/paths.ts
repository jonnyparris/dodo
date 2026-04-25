/**
 * Path normalization shared between the CodingAgent HTTP handlers and
 * the agentic tool layer. Both must apply the same `..`-traversal rejection
 * so a tool can't reach outside the session workspace via the model
 * (audit finding M11).
 */
export function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error("Path is required");
  }

  const raw = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const segments = raw.split("/").filter(Boolean);
  const resolved: string[] = [];

  for (const segment of segments) {
    if (segment === "..") {
      throw new Error("Parent path traversal is not allowed");
    }
    if (segment !== ".") {
      resolved.push(segment);
    }
  }

  return `/${resolved.join("/")}`;
}
