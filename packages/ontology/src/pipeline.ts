import {
  stableId,
  type EvidenceCitation,
  type GeneratedOntology,
  type OntologyGraph,
  type OntologyNodeKind,
  type OntologySourceEvidence
} from "./model.js";
import { canonicalJson, type AssertionStatus } from "./knowledge.js";
import type { GitHubSourceObservation } from "./normalizers.js";
import {
  normalizePredicateName,
  predicateDefinition,
  validatePredicateEndpoints,
  validateQualifiers
} from "./registry.js";

export const ONTOLOGY_PARSER_VERSION = "tree-sitter-structural-v2";
export { ONTOLOGY_REGISTRY_VERSION } from "./registry.js";
export const ONTOLOGY_GENERATOR_VERSION = "codex-assertions-v11";
export const ONTOLOGY_PROJECTION_VERSION = "current-graph-v1";

export interface RepositoryTreeEntry {
  readonly path: string;
  readonly blobSha: string;
  readonly size: number;
}

export interface RepositorySnapshot {
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly parents: readonly string[];
  readonly authorExternalId?: string;
  readonly authorGitHubLogin?: string;
  readonly authorName?: string;
  readonly committedAt?: string;
  readonly message?: string;
  readonly isDefaultRef?: boolean;
  /** Historical snapshots are canonical code-plane input but must not move the live ref. */
  readonly updateRef?: boolean;
  readonly recordedAt: string;
  readonly taskId: string;
  readonly files: readonly RepositoryTreeEntry[];
}

export interface CodeSymbolFact {
  readonly moniker: string;
  readonly name: string;
  readonly kind: string;
  readonly signatureHash: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface CodeSymbolEdgeFact {
  readonly fromMoniker: string;
  readonly kind: "calls" | "imports" | "references" | "extends";
  readonly toMoniker: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface CodeImportFact {
  readonly specifier: string;
  readonly line: number;
}

export interface BlobAnalysis {
  readonly blobSha: string;
  readonly parserVersion: string;
  readonly language?: string;
  readonly symbols: readonly CodeSymbolFact[];
  readonly imports: readonly CodeImportFact[];
  readonly edges: readonly CodeSymbolEdgeFact[];
}

export interface CommitChangeFact {
  readonly path: string;
  readonly change: "add" | "modify" | "delete" | "rename";
  readonly oldPath?: string;
  readonly oldBlobSha?: string;
  readonly newBlobSha?: string;
}

export interface OntologyIngestPlan {
  readonly observationId: string;
  readonly commitSha: string;
  readonly fileCount: number;
  readonly discoveredBlobCount: number;
  readonly reusedBlobCount: number;
  /** Added or modified paths relative to the first parent. This scopes semantic analysis independently of parser-cache misses. */
  readonly changedPaths: readonly string[];
  readonly changes: readonly CommitChangeFact[];
  readonly missingBlobs: readonly { readonly blobSha: string; readonly path: string; readonly size: number }[];
}

export interface OntologySourceIngestResult {
  readonly observationCount: number;
  readonly observationIds: readonly string[];
  readonly assertionCount: number;
  readonly newObservationCount: number;
  readonly updatedObservationCount: number;
  readonly confirmedObservationCount: number;
}

export interface OntologyEntityRef {
  readonly kind: OntologyNodeKind;
  readonly naturalKey: string;
  readonly label: string;
}

export interface GeneratedAssertion {
  readonly subject: OntologyEntityRef;
  readonly predicate: string;
  readonly object: OntologyEntityRef;
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly qualifiers?: Readonly<Record<string, string | number | boolean>>;
}

export interface OntologyAssertionBatch {
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly taskId: string;
  readonly generatedAt: string;
  readonly generatorVersion: string;
  readonly registryVersion: string;
  /** Canonical fingerprint of the code and source evidence supplied to this generation. */
  readonly evidenceFingerprint: string;
  readonly evidenceObservationIds: readonly string[];
  readonly model: string;
  readonly sandboxId?: string;
  readonly summary: string;
  /** Exact parsed model document before graph normalization. */
  readonly modelOutputRaw?: unknown;
  readonly rawOutput: GeneratedOntology;
  readonly assertions: readonly GeneratedAssertion[];
}

export interface StoredAssertion extends GeneratedAssertion {
  readonly id: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly commitSha: string;
  readonly status: AssertionStatus;
  readonly sourceObservationId?: string;
  readonly assertedBy?: string;
  readonly qualifiers?: Readonly<Record<string, string | number | boolean>>;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly lastConfirmedAt: string;
  readonly supersededBy?: string;
  readonly generatorVersion: string;
  readonly registryVersion: string;
  readonly recordedAt: string;
}

export interface OntologyAssertionResult {
  readonly observationId: string;
  readonly assertionCount: number;
  readonly activeCount: number;
  readonly proposedCount: number;
  readonly knowledgeCheckpoint: string;
  readonly cached: boolean;
  readonly warnings: readonly string[];
}

export interface OntologyProjectionRequest {
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly taskId: string;
  readonly generatedAt: string;
}

export interface OntologyPipelineStore {
  knownCommits(tenantId: string, repository: string, commitShas: readonly string[]): Promise<readonly string[]>;
  planIngestion(snapshot: RepositorySnapshot): Promise<OntologyIngestPlan>;
  applyBlobAnalyses(
    scope: Pick<RepositorySnapshot, "tenantId" | "repository" | "commitSha">,
    analyses: readonly BlobAnalysis[]
  ): Promise<void>;
  applyGitHubObservations(observations: readonly GitHubSourceObservation[]): Promise<OntologySourceIngestResult>;
  loadAssertionEvidence(
    tenantId: string,
    repository: string,
    observationIds: readonly string[]
  ): Promise<readonly OntologySourceEvidence[]>;
  hasAssertionGeneration(
    tenantId: string,
    repository: string,
    commitSha: string,
    generatorVersion: string,
    registryVersion: string,
    evidenceFingerprint: string
  ): Promise<OntologyAssertionResult | undefined>;
  saveAssertionBatch(batch: OntologyAssertionBatch): Promise<OntologyAssertionResult>;
  project(request: OntologyProjectionRequest): Promise<OntologyGraph>;
}

export function normalizeAssertionBatch(batch: OntologyAssertionBatch): readonly StoredAssertion[] {
  const observationId = assertionObservationId(batch);
  const seen = new Set<string>();
  return batch.assertions.map((assertion) => {
    const predicate = normalizePredicateName(assertion.predicate);
    const definition = predicateDefinition(predicate);
    validatePredicateEndpoints(definition, assertion.subject.kind, assertion.object.kind);
    validateQualifiers(definition, assertion.qualifiers);
    if (!Number.isFinite(assertion.confidence) || assertion.confidence < 0 || assertion.confidence > 1) {
      throw new Error(`${predicate} confidence must be between 0 and 1`);
    }
    if (assertion.evidence.length === 0) throw new Error(`${predicate} must include evidence`);
    const evidence = assertion.evidence.map((value) => validateEvidence(value).value);
    const key = `${entityKey(assertion.subject)}:${predicate}:${entityKey(assertion.object)}:${canonicalJson(assertion.qualifiers ?? {})}`;
    if (seen.has(key)) throw new Error(`duplicate ontology assertion: ${key}`);
    seen.add(key);
    return {
      ...assertion,
      predicate,
      evidence,
      id: stableId(
        "assertion",
        `${batch.tenantId}:${batch.repository}:${batch.commitSha}:${batch.registryVersion}:${batch.evidenceFingerprint}:${key}`
      ),
      tenantId: batch.tenantId,
      repository: batch.repository,
      commitSha: batch.commitSha,
      // Models only create proposals. Threshold activation is allowed only after
      // calibration data is measured and installed by the knowledge service.
      status: "proposed",
      sourceObservationId: observationId,
      lastConfirmedAt: batch.generatedAt,
      generatorVersion: batch.generatorVersion,
      registryVersion: batch.registryVersion,
      recordedAt: batch.generatedAt
    };
  });
}

export function normalizeAssertionBatchLenient(batch: OntologyAssertionBatch): {
  readonly assertions: readonly StoredAssertion[];
  readonly warnings: readonly string[];
} {
  const assertions: StoredAssertion[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const proposal of batch.assertions) {
    try {
      const normalized = normalizeAssertionBatch({ ...batch, assertions: [proposal] })[0];
      if (!normalized) continue;
      const key = `${entityKey(normalized.subject)}:${normalized.predicate}:${entityKey(normalized.object)}:${canonicalJson(normalized.qualifiers ?? {})}`;
      if (seen.has(key)) {
        warnings.push(`duplicate ontology assertion ignored: ${key}`);
        continue;
      }
      seen.add(key);
      assertions.push(normalized);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { assertions, warnings };
}

export function assertionObservationId(batch: Pick<OntologyAssertionBatch, "tenantId" | "repository" | "commitSha" | "generatorVersion" | "registryVersion" | "evidenceFingerprint">): string {
  return stableId(
    "observation",
    `${batch.tenantId}:${batch.repository}:${batch.commitSha}:model:${batch.generatorVersion}:registry:${batch.registryVersion}:evidence:${batch.evidenceFingerprint}`
  );
}

export function sourceObservationId(snapshot: Pick<RepositorySnapshot, "tenantId" | "repository" | "commitSha" | "treeSha">): string {
  return stableId("observation", `${snapshot.tenantId}:${snapshot.repository}:${snapshot.commitSha}:git:${snapshot.treeSha}`);
}

export function codeCheckpoint(tenantId: string, repository: string, commitSha: string, parserVersion: string): string {
  return stableId("code", `${tenantId}:${repository}:${commitSha}:${parserVersion}`);
}

export function assertionEvidenceFingerprint(
  codeCheckpointValue: string,
  observations: readonly GitHubSourceObservation[],
  semanticScope: {
    readonly focusPaths?: readonly string[];
    readonly problemEvidencePullRequestNumbers?: readonly number[];
  } = {}
): string {
  const sourceEvidence = observations.map((observation) => {
    const { recordedAt: _recordedAt, ...stable } = observation;
    return stable;
  }).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return stableId("evidence", canonicalJson({
    codeCheckpoint: codeCheckpointValue,
    sourceEvidence,
    focusPaths: [...new Set(semanticScope.focusPaths ?? [])].sort(),
    problemEvidencePullRequestNumbers: [...new Set(semanticScope.problemEvidencePullRequestNumbers ?? [])].sort((a, b) => a - b)
  }));
}

/**
 * Keep incremental semantic inspection bounded while retaining the evidence
 * files most likely to explain changes spanning several newly ingested commits.
 * Paths must exist at the requested ref; deleted historical paths cannot be
 * cited by the assertion worker.
 */
export function selectAssertionFocusPaths(
  headPaths: readonly string[],
  historicalPathsNewestFirst: readonly string[],
  currentPaths: ReadonlySet<string>,
  limit = 200
): readonly string[] {
  const maximum = Math.max(1, limit);
  const selected: string[] = [];
  const seen = new Set<string>();
  const add = (path: string): void => {
    if (selected.length >= maximum || seen.has(path) || !currentPaths.has(path)) return;
    seen.add(path);
    selected.push(path);
  };
  headPaths.forEach(add);
  historicalPathsNewestFirst.filter(isSemanticEvidencePath).forEach(add);
  historicalPathsNewestFirst.forEach(add);
  return selected;
}

function isSemanticEvidencePath(path: string): boolean {
  return /(?:^|\/)(?:readme|changelog|incident|postmortem|root[-_]?cause|adr|rfc)|(?:^|\/)(?:docs?|test|tests|spec|specs)(?:\/|$)|(?:\.|[-_])(?:test|spec)\.[^/]+$/i.test(path);
}

export function knowledgeCheckpoint(
  tenantId: string,
  repository: string,
  commitSha: string,
  generatorVersion: string,
  registryVersion: string,
  evidenceFingerprint: string
): string {
  return stableId("knowledge", `${tenantId}:${repository}:${commitSha}:${generatorVersion}:${registryVersion}:${evidenceFingerprint}`);
}

export function entityKey(entity: OntologyEntityRef): string {
  return `${entity.kind}:${entity.naturalKey}`;
}

/** First-parent delta. State still comes directly from each snapshot's tree. */
export function computeCommitChanges(
  current: readonly RepositoryTreeEntry[],
  parent: readonly RepositoryTreeEntry[] = []
): readonly CommitChangeFact[] {
  const currentByPath = new Map(current.map((file) => [file.path, file]));
  const parentByPath = new Map(parent.map((file) => [file.path, file]));
  const added = current.filter((file) => !parentByPath.has(file.path));
  const deleted = parent.filter((file) => !currentByPath.has(file.path));
  const addedByBlob = new Map<string, RepositoryTreeEntry[]>();
  for (const file of added) addedByBlob.set(file.blobSha, [...(addedByBlob.get(file.blobSha) ?? []), file]);
  const renamedNewPaths = new Set<string>();
  const renamedOldPaths = new Set<string>();
  const changes: CommitChangeFact[] = [];
  for (const oldFile of deleted) {
    const candidate = addedByBlob.get(oldFile.blobSha)?.find((file) => !renamedNewPaths.has(file.path));
    if (!candidate) continue;
    renamedOldPaths.add(oldFile.path);
    renamedNewPaths.add(candidate.path);
    changes.push({
      path: candidate.path, change: "rename", oldPath: oldFile.path,
      oldBlobSha: oldFile.blobSha, newBlobSha: candidate.blobSha
    });
  }
  for (const file of current) {
    const previous = parentByPath.get(file.path);
    if (!previous && !renamedNewPaths.has(file.path)) {
      changes.push({ path: file.path, change: "add", newBlobSha: file.blobSha });
    } else if (previous && previous.blobSha !== file.blobSha) {
      changes.push({ path: file.path, change: "modify", oldBlobSha: previous.blobSha, newBlobSha: file.blobSha });
    }
  }
  for (const file of deleted) {
    if (!renamedOldPaths.has(file.path)) changes.push({ path: file.path, change: "delete", oldBlobSha: file.blobSha });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path) || a.change.localeCompare(b.change));
}

/** Pure normalizer from an immutable model observation to proposed assertion intents. */
export function assertionsFromGeneratedOntology(
  generated: GeneratedOntology,
  repository: string,
  options: {
    readonly sourcePullRequestNumbers?: readonly number[];
    readonly resolvedPullRequestNumbers?: readonly number[];
  } = {}
): readonly GeneratedAssertion[] {
  const nodes = new Map(generated.nodes.map((node) => [node.id, node]));
  validateDerivedIssueNodes(
    generated,
    nodes,
    options.sourcePullRequestNumbers ?? [],
    options.resolvedPullRequestNumbers ?? []
  );
  return generated.edges.flatMap((edge) => {
    if (edge.plane !== "knowledge") return [];
    const subject = nodes.get(edge.source);
    const object = nodes.get(edge.target);
    if (!subject || !object) return [];
    const isVirtualResolution = edge.predicate === "RESOLVES" &&
      object.kind === "Issue" && /^virtual:pr:\d+$/i.test(object.id.trim());
    // Explicit GitHub issue resolution is an authoritative intake fact. A model
    // may repeat it after reading source evidence, but must not create a second
    // knowledge assertion with independent provenance.
    if (edge.predicate === "RESOLVES" && !isVirtualResolution) return [];
    const assertion: GeneratedAssertion = {
      subject: {
        kind: subject.kind,
        naturalKey: entityNaturalKey(subject, repository),
        label: subject.label
      },
      predicate: edge.predicate,
      object: {
        kind: object.kind,
        naturalKey: entityNaturalKey(object, repository),
        label: object.label
      },
      confidence: edge.confidence ?? 0,
      evidence: edge.evidence,
      ...(edge.predicate === "INTRODUCED_BY"
        ? { qualifiers: { reason: requiredCausalReason(edge.why) } }
        : {})
    };
    return [assertion];
  });
}

function validateDerivedIssueNodes(
  generated: GeneratedOntology,
  nodes: ReadonlyMap<string, GeneratedOntology["nodes"][number]>,
  sourcePullRequestNumbers: readonly number[],
  resolvedPullRequestNumbers: readonly number[]
): void {
  const observed = new Set(sourcePullRequestNumbers);
  const resolved = new Set(resolvedPullRequestNumbers);
  const anchors = new Set<number>();
  for (const node of generated.nodes) {
    if (node.kind !== "Issue") continue;
    const anchorText = /^virtual:pr:(\d+)$/i.exec(node.id.trim())?.[1];
    if (!anchorText) continue;
    const anchor = Number.parseInt(anchorText, 10);
    if (!Number.isSafeInteger(anchor) || anchor < 1) throw new Error(`invalid virtual Issue anchor: ${node.id}`);
    if (!observed.has(anchor)) throw new Error(`pull request #${anchor} is not present in source evidence`);
    if (anchors.has(anchor)) throw new Error(`only one virtual Issue is allowed for pull request #${anchor}`);
    if (resolved.has(anchor)) throw new Error(`pull request #${anchor} already explicitly resolves an issue`);
    anchors.add(anchor);
    const resolutions = generated.edges.filter((edge) => edge.predicate === "RESOLVES" && edge.target === node.id);
    if (resolutions.length !== 1) throw new Error(`virtual Issue ${node.id} requires exactly one RESOLVES edge`);
    const subject = nodes.get(resolutions[0]!.source);
    const subjectNumber = subject?.kind === "PullRequest" ? canonicalWorkItemId(subject.id, "PullRequest") : undefined;
    if (subjectNumber !== String(anchor)) throw new Error(`virtual Issue ${node.id} must be resolved by pull request #${anchor}`);
  }
}

export function derivedIssueNaturalKey(repository: string, pullRequestNumber: number, slot = "primary"): string {
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new Error(`derived Issue anchor must be a positive pull request number: ${pullRequestNumber}`);
  }
  const pullRequestKey = `github:pr:${repository}#${pullRequestNumber}`;
  return `derived:issue:${repository}:${stableId("candidate", `${pullRequestKey}:${slot}`)}`;
}

export function featureNaturalKey(repository: string, featureId: string): string {
  const slug = /^feature:([a-z0-9]+(?:[-_][a-z0-9]+)*)$/i.exec(featureId.trim())?.[1];
  if (!slug) throw new Error(`Feature id must use feature:<stable-kebab-slug>: ${featureId}`);
  return `repo:${repository}:feature:${slug.toLowerCase().replaceAll("_", "-")}`;
}

function entityNaturalKey(node: GeneratedOntology["nodes"][number], repository: string): string {
  if (node.kind === "Repository") return `github:repo:${repository}`;
  if ((node.kind === "File" || node.kind === "Document") && node.path) return `repo:${repository}:path:${node.path}`;
  if (node.kind === "Symbol") return `repo:${repository}:moniker:${node.id}`;
  if (node.kind === "Commit") return `repo:${repository}:sha:${canonicalCommitId(node.id)}`;
  if (node.kind === "PullRequest") return `github:pr:${repository}#${canonicalWorkItemId(node.id, "PullRequest")}`;
  if (node.kind === "Feature") return featureNaturalKey(repository, node.id);
  if (node.kind === "Issue") {
    const virtualAnchor = /^virtual:pr:(\d+)$/i.exec(node.id.trim())?.[1];
    if (virtualAnchor) return derivedIssueNaturalKey(repository, Number.parseInt(virtualAnchor, 10));
    return `github:issue:${repository}#${canonicalWorkItemId(node.id, "Issue")}`;
  }
  return node.id;
}

function canonicalCommitId(value: string): string {
  const match = /^(?:(?:commit|sha):)?([a-f0-9]{40})$/i.exec(value.trim());
  if (!match?.[1]) throw new Error(`Commit node id must be a full Git SHA: ${value}`);
  return match[1].toLowerCase();
}

function canonicalWorkItemId(value: string, kind: "Issue" | "PullRequest"): string {
  const prefix = kind === "Issue" ? "issue" : "(?:pr|pull_request|pullrequest)";
  const match = new RegExp(`^(?:${prefix}:)?#?(\\d+)$`, "i").exec(value.trim());
  if (!match?.[1] || Number.parseInt(match[1], 10) < 1) {
    throw new Error(`${kind} node id must be a positive GitHub number: ${value}`);
  }
  return match[1];
}

function requiredCausalReason(value: string | undefined): string {
  if (!value?.trim()) throw new Error("INTRODUCED_BY must explain why the commit caused the issue");
  return value.trim();
}

function validateEvidence(value: string): EvidenceCitation {
  const match = /^(.*):(\d+)(?:-(\d+))?$/.exec(value);
  if (!match?.[1] || !match[2]) throw new Error(`invalid ontology evidence citation: ${value}`);
  const path = match[1];
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`ontology evidence path must be repository-relative: ${value}`);
  }
  const startLine = Number.parseInt(match[2], 10);
  const endLine = match[3] ? Number.parseInt(match[3], 10) : startLine;
  if (startLine < 1 || endLine < startLine) throw new Error(`invalid ontology evidence range: ${value}`);
  return { value, path, startLine, endLine };
}
