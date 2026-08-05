import { createHash } from "node:crypto";
import {
  BoardContextPublicationError,
  IngestEvidenceService,
  KnowledgeOutputValidator,
  MemoryContextEngineStore,
  artifactSha256,
  assertContextPriorReleaseMatches,
  boardContextPublicationInputDigest,
  boardContextReleaseId,
  canonicalContextPublicPages,
  contextPublicSnapshotDigest,
  documentPathForLogicalId,
  documentPathFromFile,
  evidenceExcerpt,
  fingerprint,
  isFullCommitSha,
  isContextArtifactKeyInScope,
  contextWorkflowPageDispositionReasonCodes,
  markdownCatalogToOutput,
  normalizeIsoTime,
  normalizeRepository,
  parseCertifiedContextReleaseArtifact,
  parseContextPriorReleaseSeed,
  parseMarkdownDocument,
  resolveDocumentLink,
  serializeCertifiedContextReleaseArtifact,
  stableId,
  validatePublishedContextIncrement,
  verifyMarkdownCatalog,
  type BoardContextPublicationCommit,
  type BoardContextPublicationRecord,
  type BoardContextPublicationScope,
  type BoardContextPublicationTransactionPort,
  type BoardPublicationLeaseFence,
  type CertifiedContextReleaseArtifactV1,
  type CertifiedContextReleasePage,
  type ContextArtifactRef,
  type ContextArtifactStore,
  type ContextPriorReleaseSeed,
  type DerivationRun,
  type EvidenceRecord,
  type EvidenceSnapshot,
  type IngestEvidenceInput,
  type KnowledgeCommit
} from "@jina/context-engine";

const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 96;

export interface PublishCertifiedContextRequest {
  readonly scope: BoardContextPublicationScope;
  readonly lease: BoardPublicationLeaseFence;
  readonly certificationArtifact: ContextArtifactRef;
  /** Stable for every retry of one board publication task. */
  readonly idempotencyKey: string;
  /** The publication task's stable board timestamp, not the retry wall clock. */
  readonly publishedAt: string;
}

export interface PublishCertifiedContextResult {
  readonly releaseId: string;
  readonly releaseArtifact: ContextArtifactRef;
  readonly publicSnapshotDigest: string;
  readonly publicationInputDigest: string;
  readonly refSequence: number;
  readonly commitSha: string;
  readonly publishedAt: string;
}

export interface ContextPublicationArtifactQuota {
  reserveArtifactStorage(input: {
    readonly tenantId: string;
    readonly reservationId: string;
    readonly artifactId: string;
    readonly bytes: number;
  }): Promise<unknown>;
  commitArtifactStorage(input: {
    readonly tenantId: string;
    readonly reservationId: string;
    readonly artifactId: string;
    readonly bytes: number;
  }): Promise<unknown>;
}

interface CertificationArtifact {
  readonly publicSnapshotDigest: string;
  readonly publicationPlanArtifact: ContextArtifactRef;
  readonly pageArtifacts: readonly ContextArtifactRef[];
  readonly omittedPages: readonly { readonly path: string; readonly reasonCode: string }[];
}

interface PageArtifact {
  readonly documentPath: string;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly publicationPlanArtifact: ContextArtifactRef;
  readonly snapshotArtifact: ContextArtifactRef;
}

/**
 * Authoritative API-side publication service.
 *
 * Artifact reads and all Markdown/evidence validation happen before the
 * transaction. The injected port owns the one indivisible database operation;
 * there is intentionally no adapter that chains the existing non-transactional
 * ContextEngineStore writes.
 */
export class ContextBoardPublicationService {
  constructor(
    private readonly artifacts: ContextArtifactStore,
    private readonly transaction: BoardContextPublicationTransactionPort,
    private readonly artifactQuota?: ContextPublicationArtifactQuota
  ) {}

  async publish(request: PublishCertifiedContextRequest): Promise<PublishCertifiedContextResult> {
    const scope = validateScope(request.scope);
    const lease = validateLease(request.lease, scope.buildId);
    const publishedAt = normalizeIsoTime(request.publishedAt);
    if (!request.idempotencyKey.trim() || request.idempotencyKey.length > 512) {
      throw publicationError("invalid_publication", "publication idempotency key is invalid");
    }
    assertScopedArtifact(scope, request.certificationArtifact, "certification");
    const certification = parseCertificationArtifact(await this.readVerified(request.certificationArtifact), scope);
    if (certification.pageArtifacts.length === 0 || certification.pageArtifacts.length > MAX_PAGES) {
      throw publicationError("invalid_publication", "certification has an invalid page artifact count");
    }
    if (
      request.certificationArtifact.key.includes("/certification/") === false ||
      certification.publicationPlanArtifact.key.includes("/publication-plan/") === false
    ) {
      throw publicationError("invalid_publication", "certification references artifacts of the wrong kind");
    }
    assertScopedArtifact(scope, certification.publicationPlanArtifact, "publication plan");
    const publicationPlan = await this.readJsonObject(certification.publicationPlanArtifact, "publication plan");

    const pageArtifacts = uniqueArtifacts(certification.pageArtifacts);
    const loaded = await Promise.all(
      pageArtifacts.map(async (artifact) => {
        assertScopedArtifact(scope, artifact, "certified page");
        const value = await this.readJsonObject(artifact, "certified page");
        return parsePageContainer(value, scope, certification.publicationPlanArtifact, artifact);
      })
    );
    const pages = canonicalContextPublicPages(loaded.flat());
    if (pages.length === 0 || pages.length > MAX_PAGES) {
      throw publicationError("invalid_publication", "certification resolves to an invalid page count");
    }
    if (new Set(pages.map((page) => page.documentPath)).size !== pages.length) {
      throw publicationError("invalid_publication", "certified context contains duplicate document paths");
    }
    const priorRelease = await this.validateIncrementalPublication(
      scope,
      publicationPlan,
      pages,
      certification.omittedPages
    );

    const snapshotRefs = uniqueArtifacts(pages.map((page) => page.snapshotArtifact));
    if (snapshotRefs.length !== 1) {
      throw publicationError("certification_mismatch", "certified pages do not share one immutable snapshot");
    }
    const rawSnapshot = parseSnapshotInput(await this.readVerified(snapshotRefs[0]!), scope);
    const prepared = await prepareValidatedPublication(scope, rawSnapshot, pages, publishedAt);
    const publicSnapshotDigest = contextPublicSnapshotDigest(prepared.publicPages);
    if (publicSnapshotDigest !== certification.publicSnapshotDigest) {
      throw publicationError(
        "certification_mismatch",
        "certification digest does not match the exact public Markdown snapshot"
      );
    }

    const releasePages = releasePagesFor(prepared.publicPages, prepared.commit);
    const publicationInputDigest = boardContextPublicationInputDigest({
      scope,
      certificationArtifact: request.certificationArtifact,
      publicationPlanArtifact: certification.publicationPlanArtifact,
      checkpointId: prepared.snapshot.checkpoint.id,
      publicSnapshotDigest,
      pages: releasePages.map((page) => ({
        documentPath: page.documentPath,
        bodySha256: page.bodySha256,
        revisionId: page.revisionId,
        citationIds: page.citations.map((citation) => citation.id)
      }))
    });
    const releaseId = boardContextReleaseId(publicationInputDigest);
    const releaseBundle: CertifiedContextReleaseArtifactV1 = {
      version: 1,
      release: {
        releaseId,
        tenantId: scope.tenantId,
        repository: scope.repository,
        ref: scope.ref,
        refSequence: scope.refSequence,
        commitSha: scope.commitSha,
        checkpointId: prepared.snapshot.checkpoint.id,
        buildId: scope.buildId,
        publishedAt
      },
      certificationArtifact: request.certificationArtifact,
      publicationPlanArtifact: certification.publicationPlanArtifact,
      publicSnapshotDigest,
      publicationInputDigest,
      pages: releasePages
    };
    // Use the same strict boundary as PageIndex before bytes become immutable.
    parseCertifiedContextReleaseArtifact(releaseBundle);
    const releaseContent = serializeCertifiedContextReleaseArtifact(releaseBundle);
    const releaseBytes = Buffer.byteLength(releaseContent, "utf8");
    const releaseSha256 = artifactSha256(Buffer.from(releaseContent, "utf8"));
    const quotaArtifactId = `${scope.buildId}:context-release:${releaseId}`;
    const quotaReservationId = `${quotaArtifactId}:${releaseSha256}`;
    await this.artifactQuota?.reserveArtifactStorage({
      tenantId: scope.tenantId,
      reservationId: quotaReservationId,
      artifactId: quotaArtifactId,
      bytes: releaseBytes
    });
    const releaseArtifact = await this.artifacts.put({
      tenantId: scope.tenantId,
      repository: scope.repository,
      buildId: scope.buildId,
      kind: "context-release",
      name: `${releaseId}.json`,
      contentType: "application/json",
      content: releaseContent
    });
    if (releaseArtifact.sha256 !== releaseSha256 || releaseArtifact.bytes !== releaseBytes) {
      throw publicationError("publication_race", "release artifact store returned a mismatched immutable reference");
    }
    assertScopedArtifact(scope, releaseArtifact, "release");

    const commit: BoardContextPublicationCommit = {
      scope,
      lease,
      idempotencyKey: request.idempotencyKey,
      publicationInputDigest,
      publicSnapshotDigest,
      releaseId,
      releaseArtifact,
      certificationArtifact: request.certificationArtifact,
      publicationPlanArtifact: certification.publicationPlanArtifact,
      snapshot: prepared.snapshot,
      run: prepared.commit.run,
      revisions: prepared.commit.revisions,
      citations: prepared.commit.citations,
      pages: releasePages,
      ...(priorRelease ? { priorRelease } : {}),
      publishedAt
    };
    const record = await this.transaction.publishAtomically(commit);
    assertPublicationRecord(record, commit);
    await this.artifactQuota?.commitArtifactStorage({
      tenantId: scope.tenantId,
      reservationId: quotaReservationId,
      artifactId: quotaArtifactId,
      bytes: releaseBytes
    });
    return {
      releaseId: record.releaseId,
      releaseArtifact: record.releaseArtifact,
      publicSnapshotDigest: record.publicSnapshotDigest,
      publicationInputDigest: record.publicationInputDigest,
      refSequence: record.refSequence,
      commitSha: record.commitSha,
      publishedAt: record.publishedAt
    };
  }

  private async readJsonObject(ref: ContextArtifactRef, label: string): Promise<Record<string, unknown>> {
    const content = await this.readVerified(ref);
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(content).toString("utf8")) as unknown;
    } catch {
      throw publicationError("invalid_publication", `${label} artifact is not valid JSON`);
    }
    return record(value, `${label} artifact`);
  }

  private async validateIncrementalPublication(
    scope: BoardContextPublicationScope,
    publicationArtifact: Record<string, unknown>,
    pages: readonly PageArtifact[],
    omittedPages: CertificationArtifact["omittedPages"]
  ): Promise<ContextPriorReleaseSeed | undefined> {
    const plan = record(publicationArtifact.plan, "publication plan");
    if (!Array.isArray(plan.pages)) {
      throw publicationError("invalid_publication", "publication plan pages are invalid");
    }
    const plannedPages = plan.pages.map((value, index) => {
      const page = record(value, `publication plan pages[${index}]`);
      return {
        path: pagePath(page.path, `publication plan pages[${index}].path`),
        ...(page.change === undefined
          ? {}
          : {
              change: string(page.change, `publication plan pages[${index}].change`, 16) as "add" | "retain" | "revise"
            })
      };
    });
    const retiredPages = Array.isArray(plan.retiredPages)
      ? plan.retiredPages.map((value, index) => {
          const retired = record(value, `publication plan retiredPages[${index}]`);
          return {
            path: pagePath(retired.path, `publication plan retiredPages[${index}].path`),
            reason: string(retired.reason, `publication plan retiredPages[${index}].reason`, 2_000)
          };
        })
      : [];
    if (publicationArtifact.priorRelease === undefined) {
      try {
        validatePublishedContextIncrement({ plannedPages, retiredPages, omittedPages, publishedPages: pages });
      } catch (error) {
        throw publicationError("invalid_publication", boundedError(error));
      }
      return undefined;
    }

    const seed = parseContextPriorReleaseSeed(publicationArtifact.priorRelease);
    if (
      seed.tenantId !== scope.tenantId ||
      seed.repository !== scope.repository ||
      seed.ref !== scope.ref ||
      seed.refSequence >= scope.refSequence
    ) {
      throw publicationError("certification_mismatch", "prior release seed escapes the publication scope");
    }
    const raw = await this.readVerified(seed.releaseArtifact);
    let releaseValue: unknown;
    try {
      releaseValue = JSON.parse(Buffer.from(raw).toString("utf8")) as unknown;
    } catch {
      throw publicationError("invalid_publication", "prior release artifact is not valid JSON");
    }
    const release = parseCertifiedContextReleaseArtifact(releaseValue);
    assertContextPriorReleaseMatches(seed, release);
    try {
      validatePublishedContextIncrement({
        priorRelease: release,
        plannedPages,
        retiredPages,
        omittedPages,
        publishedPages: pages
      });
    } catch (error) {
      throw publicationError("invalid_publication", boundedError(error));
    }
    return seed;
  }

  private async readVerified(ref: ContextArtifactRef): Promise<Uint8Array> {
    validateArtifactRef(ref);
    const content = await this.artifacts.get(ref);
    if (content.byteLength !== ref.bytes || artifactSha256(content) !== ref.sha256) {
      throw publicationError("invalid_publication", `artifact bytes do not match immutable reference ${ref.key}`);
    }
    return content;
  }
}

async function prepareValidatedPublication(
  scope: BoardContextPublicationScope,
  input: IngestEvidenceInput,
  pages: readonly PageArtifact[],
  publishedAt: string
): Promise<{
  readonly snapshot: EvidenceSnapshot;
  readonly publicPages: readonly PageArtifact[];
  readonly commit: KnowledgeCommit;
}> {
  const validationStore = new MemoryContextEngineStore();
  try {
    const checkpoint = await new IngestEvidenceService(validationStore).ingest(input);
    const [records, manifest, structuralFacts] = await Promise.all([
      validationStore.listEvidence(checkpoint.id),
      validationStore.listManifest(checkpoint.id),
      validationStore.listStructuralFacts(checkpoint.id)
    ]);
    const snapshot: EvidenceSnapshot = {
      checkpoint,
      records,
      manifest,
      structuralFacts,
      ...(input.git ? { git: input.git } : {})
    };
    const parsed = pages.map((page) =>
      parseMarkdownDocument(documentPathFromFile(page.documentPath), page.bodyMarkdown)
    );
    validateReferencesAndNavigation(parsed, records);
    const evidenceByPath = new Map(
      records
        .filter((candidate) => candidate.anchor.sourceType === "blob" && candidate.anchor.pathOrUrl !== undefined)
        .map((candidate) => [candidate.anchor.pathOrUrl!, candidate])
    );
    const conversion = markdownCatalogToOutput(
      parsed,
      scope.repository,
      manifest,
      (link) => exactSourceAnchor(link.path, link.startLine, link.endLine, evidenceByPath),
      records
        .filter((candidate) => candidate.anchor.sourceType !== "blob")
        .map((candidate) => ({ body: candidate.body, anchor: candidate.anchor })),
      [],
      undefined,
      { naturalEvidenceLabels: true }
    );
    if (conversion.problems.length > 0 || conversion.output.documents.length !== pages.length) {
      const diagnostic = conversion.problems
        .slice(0, 8)
        .map((problem) => `${problem.documentPath}: ${problem.reason}`)
        .join("; ");
      throw publicationError(
        "invalid_publication",
        `certified Markdown did not fully convert to grounded context${diagnostic ? `: ${diagnostic}` : ""}`
      );
    }
    let validated;
    try {
      validated = await new KnowledgeOutputValidator(validationStore).validate({
        output: conversion.output,
        checkpointId: checkpoint.id,
        generatorName: "context-board",
        generatorVersion: "board-publication-v1",
        model: "certified-agent-output",
        promptVersion: "context-board-publication-v1",
        createdAt: publishedAt,
        inlineCitations: true
      });
    } catch (error) {
      throw publicationError(
        "invalid_publication",
        `certified Markdown failed final knowledge validation: ${boundedError(error)}`
      );
    }
    if (validated.revisions.length !== pages.length) {
      throw publicationError("invalid_publication", "final validation withheld part of the certified page set");
    }
    const cacheKey = fingerprint({
      version: 1,
      checkpointId: checkpoint.id,
      publicSnapshotDigest: contextPublicSnapshotDigest(pages)
    });
    const run: DerivationRun = {
      id: stableId("dr", { cacheKey, revisionIds: validated.revisions.map((revision) => revision.id) }),
      tenantId: scope.tenantId,
      repository: scope.repository,
      checkpointId: checkpoint.id,
      cacheKey,
      focusFingerprint: checkpoint.evidenceFingerprint,
      generatorName: "context-board",
      generatorVersion: "board-publication-v1",
      model: "certified-agent-output",
      promptVersion: "context-board-publication-v1",
      schemaVersion: "knowledge-output-v1",
      rawOutputs: [],
      status: "succeeded",
      diagnostics: [],
      revisionIds: validated.revisions.map((revision) => revision.id),
      createdAt: publishedAt
    };
    return {
      snapshot,
      publicPages: pages,
      commit: { run, revisions: validated.revisions, citations: validated.citations }
    };
  } finally {
    await validationStore.close();
  }
}

function validateReferencesAndNavigation(
  documents: readonly ReturnType<typeof parseMarkdownDocument>[],
  records: readonly EvidenceRecord[]
): void {
  const documentPaths = new Set(documents.map((document) => document.documentPath));
  if (!documentPaths.has("architecture")) {
    throw publicationError("invalid_publication", "certified context has no architecture.md root");
  }
  const evidenceByPath = new Map(
    records
      .filter((candidate) => candidate.anchor.sourceType === "blob" && candidate.anchor.pathOrUrl !== undefined)
      .map((candidate) => [candidate.anchor.pathOrUrl!, candidate])
  );
  const sourceOnly = documents.map((document) => ({
    ...document,
    evidenceLinks: document.evidenceLinks.filter((link) => link.providerUrl === undefined)
  }));
  const verification = verifyMarkdownCatalog(sourceOnly, {
    evidenceByPath,
    documentPaths,
    resolveDocumentLink
  });
  if (verification.problems.length > 0) {
    throw publicationError(
      "invalid_publication",
      `certified Markdown has unresolved references: ${verification.problems
        .slice(0, 8)
        .map((problem) => `${problem.documentPath} -> ${problem.target} (${problem.reason})`)
        .join("; ")}`
    );
  }
  const byPath = new Map(documents.map((document) => [document.documentPath, document]));
  const reachable = new Set<string>(["architecture"]);
  const queue = ["architecture"];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const link of byPath.get(current)?.documentLinks ?? []) {
      const target = resolveDocumentLink(current, link.target);
      if (!target || reachable.has(target)) continue;
      reachable.add(target);
      queue.push(target);
    }
  }
  const unreachable = [...documentPaths].filter((path) => !reachable.has(path)).sort();
  if (unreachable.length > 0) {
    throw publicationError(
      "invalid_publication",
      `certified context pages are unreachable from architecture.md: ${unreachable.slice(0, 8).join(", ")}`
    );
  }
}

function exactSourceAnchor(
  path: string | undefined,
  startLine: number | undefined,
  endLine: number | undefined,
  evidenceByPath: ReadonlyMap<string, EvidenceRecord>
): string | false {
  if (!path || startLine === undefined || endLine === undefined || endLine - startLine + 1 > 120) return false;
  const source = evidenceByPath.get(path);
  if (!source) return false;
  const excerpt = evidenceExcerpt(source, { startLine, endLine });
  if (!excerpt) return false;
  const anchor = excerpt.replace(/\s+/g, " ").trim().slice(0, 240);
  return anchor.length >= 8 ? anchor : false;
}

function releasePagesFor(pages: readonly PageArtifact[], commit: KnowledgeCommit): CertifiedContextReleasePage[] {
  const revisionByPath = new Map<string, KnowledgeCommit["revisions"][number]>(
    commit.revisions.flatMap((revision) => {
      const path = documentPathForLogicalId(revision.logicalId, revision.kind, revision.repository);
      return path ? [[`${path}.md`, revision] as const] : [];
    })
  );
  return canonicalContextPublicPages(pages).map((page) => {
    const revision = revisionByPath.get(page.documentPath);
    if (!revision || revision.bodyMarkdown !== page.bodyMarkdown) {
      throw publicationError("invalid_publication", `validated revision is missing for ${page.documentPath}`);
    }
    return {
      documentPath: page.documentPath,
      title: revision.title,
      bodyMarkdown: revision.bodyMarkdown,
      bodySha256: createHash("sha256").update(revision.bodyMarkdown).digest("hex"),
      revisionId: revision.id,
      citations: commit.citations
        .filter((citation) => citation.revisionId === revision.id)
        .sort((left, right) => left.ordinal - right.ordinal)
    };
  });
}

function parseCertificationArtifact(content: Uint8Array, scope: BoardContextPublicationScope): CertificationArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(content).toString("utf8")) as unknown;
  } catch {
    throw publicationError("invalid_publication", "certification artifact is not valid JSON");
  }
  const value = record(parsed, "certification artifact");
  if (value.version !== 1 || value.verdict !== "certified") {
    throw publicationError("certification_mismatch", "publication requires a certified version 1 artifact");
  }
  const publicationPlanArtifact = parseArtifactRef(value.publicationPlanArtifact, "publicationPlanArtifact");
  assertScopedArtifact(scope, publicationPlanArtifact, "publication plan");
  if (!Array.isArray(value.pageArtifacts)) {
    throw publicationError("invalid_publication", "certification pageArtifacts must be an array");
  }
  const rawOmittedPages = value.omittedPages ?? [];
  if (!Array.isArray(rawOmittedPages) || rawOmittedPages.length > MAX_PAGES) {
    throw publicationError("invalid_publication", "certification omittedPages must be a bounded array");
  }
  return {
    publicSnapshotDigest: digest(value.publicSnapshotDigest, "certification publicSnapshotDigest"),
    publicationPlanArtifact,
    pageArtifacts: value.pageArtifacts.map((item, index) =>
      parseArtifactRef(item, `certification pageArtifacts[${index}]`)
    ),
    omittedPages: rawOmittedPages.map((item, index) => {
      const omitted = record(item, `certification omittedPages[${index}]`);
      const reasonCode = string(omitted.reasonCode, `certification omittedPages[${index}].reasonCode`, 80);
      if (!contextWorkflowPageDispositionReasonCodes.some((candidate) => candidate === reasonCode)) {
        throw publicationError("invalid_publication", `certification omittedPages[${index}].reasonCode is invalid`);
      }
      return {
        path: pagePath(omitted.path, `certification omittedPages[${index}].path`),
        reasonCode
      };
    })
  };
}

function parsePageContainer(
  value: Record<string, unknown>,
  scope: BoardContextPublicationScope,
  plan: ContextArtifactRef,
  artifact: ContextArtifactRef
): PageArtifact[] {
  if (value.version !== 1) throw publicationError("invalid_publication", "certified page artifact version must be 1");
  const rawPages = Array.isArray(value.pages) ? value.pages : [value];
  if (rawPages.length === 0 || rawPages.length > MAX_PAGES) {
    throw publicationError("invalid_publication", "certified page container has an invalid page count");
  }
  if (Array.isArray(value.pages) && !artifact.key.includes("/context-draft/")) {
    throw publicationError("invalid_publication", "bundled pages must come from a context-draft artifact");
  }
  if (!Array.isArray(value.pages) && !artifact.key.includes("/context-page/")) {
    throw publicationError("invalid_publication", "single page must come from a context-page artifact");
  }
  return rawPages.map((item, index) => {
    const page = record(item, `certified page[${index}]`);
    const documentPath = pagePath(page.documentPath, `certified page[${index}].documentPath`);
    const title = string(page.title, `certified page[${index}].title`, 240);
    const bodyMarkdown = string(page.bodyMarkdown, `certified page[${index}].bodyMarkdown`, MAX_PAGE_BYTES);
    if (Buffer.byteLength(bodyMarkdown, "utf8") > MAX_PAGE_BYTES) {
      throw publicationError("invalid_publication", `${documentPath} exceeds the maximum page size`);
    }
    const publicationPlanArtifact = parseArtifactRef(
      page.publicationPlanArtifact,
      `certified page[${index}].publicationPlanArtifact`
    );
    const snapshotArtifact = parseArtifactRef(page.snapshotArtifact, `certified page[${index}].snapshotArtifact`);
    assertScopedArtifact(scope, publicationPlanArtifact, "page publication plan");
    assertScopedArtifact(scope, snapshotArtifact, "page snapshot");
    if (publicationPlanArtifact.key !== plan.key || publicationPlanArtifact.sha256 !== plan.sha256) {
      throw publicationError("certification_mismatch", `${documentPath} belongs to a different publication plan`);
    }
    return {
      documentPath,
      title,
      bodyMarkdown,
      publicationPlanArtifact,
      snapshotArtifact
    };
  });
}

function parseSnapshotInput(content: Uint8Array, scope: BoardContextPublicationScope): IngestEvidenceInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(content).toString("utf8")) as unknown;
  } catch {
    throw publicationError("invalid_publication", "snapshot artifact is not valid JSON");
  }
  const value = record(parsed, "snapshot artifact");
  if (
    value.tenantId !== scope.tenantId ||
    value.repository !== scope.repository ||
    value.ref !== scope.ref ||
    value.refSequence !== scope.refSequence ||
    value.commitSha !== scope.commitSha
  ) {
    throw publicationError("certification_mismatch", "snapshot scope does not match the leased publication task");
  }
  if (!Array.isArray(value.files) || !Array.isArray(value.observations ?? [])) {
    throw publicationError("invalid_publication", "snapshot files or observations are invalid");
  }
  return value as unknown as IngestEvidenceInput;
}

function validateScope(value: BoardContextPublicationScope): BoardContextPublicationScope {
  const tenantId = value.tenantId.trim();
  const repository = normalizeRepository(value.repository);
  const ref = value.ref.trim();
  const buildId = value.buildId.trim();
  if (!tenantId || !ref || !buildId || ref.length > 512 || buildId.length > 240) {
    throw publicationError("invalid_publication", "publication scope is invalid");
  }
  if (!Number.isSafeInteger(value.refSequence) || value.refSequence <= 0) {
    throw publicationError("invalid_publication", "publication refSequence must be a positive safe integer");
  }
  if (!isFullCommitSha(value.commitSha)) {
    throw publicationError("invalid_publication", "publication commitSha must be a full Git SHA");
  }
  return {
    tenantId,
    repository,
    ref,
    refSequence: value.refSequence,
    commitSha: value.commitSha.toLowerCase(),
    buildId
  };
}

function validateLease(value: BoardPublicationLeaseFence, buildId: string): BoardPublicationLeaseFence {
  if (
    !value.taskId.trim() ||
    !value.messageId.trim() ||
    !value.leaseId.trim() ||
    !value.writeFenceToken.trim() ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt <= 0
  ) {
    throw publicationError("stale_publication_lease", "publication lease identity is invalid");
  }
  if (value.taskId === buildId || value.messageId === buildId) {
    throw publicationError("stale_publication_lease", "publication lease must identify its child task and message");
  }
  return { ...value, leaseExpiresAt: normalizeIsoTime(value.leaseExpiresAt) };
}

function assertScopedArtifact(scope: BoardContextPublicationScope, artifact: ContextArtifactRef, label: string): void {
  validateArtifactRef(artifact);
  if (!isContextArtifactKeyInScope(artifact.key, scope)) {
    throw publicationError("invalid_publication", `${label} artifact is outside the leased build`);
  }
}

function validateArtifactRef(value: ContextArtifactRef): void {
  if (
    !value.key ||
    !value.uri ||
    !value.contentType ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    value.bytes > MAX_ARTIFACT_BYTES ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    throw publicationError("invalid_publication", "artifact reference is invalid");
  }
}

function parseArtifactRef(value: unknown, label: string): ContextArtifactRef {
  const input = record(value, label);
  const ref: ContextArtifactRef = {
    uri: string(input.uri, `${label}.uri`, 4_096),
    key: string(input.key, `${label}.key`, 4_096),
    contentType: string(input.contentType, `${label}.contentType`, 240),
    bytes: integer(input.bytes, `${label}.bytes`, 0),
    sha256: digest(input.sha256, `${label}.sha256`),
    ...(typeof input.objectGeneration === "string"
      ? { objectGeneration: string(input.objectGeneration, `${label}.objectGeneration`, 240) }
      : {})
  };
  validateArtifactRef(ref);
  return ref;
}

function uniqueArtifacts(values: readonly ContextArtifactRef[]): ContextArtifactRef[] {
  const byKey = new Map<string, ContextArtifactRef>();
  for (const value of values) {
    const existing = byKey.get(value.key);
    if (
      existing &&
      (existing.sha256 !== value.sha256 ||
        existing.bytes !== value.bytes ||
        existing.objectGeneration !== value.objectGeneration)
    ) {
      throw publicationError("invalid_publication", `artifact key has conflicting immutable identities: ${value.key}`);
    }
    byKey.set(value.key, value);
  }
  return [...byKey.values()];
}

function assertPublicationRecord(
  recordValue: BoardContextPublicationRecord,
  commit: BoardContextPublicationCommit
): void {
  if (
    recordValue.releaseId !== commit.releaseId ||
    recordValue.publicationInputDigest !== commit.publicationInputDigest ||
    recordValue.publicSnapshotDigest !== commit.publicSnapshotDigest ||
    recordValue.refSequence !== commit.scope.refSequence ||
    recordValue.commitSha !== commit.scope.commitSha ||
    recordValue.releaseArtifact.key !== commit.releaseArtifact.key ||
    recordValue.releaseArtifact.sha256 !== commit.releaseArtifact.sha256
  ) {
    throw publicationError("publication_race", "publication transaction returned a result for different inputs");
  }
}

function pagePath(value: unknown, label: string): string {
  const path = string(value, label, 512).replaceAll("\\", "/");
  if (
    path.startsWith("/") ||
    !path.endsWith(".md") ||
    path.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))
  ) {
    throw publicationError("invalid_publication", `${label} is not a safe public Markdown path`);
  }
  return path;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw publicationError("invalid_publication", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) {
    throw publicationError("invalid_publication", `${label} is invalid`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw publicationError("invalid_publication", `${label} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw publicationError("invalid_publication", `${label} must be SHA-256`);
  }
  return value;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function publicationError(
  code: ConstructorParameters<typeof BoardContextPublicationError>[0],
  message: string
): BoardContextPublicationError {
  return new BoardContextPublicationError(code, message);
}
