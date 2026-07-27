import { createHash, randomUUID } from "node:crypto";

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function fingerprint(value: unknown): string {
  const hash = createHash("sha256");
  if (typeof value === "string") {
    hash.update(value);
  } else {
    writeCanonicalJson(hash, value);
  }
  return hash.digest("hex");
}

function writeCanonicalJson(sink: { update(value: string): unknown }, value: unknown, arrayItem = false): void {
  if (Array.isArray(value)) {
    sink.update("[");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) sink.update(",");
      writeCanonicalJson(sink, value[index], true);
    }
    sink.update("]");
    return;
  }
  if (value !== null && typeof value === "object") {
    sink.update("{");
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined && typeof item !== "function" && typeof item !== "symbol")
      .sort(([left], [right]) => left.localeCompare(right));
    for (const [index, [key, item]] of entries.entries()) {
      if (index > 0) sink.update(",");
      sink.update(JSON.stringify(key));
      sink.update(":");
      writeCanonicalJson(sink, item);
    }
    sink.update("}");
    return;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    if (arrayItem) {
      sink.update("null");
      return;
    }
    throw new TypeError("Value is not JSON serializable");
  }
  sink.update(serialized);
}

export function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${fingerprint(value).slice(0, 32)}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function isFullCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

export function normalizeRepository(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(normalized)) {
    throw new Error(`Invalid repository: ${value}`);
  }
  return normalized;
}

export function repositoryAclFingerprint(tenantId: string, repository: string): string {
  if (!tenantId.trim()) throw new Error("tenantId is required");
  return fingerprint({
    scope: "repository-read",
    tenantId,
    repository: normalizeRepository(repository)
  });
}

export function normalizeIsoTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return parsed.toISOString();
}
