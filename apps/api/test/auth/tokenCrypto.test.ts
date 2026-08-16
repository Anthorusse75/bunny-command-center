import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret } from "../../src/auth/tokenCrypto.js";

const KEY = randomBytes(32);

describe("Discord token encryption at rest (AES-256-GCM, ADR-020)", () => {
  it("round-trips a plaintext token exactly", () => {
    const plaintext = "a-fake-discord-access-token-value";
    const encrypted = encryptSecret(plaintext, KEY);
    expect(decryptSecret(encrypted, KEY)).toBe(plaintext);
  });

  it("never stores the plaintext inside the ciphertext buffer", () => {
    const plaintext = "super-secret-token-xyz";
    const encrypted = encryptSecret(plaintext, KEY);
    expect(encrypted.toString("utf-8")).not.toContain(plaintext);
    expect(encrypted.toString("base64")).not.toContain(Buffer.from(plaintext).toString("base64"));
  });

  it("produces a different ciphertext for the same plaintext each call (random IV)", () => {
    const plaintext = "same-token";
    const a = encryptSecret(plaintext, KEY);
    const b = encryptSecret(plaintext, KEY);
    expect(a.equals(b)).toBe(false);
  });

  it("rejects decryption with the wrong key", () => {
    const encrypted = encryptSecret("token", KEY);
    const wrongKey = randomBytes(32);
    expect(() => decryptSecret(encrypted, wrongKey)).toThrow();
  });

  it("rejects a tampered ciphertext (GCM auth tag catches it)", () => {
    const encrypted = encryptSecret("token", KEY);
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1]! ^ 0xff) & 0xff;
    expect(() => decryptSecret(tampered, KEY)).toThrow();
  });

  it("rejects a too-short payload rather than throwing an obscure error", () => {
    expect(() => decryptSecret(Buffer.from("short"), KEY)).toThrow(/too short/);
  });
});
