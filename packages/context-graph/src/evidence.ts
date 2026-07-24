export const evidenceLocatorTypes = ["repository_range", "source_observation", "assertion_attestation"] as const;
export type EvidenceLocatorType = (typeof evidenceLocatorTypes)[number];

export interface RepositoryRangeEvidenceLocator {
  readonly type: "repository_range";
  readonly repository: string;
  readonly commitSha: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly contentDigest: string | null;
}

export interface SourceObservationEvidenceLocator {
  readonly type: "source_observation";
  readonly observationId: string;
  readonly observationType: string;
}

export interface AssertionAttestationEvidenceLocator {
  readonly type: "assertion_attestation";
  readonly assertionId: string;
  readonly attestationId: string;
}

export type EvidenceLocator =
  RepositoryRangeEvidenceLocator | SourceObservationEvidenceLocator | AssertionAttestationEvidenceLocator;

export function parseEvidenceLocator(value: unknown, owner = "evidence"): EvidenceLocator {
  if (!isRecord(value)) throw new Error(`${owner} must be an object`);
  const type = requiredString(value.type, `${owner}.type`);
  if (type === "repository_range") {
    assertOnlyKeys(value, ["type", "repository", "commitSha", "path", "startLine", "endLine", "contentDigest"], owner);
    const repository = requiredString(value.repository, `${owner}.repository`);
    const commitSha = requiredCommitSha(value.commitSha, `${owner}.commitSha`);
    const path = requiredRepositoryPath(value.path, `${owner}.path`);
    const startLine = requiredPositiveInteger(value.startLine, `${owner}.startLine`);
    const endLine = requiredPositiveInteger(value.endLine, `${owner}.endLine`);
    if (endLine < startLine) throw new Error(`${owner}.endLine must be greater than or equal to startLine`);
    const contentDigest = nullableString(value.contentDigest, `${owner}.contentDigest`);
    return {
      type,
      repository,
      commitSha,
      path,
      startLine,
      endLine,
      contentDigest
    };
  }
  if (type === "source_observation") {
    assertOnlyKeys(value, ["type", "observationId", "observationType"], owner);
    return {
      type,
      observationId: requiredString(value.observationId, `${owner}.observationId`),
      observationType: requiredString(value.observationType, `${owner}.observationType`)
    };
  }
  if (type === "assertion_attestation") {
    assertOnlyKeys(value, ["type", "assertionId", "attestationId"], owner);
    return {
      type,
      assertionId: requiredString(value.assertionId, `${owner}.assertionId`),
      attestationId: requiredString(value.attestationId, `${owner}.attestationId`)
    };
  }
  throw new Error(`${owner}.type is unsupported: ${type}`);
}

export function evidenceLocatorKey(locator: EvidenceLocator): string {
  if (locator.type === "repository_range") {
    return [
      locator.type,
      locator.repository,
      locator.commitSha,
      locator.path,
      locator.startLine,
      locator.endLine,
      locator.contentDigest ?? ""
    ].join(":");
  }
  if (locator.type === "source_observation") {
    return [locator.type, locator.observationType, locator.observationId].join(":");
  }
  return [locator.type, locator.assertionId, locator.attestationId].join(":");
}

function requiredCommitSha(value: unknown, name: string): string {
  const sha = requiredString(value, name).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error(`${name} must be a full 40-character commit SHA`);
  return sha;
}

function requiredRepositoryPath(value: unknown, name: string): string {
  const path = requiredString(value, name);
  const parts = path.split("/");
  if (path.startsWith("/") || path.includes("\\") || parts.includes("..") || parts.includes(".")) {
    throw new Error(`${name} must be repository-relative`);
  }
  return path;
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  return requiredString(value, name);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

function assertOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[], owner: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) throw new Error(`${owner} contains unsupported fields: ${unknown.sort().join(", ")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
