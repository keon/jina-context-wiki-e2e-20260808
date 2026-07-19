import { stableId, type EvidenceCitation, type GeneratedOntology, type OntologyGraph, type OntologyNodeKind } from "./model.js";

export const ONTOLOGY_PARSER_VERSION = "builtin-structural-v1";
export const ONTOLOGY_REGISTRY_VERSION = "ontology-registry-v1";
export const ONTOLOGY_GENERATOR_VERSION = "codex-assertions-v2";
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
  readonly recordedAt: string;
  readonly taskId: string;
  readonly files: readonly RepositoryTreeEntry[];
}

export interface CodeSymbolFact {
  readonly moniker: string;
  readonly name: string;
  readonly kind: string;
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
}

export interface OntologyIngestPlan {
  readonly observationId: string;
  readonly commitSha: string;
  readonly fileCount: number;
  readonly discoveredBlobCount: number;
  readonly reusedBlobCount: number;
  /** Added or modified paths relative to the first parent. This scopes semantic analysis independently of parser-cache misses. */
  readonly changedPaths: readonly string[];
  readonly missingBlobs: readonly { readonly blobSha: string; readonly path: string; readonly size: number }[];
}

export interface OntologyIngestResult extends Omit<OntologyIngestPlan, "missingBlobs"> {
  readonly parsedBlobCount: number;
  readonly parserVersion: string;
  readonly codeCheckpoint: string;
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
  readonly model: string;
  readonly sandboxId?: string;
  readonly summary: string;
  readonly rawOutput: GeneratedOntology;
  readonly assertions: readonly GeneratedAssertion[];
}

export type AssertionStatus = "proposed" | "active" | "rejected" | "superseded" | "retracted";

export interface StoredAssertion extends GeneratedAssertion {
  readonly id: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly commitSha: string;
  readonly status: AssertionStatus;
  readonly sourceObservationId: string;
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
  planIngestion(snapshot: RepositorySnapshot): Promise<OntologyIngestPlan>;
  applyBlobAnalyses(
    scope: Pick<RepositorySnapshot, "tenantId" | "repository" | "commitSha">,
    analyses: readonly BlobAnalysis[]
  ): Promise<void>;
  hasAssertionGeneration(
    tenantId: string,
    repository: string,
    commitSha: string,
    generatorVersion: string
  ): Promise<OntologyAssertionResult | undefined>;
  saveAssertionBatch(batch: OntologyAssertionBatch): Promise<OntologyAssertionResult>;
  project(request: OntologyProjectionRequest): Promise<OntologyGraph>;
}

interface PredicateDefinition {
  readonly subjectKinds: readonly OntologyNodeKind[];
  readonly objectKinds: readonly OntologyNodeKind[];
  readonly activationThreshold?: number;
}

const PREDICATES: Readonly<Record<string, PredicateDefinition>> = {
  IMPLEMENTS: {
    subjectKinds: ["File", "Symbol"],
    objectKinds: ["Issue", "Document"],
    activationThreshold: 0.9
  },
  DOCUMENTED_BY: {
    subjectKinds: ["Repository", "File", "Symbol", "Issue", "PullRequest"],
    objectKinds: ["Document"],
    activationThreshold: 0.9
  },
  REFERENCES: {
    subjectKinds: ["Issue", "PullRequest", "Document"],
    objectKinds: ["File", "Symbol", "Commit", "Issue", "PullRequest", "Document"],
    activationThreshold: 0.95
  },
  OWNED_BY: {
    subjectKinds: ["Repository", "File", "Symbol"],
    objectKinds: ["Engineer", "Team"]
  },
  MOVED_FROM: {
    subjectKinds: ["File", "Symbol"],
    objectKinds: ["File", "Symbol"]
  },
  LIKELY_AFFECTS: {
    subjectKinds: ["Commit", "PullRequest", "Issue"],
    objectKinds: ["File", "Symbol", "Issue"]
  }
};

export function normalizeAssertionBatch(batch: OntologyAssertionBatch): readonly StoredAssertion[] {
  const observationId = assertionObservationId(batch);
  const seen = new Set<string>();
  return batch.assertions.map((assertion) => {
    const predicate = normalizePredicate(assertion.predicate);
    const definition = PREDICATES[predicate];
    if (!definition) throw new Error(`unsupported ontology predicate: ${predicate}`);
    if (!definition.subjectKinds.includes(assertion.subject.kind)) {
      throw new Error(`${predicate} does not accept subject kind ${assertion.subject.kind}`);
    }
    if (!definition.objectKinds.includes(assertion.object.kind)) {
      throw new Error(`${predicate} does not accept object kind ${assertion.object.kind}`);
    }
    if (!Number.isFinite(assertion.confidence) || assertion.confidence < 0 || assertion.confidence > 1) {
      throw new Error(`${predicate} confidence must be between 0 and 1`);
    }
    if (assertion.evidence.length === 0) throw new Error(`${predicate} must include evidence`);
    const evidence = assertion.evidence.map((value) => validateEvidence(value).value);
    const key = `${entityKey(assertion.subject)}:${predicate}:${entityKey(assertion.object)}`;
    if (seen.has(key)) throw new Error(`duplicate ontology assertion: ${key}`);
    seen.add(key);
    return {
      ...assertion,
      predicate,
      evidence,
      id: stableId("assertion", `${batch.tenantId}:${batch.repository}:${batch.commitSha}:${key}`),
      tenantId: batch.tenantId,
      repository: batch.repository,
      commitSha: batch.commitSha,
      status: definition.activationThreshold !== undefined && assertion.confidence >= definition.activationThreshold
        ? "active"
        : "proposed",
      sourceObservationId: observationId,
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
      const key = `${entityKey(normalized.subject)}:${normalized.predicate}:${entityKey(normalized.object)}`;
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

export function assertionObservationId(batch: Pick<OntologyAssertionBatch, "tenantId" | "repository" | "commitSha" | "generatorVersion">): string {
  return stableId("observation", `${batch.tenantId}:${batch.repository}:${batch.commitSha}:model:${batch.generatorVersion}`);
}

export function sourceObservationId(snapshot: Pick<RepositorySnapshot, "tenantId" | "repository" | "commitSha" | "treeSha">): string {
  return stableId("observation", `${snapshot.tenantId}:${snapshot.repository}:${snapshot.commitSha}:git:${snapshot.treeSha}`);
}

export function codeCheckpoint(tenantId: string, repository: string, commitSha: string, parserVersion: string): string {
  return stableId("code", `${tenantId}:${repository}:${commitSha}:${parserVersion}`);
}

export function knowledgeCheckpoint(tenantId: string, repository: string, commitSha: string, generatorVersion: string): string {
  return stableId("knowledge", `${tenantId}:${repository}:${commitSha}:${generatorVersion}`);
}

export function entityKey(entity: OntologyEntityRef): string {
  return `${entity.kind}:${entity.naturalKey}`;
}

/** Pure normalizer from an immutable model observation to proposed assertion intents. */
export function assertionsFromGeneratedOntology(
  generated: GeneratedOntology,
  repository: string
): readonly GeneratedAssertion[] {
  const nodes = new Map(generated.nodes.map((node) => [node.id, node]));
  return generated.edges.flatMap((edge) => {
    if (edge.plane !== "knowledge") return [];
    const subject = nodes.get(edge.source);
    const object = nodes.get(edge.target);
    if (!subject || !object) return [];
    return [{
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
      evidence: edge.evidence
    }];
  });
}

function entityNaturalKey(node: GeneratedOntology["nodes"][number], repository: string): string {
  if (node.kind === "Repository") return repository;
  if ((node.kind === "File" || node.kind === "Document") && node.path) return node.path;
  return node.id;
}

function normalizePredicate(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
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
