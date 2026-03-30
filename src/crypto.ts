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

/** Derive a Passkey-Derived Key (PDK) from user passkey + salt via PBKDF2-SHA256. */
export async function derivePDK(passkey: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passkey).buffer as ArrayBuffer,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt.buffer as ArrayBuffer, iterations: 100_000 },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

/** Derive a Server-Derived Key (SDK) from master key + email via HKDF-SHA256. */
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
      salt: new TextEncoder().encode(email).buffer as ArrayBuffer,
      info: new TextEncoder().encode("dodo-server-key").buffer as ArrayBuffer,
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
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
