/**
 * Hybrid envelope encryption using Web Crypto API.
 *
 * Key hierarchy:
 *   User passkey → PBKDF2-SHA256 → PDK (Passkey-Derived Key)
 *   SECRETS_MASTER_KEY → HKDF-SHA256(email) → SDK (Server-Derived Key)
 *   Random 256-bit DEK → encrypts all user secrets via AES-256-GCM
 *   DEK is wrapped (encrypted) twice: once with PDK, once with SDK
 */

// ─── Key Derivation ───

/**
 * Default PBKDF2 iteration count for new envelopes. Set to 600k to match
 * OWASP guidance (≥600k for PBKDF2-SHA256 as of 2023+). Legacy envelopes
 * created with the previous 100k count keep working — see PBKDF2_LEGACY_ITERATIONS
 * and the `pbkdf2_iterations` column on `key_envelope`. (audit finding M2)
 */
export const PBKDF2_DEFAULT_ITERATIONS = 600_000;

/** Iteration count used by envelopes created before the bump. Read from
 *  the envelope row when present; assume this when the column is NULL. */
export const PBKDF2_LEGACY_ITERATIONS = 100_000;

/** Derive a Passkey-Derived Key (PDK) from user passkey + salt via PBKDF2-SHA256.
 *  `iterations` defaults to PBKDF2_DEFAULT_ITERATIONS for new wraps; existing
 *  rows pass the value stored alongside their wrap so unlock keeps working. */
export async function derivePDK(
  passkey: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_DEFAULT_ITERATIONS,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passkey).buffer as ArrayBuffer,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt.buffer as ArrayBuffer, iterations },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Derive a Server-Derived Key (SDK) from master key + email via HKDF-SHA256.
 *
 * The `salt` parameter uses the user's email intentionally: it makes each
 * user's SDK deterministic for the same master key, enabling server-side
 * recovery without storing additional per-user state.  This is safe because
 * HKDF's security does not depend on the salt being secret — it only needs
 * to be distinct per context, which the email guarantees.
 */
export async function deriveSDK(masterKeyHex: string, email: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    hexToBytes(masterKeyHex).buffer as ArrayBuffer,
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      // Email used as salt for deterministic server-side recovery — see docstring above
      salt: new TextEncoder().encode(email).buffer as ArrayBuffer,
      info: new TextEncoder().encode("dodo-server-key").buffer as ArrayBuffer,
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ─── Key Wrapping ───

/** Wrap (encrypt) a DEK with a wrapping key. Returns base64(iv + ciphertext). */
export async function wrapDEK(dek: Uint8Array, wrappingKey: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv.buffer as ArrayBuffer }, wrappingKey, dek.buffer as ArrayBuffer);
  const packed = new Uint8Array(iv.length + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ciphertext), iv.length);
  return bytesToBase64(packed);
}

/** Unwrap (decrypt) a DEK from base64(iv + ciphertext) using the wrapping key. */
export async function unwrapDEK(wrapped: string, wrappingKey: CryptoKey): Promise<Uint8Array> {
  const packed = base64ToBytes(wrapped);
  const iv = packed.slice(0, 12);
  const ciphertext = packed.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv.buffer as ArrayBuffer }, wrappingKey, ciphertext.buffer as ArrayBuffer);
  return new Uint8Array(decrypted);
}

// ─── Secret Encrypt/Decrypt ───

/** Encrypt a plaintext secret with a DEK. Returns base64(iv + ciphertext). */
export async function encryptSecret(plaintext: string, dek: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    dek.buffer as ArrayBuffer,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
    key,
    new TextEncoder().encode(plaintext).buffer as ArrayBuffer,
  );
  const packed = new Uint8Array(iv.length + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ciphertext), iv.length);
  return bytesToBase64(packed);
}

/** Decrypt a secret from base64(iv + ciphertext) using the DEK. */
export async function decryptSecret(encrypted: string, dek: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    dek.buffer as ArrayBuffer,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const packed = base64ToBytes(encrypted);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: packed.slice(0, 12).buffer as ArrayBuffer },
    key,
    packed.slice(12).buffer as ArrayBuffer,
  );
  return new TextDecoder().decode(decrypted);
}

// ─── Helpers ───

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("Invalid hex string");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Chunked Uint8Array → base64 conversion. Use for large binary buffers
 * (git pack files, attachments) where the per-byte loop above is OK but
 * `String.fromCharCode(...bytes)` would blow the call stack at >~64 KB.
 * (audit finding H9)
 *
 * Both forms are functionally equivalent for small inputs; this one is
 * just safe at any size.
 */
export function bytesToBase64Chunked(bytes: Uint8Array, chunkSize = 0x8000): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Generate a random 16-byte PBKDF2 salt. */
export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

/** Generate a random 32-byte DEK. */
export function generateDEK(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}
