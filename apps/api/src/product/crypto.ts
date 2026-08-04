import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// App-layer AES-256-GCM encryption for secrets at rest (provider API keys, GitHub
// access tokens). The key comes from SECRETS_ENCRYPTION_KEY (base64, 32 bytes). When
// unset we fall back to plaintext so local dev keeps working; we log the warning once.

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce, recommended for GCM
const ENVELOPE_PREFIX = "enc:v1:";

let cachedKey: Buffer | null | undefined;
let warnedMissingKey = false;

function encryptionKey(): Buffer | null {
  if (cachedKey !== undefined) {
    return cachedKey;
  }
  const raw = process.env.SECRETS_ENCRYPTION_KEY?.trim();
  if (!raw) {
    cachedKey = null;
    return cachedKey;
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("SECRETS_ENCRYPTION_KEY must be base64-encoded 32 bytes (256 bits)");
  }
  cachedKey = key;
  return cachedKey;
}

function warnPlaintextOnce(): void {
  if (!warnedMissingKey) {
    warnedMissingKey = true;
    console.warn("secrets_encryption_disabled", {
      message: "SECRETS_ENCRYPTION_KEY is unset; secrets are stored as plaintext",
    });
  }
}

/** Encrypt a string into a self-describing envelope. Returns plaintext unchanged when no key is configured. */
export function encryptSecret(plaintext: string): string {
  const key = encryptionKey();
  if (!key) {
    warnPlaintextOnce();
    return plaintext;
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ENVELOPE_PREFIX + Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/** Decrypt an envelope produced by encryptSecret. Legacy plaintext values are returned as-is. */
export function decryptSecret(value: string): string {
  if (!value.startsWith(ENVELOPE_PREFIX)) {
    return value; // legacy plaintext row
  }
  const key = encryptionKey();
  if (!key) {
    // We have an encrypted blob but no key to read it; surface rather than leak garbage.
    throw new Error("SECRETS_ENCRYPTION_KEY is required to decrypt stored secrets");
  }
  const packed = Buffer.from(value.slice(ENVELOPE_PREFIX.length), "base64");
  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = packed.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** True when a value looks like one of our encryption envelopes. */
export function isEncryptedEnvelope(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX);
}
