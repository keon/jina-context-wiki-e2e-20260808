import { createHash } from "node:crypto";
import { canonicalJson, normalizeRepository } from "../domain/fingerprint.js";
import { contextArtifactRepositoryPrefix, type ContextArtifactRef } from "./artifact-store.js";
import { contextPublicSnapshotDigest } from "../publication/board-publication.js";

export interface WikiContentPageV1 {
  readonly documentPath: string;
  readonly bodyMarkdown: string;
  readonly bodySha256: string;
}

/** Content-only, repository-scoped payload. It deliberately carries no release identity. */
export interface WikiContentBundleV1 {
  readonly version: 1;
  readonly publicSnapshotDigest: string;
  readonly pages: readonly WikiContentPageV1[];
}

export interface WikiContentArtifactRef extends ContextArtifactRef {
  readonly version: 1;
  readonly tenantId: string;
  readonly repository: string;
  readonly publicSnapshotDigest: string;
  readonly bundleSha256: string;
  readonly contentType: "application/json";
  readonly objectGeneration: string;
}

export interface WikiContentStorePort {
  putIfAbsent(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly bundle: WikiContentBundleV1;
  }): Promise<WikiContentArtifactRef>;
  find(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly bundleSha256: string;
    readonly publicSnapshotDigest: string;
  }): Promise<WikiContentArtifactRef | undefined>;
  get(ref: WikiContentArtifactRef): Promise<WikiContentBundleV1>;
}

export function serializeWikiContentBundle(bundle: WikiContentBundleV1): string {
  const parsed = parseWikiContentBundle(bundle);
  return `${canonicalJson(parsed)}\n`;
}

export function parseWikiContentBundle(value: unknown): WikiContentBundleV1 {
  const input = objectValue(value, "wiki content bundle");
  if (input.version !== 1) throw new Error("wiki content bundle version must be 1");
  const publicSnapshotDigest = digestValue(input.publicSnapshotDigest, "publicSnapshotDigest");
  if (!Array.isArray(input.pages) || input.pages.length === 0 || input.pages.length > 192) {
    throw new Error("wiki content bundle pages must contain between 1 and 192 items");
  }
  const pages = input.pages.map((candidate, index): WikiContentPageV1 => {
    const page = objectValue(candidate, `pages[${index}]`);
    const documentPath = safeDocumentPath(page.documentPath, `pages[${index}].documentPath`);
    const bodyMarkdown = normalizedMarkdown(page.bodyMarkdown, `pages[${index}].bodyMarkdown`);
    const bodySha256 = digestValue(page.bodySha256, `pages[${index}].bodySha256`);
    if (sha256(Buffer.from(bodyMarkdown, "utf8")) !== bodySha256) {
      throw new Error(`wiki content body digest mismatch for ${documentPath}`);
    }
    return { documentPath, bodyMarkdown, bodySha256 };
  });
  const ordered = [...pages].sort((left, right) => left.documentPath.localeCompare(right.documentPath));
  if (
    new Set(pages.map((page) => page.documentPath)).size !== pages.length ||
    pages.some((page, index) => page.documentPath !== ordered[index]?.documentPath)
  ) {
    throw new Error("wiki content pages must be uniquely ordered by documentPath");
  }
  const calculatedPublicDigest = contextPublicSnapshotDigest(
    pages.map((page) => ({ ...page, title: page.documentPath }))
  );
  if (calculatedPublicDigest !== publicSnapshotDigest) {
    throw new Error("wiki content public snapshot digest mismatch");
  }
  return { version: 1, publicSnapshotDigest, pages };
}

export function wikiContentBundleSha256(bundle: WikiContentBundleV1): string {
  return sha256(Buffer.from(serializeWikiContentBundle(bundle), "utf8"));
}

export function wikiContentArtifactKey(input: {
  readonly tenantId: string;
  readonly repository: string;
  readonly bundleSha256: string;
}): string {
  const repository = normalizeRepository(input.repository);
  const bundleSha256 = digestValue(input.bundleSha256, "bundleSha256");
  return `${contextArtifactRepositoryPrefix({ tenantId: requiredText(input.tenantId, "tenantId", 240), repository })}/wiki-content/${bundleSha256}.json`;
}

export function validateWikiContentArtifactRef(
  value: unknown,
  scope?: { readonly tenantId: string; readonly repository: string }
): WikiContentArtifactRef {
  const input = objectValue(value, "wiki content artifact");
  if (input.version !== 1) throw new Error("wiki content artifact version must be 1");
  const tenantId = requiredText(input.tenantId, "tenantId", 240);
  const repository = normalizeRepository(requiredText(input.repository, "repository", 512));
  const publicSnapshotDigest = digestValue(input.publicSnapshotDigest, "publicSnapshotDigest");
  const bundleSha256 = digestValue(input.bundleSha256, "bundleSha256");
  const key = requiredText(input.key, "key", 4_096);
  if (key !== wikiContentArtifactKey({ tenantId, repository, bundleSha256 })) {
    throw new Error("wiki content artifact key does not match its repository and digest scope");
  }
  if (input.contentType !== "application/json" || input.sha256 !== bundleSha256) {
    throw new Error("wiki content artifact content identity is invalid");
  }
  const objectGeneration = requiredText(input.objectGeneration, "objectGeneration", 240);
  if (!/^[1-9][0-9]*$/.test(objectGeneration)) throw new Error("wiki content object generation is invalid");
  const bytes = integerValue(input.bytes, "bytes", 1);
  const uri = requiredText(input.uri, "uri", 4_096);
  if (scope && (tenantId !== scope.tenantId.trim() || repository !== normalizeRepository(scope.repository))) {
    throw new Error("wiki content artifact escapes its authorized repository scope");
  }
  return {
    version: 1,
    tenantId,
    repository,
    publicSnapshotDigest,
    bundleSha256,
    uri,
    key,
    contentType: "application/json",
    bytes,
    sha256: bundleSha256,
    objectGeneration
  };
}

function normalizedMarkdown(value: unknown, label: string): string {
  const body = requiredText(value, label, 2 * 1024 * 1024).replace(/\r\n?/g, "\n");
  return body;
}

function safeDocumentPath(value: unknown, label: string): string {
  const path = requiredText(value, label, 512);
  if (
    path.startsWith("/") ||
    !path.endsWith(".md") ||
    path.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))
  ) {
    throw new Error(`${label} is not a safe public Markdown path`);
  }
  return path;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function digestValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be SHA-256`);
  return value;
}

function integerValue(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} is invalid`);
  return value as number;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
