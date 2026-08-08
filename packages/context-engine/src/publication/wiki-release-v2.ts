import { createHash } from "node:crypto";
import type { KnowledgeEvidenceCitation } from "../domain/knowledge.js";
import { validateEvidenceAnchor } from "../domain/evidence.js";
import {
  fingerprint,
  isFullCommitSha,
  normalizeIsoTime,
  normalizeRepository,
  stableId
} from "../domain/fingerprint.js";
import { isContextArtifactKeyInScope, type ContextArtifactRef } from "../ports/artifact-store.js";
import {
  parseWikiContentBundle,
  validateWikiContentArtifactRef,
  type WikiContentBundleV1,
  type WikiContentArtifactRef
} from "../ports/wiki-content-store.js";

export type WikiReleaseScopeKind = "branch" | "pull_request" | "commit";
export type WikiGenerationReason = "initial" | "source_update" | "daily_audit_fix" | "manual_refresh" | "translation";

export interface WikiFinalizationAttestationV1 {
  readonly version: 1;
  readonly sourceSnapshotDigest: string;
  readonly publicSnapshotDigest: string;
  readonly contentBundleArtifactSha256: string;
  readonly manifestDigest: string;
  readonly projectionInputDigest: string;
  readonly checks: {
    readonly minimumUsableBundle: "passed";
    readonly pathSafety: "passed";
    readonly logicalIdentity: "passed";
    readonly incrementalAccounting: "passed";
    readonly linkDiagnostics: number;
    readonly validDiagramCount: number;
    readonly degradedDiagramCount: number;
  };
  readonly generatorPolicyVersion: string;
  readonly finalizerVersion: string;
  readonly okfPolicyVersion: string;
  readonly mermaidVersion: string;
  readonly mermaidConfigDigest: string;
  readonly diagramPolicyVersion: string;
}

export interface WikiReleasePageProjectionV1 {
  readonly documentPath: string;
  readonly title: string;
  readonly bodySha256: string;
  readonly revisionId: string;
  readonly citations: readonly KnowledgeEvidenceCitation[];
  readonly metadataDigest: string;
}

export interface WikiReleaseArtifactV2 {
  readonly version: 2;
  readonly kind: "generated-wiki";
  readonly release: {
    readonly releaseId: string;
    readonly tenantId: string;
    readonly repository: string;
    readonly ref: string;
    readonly refSequence?: number;
    readonly scopeKind: WikiReleaseScopeKind;
    readonly scopeKey: string;
    readonly commitSha: string;
    readonly baseCommitSha?: string;
    readonly checkpointId: string;
    readonly generationId: string;
    readonly buildId: string;
    readonly triggerParentRunId: string;
    readonly requestDigest: string;
    readonly releaseFamilyId: string;
    readonly parentReleaseId?: string;
    readonly sourceReleaseId?: string;
    readonly sourceLocale?: string;
    readonly generationReason: WikiGenerationReason;
    readonly locale: string;
    readonly preparedAt: string;
  };
  readonly generationPlanArtifact: ContextArtifactRef;
  readonly finalizationArtifact: ContextArtifactRef;
  readonly releaseManifestArtifact: ContextArtifactRef;
  readonly contentBundleArtifact: WikiContentArtifactRef;
  readonly publicSnapshotDigest: string;
  readonly publicationInputDigest: string;
  readonly pages: readonly WikiReleasePageProjectionV1[];
}

export interface WikiTriggerExecutionFenceV1 {
  readonly boardBuildId: string;
  readonly triggerParentRunId: string;
  readonly requestDigest: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly commitSha: string;
  readonly scopeKind: WikiReleaseScopeKind;
  readonly ref: string;
  readonly refSequence?: number;
  readonly locale: string;
  readonly operationId: string;
}

export interface WikiTriggerPublicationCommitV2 {
  readonly release: WikiReleaseArtifactV2;
  readonly releaseArtifact: ContextArtifactRef;
  readonly finalization: WikiFinalizationAttestationV1;
  readonly fence: WikiTriggerExecutionFenceV1;
  readonly idempotencyKey: string;
  readonly pipelineVersion: string;
  readonly instructionDigest: string;
  readonly exclusionPolicyDigest: string;
  readonly modelProviderFamily: string;
  readonly modelId: string;
  readonly promptDigest: string;
  readonly inferenceConfigDigest: string;
}

export interface WikiTriggerPublicationRecordV2 {
  readonly releaseId: string;
  readonly generationId: string;
  readonly publicationInputDigest: string;
  readonly publicSnapshotDigest: string;
  readonly releaseArtifact: ContextArtifactRef;
  readonly preparedAt: string;
  readonly publishedAt?: string;
}

export interface WikiTriggerActivationCommitV2 {
  readonly releaseId: string;
  readonly fence: WikiTriggerExecutionFenceV1;
  readonly idempotencyKey: string;
  readonly attachmentInputDigest: string;
  readonly pageIndexArtifact: ContextArtifactRef;
  readonly pageIndexMetadata: Readonly<Record<string, unknown>>;
}

export interface WikiTriggerProjectionPreparationV2 {
  readonly release: WikiReleaseArtifactV2;
  readonly contentBundle: WikiContentBundleV1;
  readonly finalization: WikiFinalizationAttestationV1;
  readonly projectorVersion: string;
}

export interface WikiTriggerProjectionPreparationRecordV2 {
  readonly releaseId: string;
  readonly generationId: string;
  readonly status: "building" | "published";
  readonly documentCount: number;
  readonly fragmentCount: number;
  readonly exactEntryCount: number;
  readonly hierarchyNodeCount: number;
  readonly created: boolean;
}

export interface WikiTriggerPublicationStorePort {
  /** Atomically materializes the complete hidden query and hierarchy projection. */
  prepareProjection(input: WikiTriggerProjectionPreparationV2): Promise<WikiTriggerProjectionPreparationRecordV2>;
  /** Binds a complete pre-existing `building` generation to immutable V2 release metadata. */
  prepare(input: WikiTriggerPublicationCommitV2): Promise<WikiTriggerPublicationRecordV2>;
  /** Atomically publishes that generation and conditionally advances only mutable ref pointers. */
  activate(input: WikiTriggerActivationCommitV2): Promise<WikiTriggerPublicationRecordV2>;
}

export type WikiTriggerPublicationErrorCode =
  "invalid_publication" | "idempotency_conflict" | "release_not_prepared" | "stale_ref_sequence" | "publication_race";

export class WikiTriggerPublicationError extends Error {
  constructor(
    readonly code: WikiTriggerPublicationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WikiTriggerPublicationError";
  }
}

export function wikiPublicationInputDigestV2(input: Omit<WikiReleaseArtifactV2, "publicationInputDigest">): string {
  return fingerprint({
    version: 2,
    kind: input.kind,
    release: { ...input.release, preparedAt: undefined, releaseId: undefined, generationId: undefined },
    generationPlanArtifact: artifactIdentity(input.generationPlanArtifact),
    finalizationArtifact: artifactIdentity(input.finalizationArtifact),
    releaseManifestArtifact: artifactIdentity(input.releaseManifestArtifact),
    contentBundleArtifact: {
      ...artifactIdentity(input.contentBundleArtifact),
      publicSnapshotDigest: input.contentBundleArtifact.publicSnapshotDigest,
      bundleSha256: input.contentBundleArtifact.bundleSha256
    },
    publicSnapshotDigest: input.publicSnapshotDigest,
    pages: [...input.pages]
      .sort((left, right) => left.documentPath.localeCompare(right.documentPath))
      .map((page) => ({
        documentPath: page.documentPath,
        title: page.title,
        bodySha256: page.bodySha256,
        revisionId: page.revisionId,
        metadataDigest: page.metadataDigest,
        citationIds: page.citations.map((citation) => citation.id)
      }))
  });
}

export function wikiReleaseIdV2(publicationInputDigest: string): string {
  return stableId("cr", {
    version: 2,
    publicationInputDigest: digest(publicationInputDigest, "publicationInputDigest")
  });
}

export function parseWikiReleaseArtifactV2(value: unknown): WikiReleaseArtifactV2 {
  const input = object(value, "wiki release artifact");
  if (input.version !== 2 || input.kind !== "generated-wiki") {
    throw new Error("wiki release artifact discriminant is invalid");
  }
  const rawRelease = object(input.release, "release");
  const scopeKind = enumValue(rawRelease.scopeKind, ["branch", "pull_request", "commit"] as const, "scopeKind");
  const refSequence =
    rawRelease.refSequence === undefined ? undefined : integer(rawRelease.refSequence, "refSequence", 1);
  const commitSha = text(rawRelease.commitSha, "commitSha", 40).toLowerCase();
  if (!isFullCommitSha(commitSha)) throw new Error("commitSha must be a full Git SHA");
  const baseCommitSha =
    rawRelease.baseCommitSha === undefined
      ? undefined
      : text(rawRelease.baseCommitSha, "baseCommitSha", 40).toLowerCase();
  if (baseCommitSha && !isFullCommitSha(baseCommitSha)) throw new Error("baseCommitSha must be a full Git SHA");
  const release = {
    releaseId: text(rawRelease.releaseId, "releaseId", 240),
    tenantId: text(rawRelease.tenantId, "tenantId", 240),
    repository: normalizeRepository(text(rawRelease.repository, "repository", 512)),
    ref: text(rawRelease.ref, "ref", 512),
    ...(refSequence === undefined ? {} : { refSequence }),
    scopeKind,
    scopeKey: text(rawRelease.scopeKey, "scopeKey", 512),
    commitSha,
    ...(baseCommitSha ? { baseCommitSha } : {}),
    checkpointId: text(rawRelease.checkpointId, "checkpointId", 240),
    generationId: text(rawRelease.generationId, "generationId", 240),
    buildId: text(rawRelease.buildId, "buildId", 240),
    triggerParentRunId: text(rawRelease.triggerParentRunId, "triggerParentRunId", 240),
    requestDigest: digest(rawRelease.requestDigest, "requestDigest"),
    releaseFamilyId: text(rawRelease.releaseFamilyId, "releaseFamilyId", 240),
    ...(rawRelease.parentReleaseId === undefined
      ? {}
      : { parentReleaseId: text(rawRelease.parentReleaseId, "parentReleaseId", 240) }),
    ...(rawRelease.sourceReleaseId === undefined
      ? {}
      : { sourceReleaseId: text(rawRelease.sourceReleaseId, "sourceReleaseId", 240) }),
    ...(rawRelease.sourceLocale === undefined ? {} : { sourceLocale: locale(rawRelease.sourceLocale, "sourceLocale") }),
    generationReason: enumValue(
      rawRelease.generationReason,
      ["initial", "source_update", "daily_audit_fix", "manual_refresh", "translation"] as const,
      "generationReason"
    ),
    locale: locale(rawRelease.locale, "locale"),
    preparedAt: normalizeIsoTime(text(rawRelease.preparedAt, "preparedAt", 64))
  };
  assertScopeSemantics(release);
  if (release.releaseId !== release.generationId)
    throw new Error("V2 releaseId and generationId must match during compatibility");
  if ((release.generationReason === "translation") !== Boolean(release.sourceReleaseId && release.sourceLocale)) {
    throw new Error("translation lineage is incomplete or forbidden");
  }
  const generationPlanArtifact = buildArtifact(input.generationPlanArtifact, release, "generationPlanArtifact");
  const finalizationArtifact = buildArtifact(input.finalizationArtifact, release, "finalizationArtifact");
  const releaseManifestArtifact = buildArtifact(input.releaseManifestArtifact, release, "releaseManifestArtifact");
  const contentBundleArtifact = validateWikiContentArtifactRef(input.contentBundleArtifact, release);
  const releaseArtifact: Omit<WikiReleaseArtifactV2, "publicationInputDigest"> = {
    version: 2,
    kind: "generated-wiki",
    release,
    generationPlanArtifact,
    finalizationArtifact,
    releaseManifestArtifact,
    contentBundleArtifact,
    publicSnapshotDigest: digest(input.publicSnapshotDigest, "publicSnapshotDigest"),
    pages: pagesValue(input.pages, release)
  };
  if (
    releaseArtifact.publicSnapshotDigest !== contentBundleArtifact.publicSnapshotDigest ||
    contentBundleArtifact.sha256 !== contentBundleArtifact.bundleSha256
  ) {
    throw new Error("wiki release content bundle identity mismatch");
  }
  const publicationInputDigest = digest(input.publicationInputDigest, "publicationInputDigest");
  if (
    wikiPublicationInputDigestV2(releaseArtifact) !== publicationInputDigest ||
    wikiReleaseIdV2(publicationInputDigest) !== release.releaseId
  ) {
    throw new Error("wiki release publication identity mismatch");
  }
  return { ...releaseArtifact, publicationInputDigest };
}

export function validateWikiProjectionPreparationV2(input: WikiTriggerProjectionPreparationV2): {
  readonly release: WikiReleaseArtifactV2;
  readonly bundle: WikiContentBundleV1;
  readonly finalization: WikiFinalizationAttestationV1;
  readonly projectorVersion: string;
} {
  const release = parseWikiReleaseArtifactV2(input.release);
  const bundle = parseWikiContentBundle(input.contentBundle);
  const finalization = parseWikiFinalizationAttestationV1(input.finalization);
  const projectorVersion = text(input.projectorVersion, "projectorVersion", 240);
  if (
    bundle.publicSnapshotDigest !== release.publicSnapshotDigest ||
    finalization.publicSnapshotDigest !== release.publicSnapshotDigest ||
    finalization.contentBundleArtifactSha256 !== release.contentBundleArtifact.bundleSha256
  ) {
    throw new Error("wiki projection inputs do not bind the same public content");
  }
  const bundleByPath = new Map(bundle.pages.map((page) => [page.documentPath, page]));
  if (
    release.pages.length !== bundle.pages.length ||
    release.pages.some((page) => bundleByPath.get(page.documentPath)?.bodySha256 !== page.bodySha256)
  ) {
    throw new Error("wiki projection release pages do not exactly match the content bundle");
  }
  return { release, bundle, finalization, projectorVersion };
}

export function parseWikiFinalizationAttestationV1(value: unknown): WikiFinalizationAttestationV1 {
  const input = object(value, "wiki finalization attestation");
  if (input.version !== 1) throw new Error("wiki finalization attestation version must be 1");
  const checks = object(input.checks, "checks");
  for (const key of ["minimumUsableBundle", "pathSafety", "logicalIdentity", "incrementalAccounting"] as const) {
    if (checks[key] !== "passed") throw new Error(`${key} must have passed`);
  }
  return {
    version: 1,
    sourceSnapshotDigest: digest(input.sourceSnapshotDigest, "sourceSnapshotDigest"),
    publicSnapshotDigest: digest(input.publicSnapshotDigest, "publicSnapshotDigest"),
    contentBundleArtifactSha256: digest(input.contentBundleArtifactSha256, "contentBundleArtifactSha256"),
    manifestDigest: digest(input.manifestDigest, "manifestDigest"),
    projectionInputDigest: digest(input.projectionInputDigest, "projectionInputDigest"),
    checks: {
      minimumUsableBundle: "passed",
      pathSafety: "passed",
      logicalIdentity: "passed",
      incrementalAccounting: "passed",
      linkDiagnostics: integer(checks.linkDiagnostics, "linkDiagnostics", 0),
      validDiagramCount: integer(checks.validDiagramCount, "validDiagramCount", 0),
      degradedDiagramCount: integer(checks.degradedDiagramCount, "degradedDiagramCount", 0)
    },
    generatorPolicyVersion: text(input.generatorPolicyVersion, "generatorPolicyVersion", 240),
    finalizerVersion: text(input.finalizerVersion, "finalizerVersion", 240),
    okfPolicyVersion: text(input.okfPolicyVersion, "okfPolicyVersion", 240),
    mermaidVersion: text(input.mermaidVersion, "mermaidVersion", 240),
    mermaidConfigDigest: digest(input.mermaidConfigDigest, "mermaidConfigDigest"),
    diagramPolicyVersion: text(input.diagramPolicyVersion, "diagramPolicyVersion", 240)
  };
}

function pagesValue(
  value: unknown,
  release: { readonly tenantId: string; readonly repository: string; readonly commitSha: string }
): WikiReleasePageProjectionV1[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 192)
    throw new Error("wiki release pages are invalid");
  const pages = value.map((candidate, index): WikiReleasePageProjectionV1 => {
    const page = object(candidate, `pages[${index}]`);
    const documentPath = text(page.documentPath, "documentPath", 512);
    if (documentPath.startsWith("/") || !documentPath.endsWith(".md") || documentPath.includes("..")) {
      throw new Error("wiki release documentPath is unsafe");
    }
    if (!Array.isArray(page.citations)) throw new Error("wiki release citations must be an array");
    const revisionId = text(page.revisionId, "revisionId", 240);
    const citations = page.citations.map((candidateCitation, citationIndex): KnowledgeEvidenceCitation => {
      const citation = object(candidateCitation, `citations[${citationIndex}]`);
      const anchor = validateEvidenceAnchor(
        object(citation.anchor, "citation.anchor") as unknown as KnowledgeEvidenceCitation["anchor"]
      );
      if (
        anchor.tenantId !== release.tenantId ||
        anchor.repository !== release.repository ||
        (anchor.commitSha !== undefined && anchor.commitSha !== release.commitSha)
      ) {
        throw new Error("wiki release citation escapes its source scope");
      }
      if ((citation.citationId === undefined) !== (citation.claimSpan === undefined)) {
        throw new Error("wiki release public citation association is incomplete");
      }
      const parsed = {
        id: text(citation.id, "citation.id", 240),
        revisionId: text(citation.revisionId, "citation.revisionId", 240),
        ordinal: integer(citation.ordinal, "citation.ordinal", 0),
        claim: text(citation.claim, "citation.claim", 8_192),
        ...(citation.citationId === undefined
          ? {}
          : {
              citationId: text(citation.citationId, "citation.citationId", 64),
              claimSpan: text(citation.claimSpan, "citation.claimSpan", 8_192)
            }),
        anchor
      } satisfies KnowledgeEvidenceCitation;
      if (parsed.citationId && !/^cite_[0-9a-f]{20}$/.test(parsed.citationId)) {
        throw new Error("wiki release public citation identity is invalid");
      }
      if (parsed.revisionId !== revisionId || parsed.ordinal !== citationIndex) {
        throw new Error("wiki release citation ordering or revision binding is invalid");
      }
      return parsed;
    });
    return {
      documentPath,
      title: text(page.title, "title", 240),
      bodySha256: digest(page.bodySha256, "bodySha256"),
      revisionId,
      citations,
      metadataDigest: digest(page.metadataDigest, "metadataDigest")
    };
  });
  const ordered = [...pages].sort((left, right) => left.documentPath.localeCompare(right.documentPath));
  if (
    new Set(pages.map((page) => page.documentPath)).size !== pages.length ||
    pages.some((page, i) => page.documentPath !== ordered[i]?.documentPath)
  ) {
    throw new Error("wiki release pages must be uniquely ordered");
  }
  return pages;
}

function buildArtifact(
  value: unknown,
  release: { tenantId: string; repository: string; buildId: string },
  label: string
): ContextArtifactRef {
  const input = object(value, label);
  const ref = {
    uri: text(input.uri, `${label}.uri`, 4_096),
    key: text(input.key, `${label}.key`, 4_096),
    contentType: text(input.contentType, `${label}.contentType`, 240),
    bytes: integer(input.bytes, `${label}.bytes`, 1),
    sha256: digest(input.sha256, `${label}.sha256`),
    ...(input.objectGeneration === undefined
      ? {}
      : { objectGeneration: text(input.objectGeneration, `${label}.objectGeneration`, 240) })
  };
  if (!isContextArtifactKeyInScope(ref.key, release)) throw new Error(`${label} escapes its build scope`);
  return ref;
}

function assertScopeSemantics(release: {
  scopeKind: WikiReleaseScopeKind;
  ref: string;
  scopeKey: string;
  refSequence?: number;
  commitSha: string;
}): void {
  if (release.scopeKind === "commit") {
    if (
      release.refSequence !== undefined ||
      release.scopeKey !== release.commitSha ||
      release.ref !== `refs/commits/${release.commitSha}`
    ) {
      throw new Error("direct commit release scope is invalid");
    }
    return;
  }
  if (release.refSequence === undefined) throw new Error("mutable release scope requires refSequence");
  if (release.scopeKind === "branch" && !release.ref.startsWith("refs/heads/"))
    throw new Error("branch ref is not canonical");
  if (release.scopeKind === "pull_request" && !/^refs\/pull\/[1-9][0-9]*\/head$/.test(release.ref)) {
    throw new Error("pull request ref is not canonical");
  }
}

function artifactIdentity(ref: ContextArtifactRef): Record<string, unknown> {
  return {
    key: ref.key,
    sha256: ref.sha256,
    bytes: ref.bytes,
    contentType: ref.contentType,
    ...(ref.objectGeneration ? { objectGeneration: ref.objectGeneration } : {})
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0"))
    throw new Error(`${label} is invalid`);
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be SHA-256`);
  return value;
}

function integer(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} is invalid`);
  return value as number;
}

function locale(value: unknown, label: string): string {
  const tag = text(value, label, 64);
  if (!/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(tag)) throw new Error(`${label} is not a BCP-47 language tag`);
  return tag.toLowerCase();
}

function enumValue<const T extends readonly string[]>(value: unknown, choices: T, label: string): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) throw new Error(`${label} is invalid`);
  return value;
}

export function wikiBodySha256(bodyMarkdown: string): string {
  return createHash("sha256").update(bodyMarkdown.replace(/\r\n?/g, "\n"), "utf8").digest("hex");
}

/**
 * Produces the text projected into search indexes while leaving the immutable
 * content bundle untouched for wiki rendering and source inspection. Mermaid
 * programs are implementation detail, not prose: indexing them pollutes exact
 * and lexical recall with node IDs, arrows, and renderer directives.
 */
export function wikiSearchableMarkdown(bodyMarkdown: string): string {
  const searchable: string[] = [];
  let mermaidFence: { readonly marker: "`" | "~"; readonly minimumLength: number } | undefined;
  for (const line of bodyMarkdown.replace(/\r\n?/g, "\n").split("\n")) {
    const opening = /^\s*(`{3,}|~{3,})(?:mermaid|mermaid-source)\s*$/i.exec(line);
    if (!mermaidFence && opening) {
      searchable.push("> Mermaid diagram (source omitted from the search index).");
      const marker = opening[1]!;
      mermaidFence = { marker: marker.startsWith("`") ? "`" : "~", minimumLength: marker.length };
      continue;
    }
    if (mermaidFence) {
      const closing = /^\s*(`+|~+)\s*$/.exec(line)?.[1];
      if (closing?.startsWith(mermaidFence.marker) && closing.length >= mermaidFence.minimumLength) {
        mermaidFence = undefined;
      }
      continue;
    }
    searchable.push(line);
  }
  return searchable.join("\n").replace(/\n{3,}/g, "\n\n");
}
