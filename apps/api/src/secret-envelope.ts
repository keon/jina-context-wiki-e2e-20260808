import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function sealSecret(plaintext: string, associatedData: string, encodedKey: string | undefined): string {
  const key = encryptionKey(encodedKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")}`;
}

export function openSecret(envelope: string, associatedData: string, encodedKey: string | undefined): string {
  if (!envelope.startsWith(PREFIX)) throw new Error("stored secret is not an encrypted envelope");
  const packed = Buffer.from(envelope.slice(PREFIX.length), "base64");
  if (packed.length <= IV_BYTES + TAG_BYTES) throw new Error("stored secret envelope is invalid");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(encodedKey), packed.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(associatedData, "utf8"));
  decipher.setAuthTag(packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(packed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
}

export function secretAssociatedData(tenantId: string, integration: "openrouter" | "openai" | "codex"): string {
  return `jina:context-graph:${tenantId}:${integration}`;
}

function encryptionKey(encodedKey: string | undefined): Buffer {
  const raw = encodedKey?.trim();
  if (!raw) throw new Error("SECRETS_ENCRYPTION_KEY is required to store or use model integrations");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("SECRETS_ENCRYPTION_KEY must be base64-encoded 32 bytes");
  return key;
}
