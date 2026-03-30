/**
 * Share token utilities for session sharing.
 *
 * - generateShareToken(): 32-byte random hex token (64 chars)
 * - hashShareToken(): HMAC-SHA256 hash for storage (never store plaintext)
 * - signCookie() / verifyCookie(): HMAC-SHA256 signed cookies
 *
 * Cookie format: base64(payload):base64(signature)
 * Payload: JSON string of { sessionId, permission, ownerEmail, tokenHash, expiresAt }
 */

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/** Generate a 32-byte random token as hex (64 chars). */
export function generateShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(bytes);
}

/** Hash a share token with HMAC-SHA256 for storage. Returns hex string. */
export async function hashShareToken(token: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("dodo-share-token"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
  return bytesToHex(new Uint8Array(signature));
}

/** Sign a cookie payload with HMAC-SHA256. Returns base64(payload):base64(signature). */
export async function signCookie(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const payloadB64 = btoa(payload);
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return `${payloadB64}:${sigB64}`;
}

/** Verify a signed cookie. Returns the payload string if valid, null otherwise. */
export async function verifyCookie(signedValue: string, secret: string): Promise<string | null> {
  const colonIndex = signedValue.lastIndexOf(":");
  if (colonIndex === -1) return null;

  const payloadB64 = signedValue.slice(0, colonIndex);
  const sigB64 = signedValue.slice(colonIndex + 1);

  let payload: string;
  let providedSig: Uint8Array;
  try {
    payload = atob(payloadB64);
    const sigBinary = atob(sigB64);
    providedSig = new Uint8Array(sigBinary.length);
    for (let i = 0; i < sigBinary.length; i++) {
      providedSig[i] = sigBinary.charCodeAt(i);
    }
  } catch {
    return null;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const valid = await crypto.subtle.verify("HMAC", key, providedSig.buffer as ArrayBuffer, new TextEncoder().encode(payload));
  return valid ? payload : null;
}
