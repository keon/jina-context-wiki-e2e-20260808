import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const ENVELOPE_VERSION = 1;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const FIXED_ENVELOPE_BYTES = 1 + IV_BYTES + AUTH_TAG_BYTES;

export interface GithubWebhookCipherBinding {
  readonly deliveryId: string;
  readonly event: string;
  readonly payloadSha256: string;
  readonly encryptionKeyVersion: string;
}

export function githubWebhookPayloadDigest(rawBody: Buffer): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

export function encryptGithubWebhookPayload(
  rawBody: Buffer,
  key: Buffer,
  binding: GithubWebhookCipherBinding,
): Buffer {
  requireEncryptionKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(bindingBytes(binding));
  const ciphertext = Buffer.concat([cipher.update(rawBody), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([ENVELOPE_VERSION]), iv, authTag, ciphertext]);
}

export function decryptGithubWebhookPayload(
  envelope: Buffer,
  key: Buffer,
  binding: GithubWebhookCipherBinding,
): Buffer {
  requireEncryptionKey(key);
  if (envelope.length < FIXED_ENVELOPE_BYTES || envelope[0] !== ENVELOPE_VERSION) {
    throw new Error("GitHub webhook inbox ciphertext has an unsupported envelope");
  }
  const iv = envelope.subarray(1, 1 + IV_BYTES);
  const authTag = envelope.subarray(1 + IV_BYTES, FIXED_ENVELOPE_BYTES);
  const ciphertext = envelope.subarray(FIXED_ENVELOPE_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(bindingBytes(binding));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function bindingBytes(binding: GithubWebhookCipherBinding): Buffer {
  return Buffer.from(JSON.stringify([
    binding.deliveryId,
    binding.event,
    binding.payloadSha256,
    binding.encryptionKeyVersion,
  ]));
}

function requireEncryptionKey(key: Buffer): void {
  if (key.length !== 32) {
    throw new Error("GitHub webhook inbox encryption key must be exactly 32 bytes");
  }
}
