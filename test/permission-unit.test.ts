/**
 * Pure unit tests for requirePermission helper and isCallerOwner logic.
 * Extracted from permission-enforcement.test.ts to avoid importing the main
 * worker module. requirePermission is re-implemented here since it's a small
 * function — the canonical version lives in src/index.ts but importing it
 * triggers the full worker dependency chain.
 * See: https://github.com/cloudflare/workers-sdk/issues/13191
 */
import { describe, expect, it } from "vitest";

// Re-implement requirePermission to match src/index.ts without importing it.
// Kept in sync manually (same pattern as outbound.test.ts).
const PERMISSION_LEVELS: Record<string, number> = { readonly: 0, readwrite: 1, write: 1, admin: 2 };

function requirePermission(
  c: { get: (key: string) => unknown; json: (data: unknown, status?: number) => Response },
  required: "readonly" | "write" | "admin",
): Response | null {
  const perm = c.get("sessionPermission") as string;
  if ((PERMISSION_LEVELS[perm] ?? -1) < (PERMISSION_LEVELS[required] ?? 999)) {
    return c.json({ error: "Insufficient permission" }, 403);
  }
  return null;
}

describe("requirePermission helper (unit)", () => {
  it("returns null when permission meets required level", () => {
    const mockContext = {
      get: (key: string) => key === "sessionPermission" ? "admin" : undefined,
      json: (data: unknown, status?: number) => Response.json(data, { status }),
    };
    expect(requirePermission(mockContext, "readonly")).toBeNull();
    expect(requirePermission(mockContext, "write")).toBeNull();
    expect(requirePermission(mockContext, "admin")).toBeNull();
  });

  it("returns null for write permission when required is write", () => {
    const mockContext = {
      get: (key: string) => key === "sessionPermission" ? "write" : undefined,
      json: (data: unknown, status?: number) => Response.json(data, { status }),
    };
    expect(requirePermission(mockContext, "readonly")).toBeNull();
    expect(requirePermission(mockContext, "write")).toBeNull();
  });

  it("returns null for readwrite permission when required is write", () => {
    const mockContext = {
      get: (key: string) => key === "sessionPermission" ? "readwrite" : undefined,
      json: (data: unknown, status?: number) => Response.json(data, { status }),
    };
    expect(requirePermission(mockContext, "readonly")).toBeNull();
    expect(requirePermission(mockContext, "write")).toBeNull();
  });

  it("returns 403 when readonly tries write operation", () => {
    const mockContext = {
      get: (key: string) => key === "sessionPermission" ? "readonly" : undefined,
      json: (data: unknown, status?: number) => Response.json(data, { status }),
    };
    const result = requirePermission(mockContext, "write");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("returns 403 when readonly tries admin operation", () => {
    const mockContext = {
      get: (key: string) => key === "sessionPermission" ? "readonly" : undefined,
      json: (data: unknown, status?: number) => Response.json(data, { status }),
    };
    const result = requirePermission(mockContext, "admin");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("returns 403 when write tries admin operation", () => {
    const mockContext = {
      get: (key: string) => key === "sessionPermission" ? "write" : undefined,
      json: (data: unknown, status?: number) => Response.json(data, { status }),
    };
    const result = requirePermission(mockContext, "admin");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("returns 403 when permission is undefined", () => {
    const mockContext = {
      get: () => undefined,
      json: (data: unknown, status?: number) => Response.json(data, { status }),
    };
    const result = requirePermission(mockContext, "readonly");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });
});

describe("isCallerOwner logic (unit)", () => {
  // Re-implemented locally — the real version is in agentic.ts
  function isCallerOwner(authorEmail?: string, ownerEmail?: string): boolean {
    if (!authorEmail || !ownerEmail) return true;
    return authorEmail === ownerEmail;
  }

  it("returns true when author matches owner", () => {
    expect(isCallerOwner("user@test.local", "user@test.local")).toBe(true);
  });

  it("returns false when author differs from owner", () => {
    expect(isCallerOwner("guest@test.local", "owner@test.local")).toBe(false);
  });

  it("returns true when author is undefined (default to owner)", () => {
    expect(isCallerOwner(undefined, "owner@test.local")).toBe(true);
  });
});
