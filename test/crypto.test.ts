import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  decryptSecret,
  derivePDK,
  deriveSDK,
  encryptSecret,
  generateDEK,
  generateSalt,
  hexToBytes,
  unwrapDEK,
  wrapDEK,
} from "../src/crypto";

describe("Crypto — hybrid envelope encryption", () => {
  const TEST_MASTER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const TEST_EMAIL = "user@example.com";
  const TEST_PASSKEY = "my-secure-passkey";

  it("derivePDK is deterministic for same inputs", async () => {
    const salt = generateSalt();
    const key1 = await derivePDK(TEST_PASSKEY, salt);
    const key2 = await derivePDK(TEST_PASSKEY, salt);
    // Can't compare CryptoKey directly — wrap the same data with both and compare
    const dek = generateDEK();
    const wrapped1 = await wrapDEK(dek, key1);
    const wrapped2 = await wrapDEK(dek, key2);
    // Both should unwrap successfully with the other key (deterministic)
    const unwrapped1 = await unwrapDEK(wrapped1, key2);
    const unwrapped2 = await unwrapDEK(wrapped2, key1);
    expect(unwrapped1).toEqual(dek);
    expect(unwrapped2).toEqual(dek);
  });

  it("derivePDK produces different keys for different passphrases", async () => {
    const salt = generateSalt();
    const key1 = await derivePDK("passkey-a", salt);
    const key2 = await derivePDK("passkey-b", salt);
    const dek = generateDEK();
    const wrapped = await wrapDEK(dek, key1);
    // Unwrapping with wrong key should fail
    await expect(unwrapDEK(wrapped, key2)).rejects.toThrow();
  });

  it("derivePDK produces different keys for different salts", async () => {
    const salt1 = generateSalt();
    const salt2 = generateSalt();
    const key1 = await derivePDK(TEST_PASSKEY, salt1);
    const key2 = await derivePDK(TEST_PASSKEY, salt2);
    const dek = generateDEK();
    const wrapped = await wrapDEK(dek, key1);
    await expect(unwrapDEK(wrapped, key2)).rejects.toThrow();
  });

  it("deriveSDK is deterministic for same inputs", async () => {
    const key1 = await deriveSDK(TEST_MASTER_KEY, TEST_EMAIL);
    const key2 = await deriveSDK(TEST_MASTER_KEY, TEST_EMAIL);
    const dek = generateDEK();
    const wrapped = await wrapDEK(dek, key1);
    const unwrapped = await unwrapDEK(wrapped, key2);
    expect(unwrapped).toEqual(dek);
  });

  it("deriveSDK produces different keys per email", async () => {
    const key1 = await deriveSDK(TEST_MASTER_KEY, "alice@example.com");
    const key2 = await deriveSDK(TEST_MASTER_KEY, "bob@example.com");
    const dek = generateDEK();
    const wrapped = await wrapDEK(dek, key1);
    await expect(unwrapDEK(wrapped, key2)).rejects.toThrow();
  });

  it("generateDEK returns 32-byte Uint8Array", () => {
    const dek = generateDEK();
    expect(dek).toBeInstanceOf(Uint8Array);
    expect(dek.length).toBe(32);
  });

  it("generateDEK produces different values each call", () => {
    const a = generateDEK();
    const b = generateDEK();
    expect(bytesToBase64(a)).not.toBe(bytesToBase64(b));
  });

  it("generateSalt returns 16-byte Uint8Array", () => {
    const salt = generateSalt();
    expect(salt).toBeInstanceOf(Uint8Array);
    expect(salt.length).toBe(16);
  });

  it("wrapDEK/unwrapDEK round-trip with PDK", async () => {
    const salt = generateSalt();
    const pdk = await derivePDK(TEST_PASSKEY, salt);
    const dek = generateDEK();
    const wrapped = await wrapDEK(dek, pdk);
    expect(typeof wrapped).toBe("string");
    expect(wrapped.length).toBeGreaterThan(0);
    const unwrapped = await unwrapDEK(wrapped, pdk);
    expect(unwrapped).toEqual(dek);
  });

  it("wrapDEK/unwrapDEK round-trip with SDK", async () => {
    const sdk = await deriveSDK(TEST_MASTER_KEY, TEST_EMAIL);
    const dek = generateDEK();
    const wrapped = await wrapDEK(dek, sdk);
    const unwrapped = await unwrapDEK(wrapped, sdk);
    expect(unwrapped).toEqual(dek);
  });

  it("unwrapDEK with wrong key throws", async () => {
    const sdk = await deriveSDK(TEST_MASTER_KEY, TEST_EMAIL);
    const wrongKey = await deriveSDK(TEST_MASTER_KEY, "wrong@example.com");
    const dek = generateDEK();
    const wrapped = await wrapDEK(dek, sdk);
    await expect(unwrapDEK(wrapped, wrongKey)).rejects.toThrow();
  });

  it("encryptSecret/decryptSecret round-trip", async () => {
    const dek = generateDEK();
    const plaintext = "ghp_myGitHubToken123456789";
    const encrypted = await encryptSecret(plaintext, dek);
    expect(typeof encrypted).toBe("string");
    expect(encrypted).not.toBe(plaintext);
    const decrypted = await decryptSecret(encrypted, dek);
    expect(decrypted).toBe(plaintext);
  });

  it("encryptSecret produces different ciphertext each call (random IV)", async () => {
    const dek = generateDEK();
    const plaintext = "same-secret";
    const enc1 = await encryptSecret(plaintext, dek);
    const enc2 = await encryptSecret(plaintext, dek);
    expect(enc1).not.toBe(enc2); // different IVs
    expect(await decryptSecret(enc1, dek)).toBe(plaintext);
    expect(await decryptSecret(enc2, dek)).toBe(plaintext);
  });

  it("decryptSecret with wrong DEK throws", async () => {
    const dek1 = generateDEK();
    const dek2 = generateDEK();
    const encrypted = await encryptSecret("my-secret", dek1);
    await expect(decryptSecret(encrypted, dek2)).rejects.toThrow();
  });

  it("encrypted output is valid base64 containing IV + ciphertext", async () => {
    const dek = generateDEK();
    const encrypted = await encryptSecret("test", dek);
    const bytes = base64ToBytes(encrypted);
    // 12 bytes IV + at least 4 bytes ciphertext + 16 bytes GCM tag
    expect(bytes.length).toBeGreaterThanOrEqual(32);
  });

  it("full onboarding flow: generate DEK → wrap with PDK+SDK → unwrap with SDK → decrypt", async () => {
    const salt = generateSalt();
    const dek = generateDEK();
    const pdk = await derivePDK(TEST_PASSKEY, salt);
    const sdk = await deriveSDK(TEST_MASTER_KEY, TEST_EMAIL);
    const wrappedPasskey = await wrapDEK(dek, pdk);
    const wrappedServer = await wrapDEK(dek, sdk);
    // Server can unwrap via SDK
    const dekFromServer = await unwrapDEK(wrappedServer, sdk);
    expect(dekFromServer).toEqual(dek);
    // User can unwrap via PDK
    const dekFromPasskey = await unwrapDEK(wrappedPasskey, pdk);
    expect(dekFromPasskey).toEqual(dek);
    // Encrypt and decrypt a secret
    const encrypted = await encryptSecret("my-github-token", dekFromServer);
    const decrypted = await decryptSecret(encrypted, dekFromPasskey);
    expect(decrypted).toBe("my-github-token");
  });

  it("passkey change flow: unwrap with old PDK → re-wrap with new PDK → unwrap with new PDK", async () => {
    const salt = generateSalt();
    const dek = generateDEK();
    const oldPdk = await derivePDK("old-passkey", salt);
    const wrappedOld = await wrapDEK(dek, oldPdk);
    // Unwrap with old passkey
    const recoveredDek = await unwrapDEK(wrappedOld, oldPdk);
    expect(recoveredDek).toEqual(dek);
    // Re-wrap with new passkey
    const newSalt = generateSalt();
    const newPdk = await derivePDK("new-passkey", newSalt);
    const wrappedNew = await wrapDEK(recoveredDek, newPdk);
    // Unwrap with new passkey works
    const dekFromNew = await unwrapDEK(wrappedNew, newPdk);
    expect(dekFromNew).toEqual(dek);
    // Old passkey no longer works
    await expect(unwrapDEK(wrappedNew, oldPdk)).rejects.toThrow();
  });

  it("hexToBytes and base64 helpers round-trip", () => {
    const hex = "deadbeef";
    const bytes = hexToBytes(hex);
    expect(bytes).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    const b64 = bytesToBase64(bytes);
    const back = base64ToBytes(b64);
    expect(back).toEqual(bytes);
  });
});
