import {
  createOntologyGraph,
  stableId,
  summarizeOntologyGraph,
  type OntologyEdge,
  type OntologyGraph,
  type OntologyGraphSummary,
  type OntologyNode
} from "./model.js";
import {
  ONTOLOGY_PARSER_VERSION,
  ONTOLOGY_PROJECTION_VERSION,
  assertionObservationId,
  entityKey,
  knowledgeCheckpoint,
  normalizeAssertionBatchLenient,
  sourceObservationId,
  type BlobAnalysis,
  type OntologyAssertionBatch,
  type OntologyAssertionResult,
  type OntologyIngestPlan,
  type OntologyPipelineStore,
  type OntologyProjectionRequest,
  type RepositorySnapshot,
  type StoredAssertion
} from "./pipeline.js";

export interface OntologyGraphStore extends OntologyPipelineStore {
  save(graph: OntologyGraph): Promise<void>;
  latest(tenantId: string): Promise<OntologyGraph | undefined>;
  get(graphId: string, tenantId: string): Promise<OntologyGraph | undefined>;
  list(tenantId: string): Promise<readonly OntologyGraph[]>;
  listSummaries(tenantId: string): Promise<readonly OntologyGraphSummary[]>;
  migrateTenantAliases(tenantId: string, aliases: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

export class MemoryOntologyGraphStore implements OntologyGraphStore {
  private readonly graphs = new Map<string, OntologyGraph>();
  private readonly snapshots = new Map<string, RepositorySnapshot>();
  private readonly blobAnalyses = new Map<string, BlobAnalysis>();
  private readonly assertionBatches = new Map<string, { readonly batch: OntologyAssertionBatch; readonly assertions: readonly StoredAssertion[] }>();

  async save(graph: OntologyGraph): Promise<void> {
    if (!this.graphs.has(graph.id)) this.graphs.set(graph.id, graph);
  }

  async latest(tenantId: string): Promise<OntologyGraph | undefined> {
    return (await this.list(tenantId))[0];
  }

  async get(graphId: string, tenantId: string): Promise<OntologyGraph | undefined> {
    const graph = this.graphs.get(graphId);
    return graph?.tenantId === tenantId ? graph : undefined;
  }

  async list(tenantId: string): Promise<readonly OntologyGraph[]> {
    return [...this.graphs.values()]
      .filter((graph) => graph.tenantId === tenantId)
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  }

  async listSummaries(tenantId: string): Promise<readonly OntologyGraphSummary[]> {
    return (await this.list(tenantId)).map(summarizeOntologyGraph);
  }

  async planIngestion(snapshot: RepositorySnapshot): Promise<OntologyIngestPlan> {
    const key = snapshotKey(snapshot.tenantId, snapshot.repository, snapshot.commitSha);
    if (!this.snapshots.has(key)) this.snapshots.set(key, structuredClone(snapshot));
    const firstPathByBlob = new Map<string, { readonly path: string; readonly size: number }>();
    for (const file of snapshot.files) {
      if (!firstPathByBlob.has(file.blobSha)) firstPathByBlob.set(file.blobSha, { path: file.path, size: file.size });
    }
    const missingBlobs = [...firstPathByBlob].flatMap(([blobSha, file]) =>
      this.blobAnalyses.has(blobKey(snapshot.tenantId, blobSha, ONTOLOGY_PARSER_VERSION)) ? [] : [{ blobSha, ...file }]
    );
    const parent = snapshot.parents[0]
      ? this.snapshots.get(snapshotKey(snapshot.tenantId, snapshot.repository, snapshot.parents[0]))
      : undefined;
    const parentFiles = new Map(parent?.files.map((file) => [file.path, file.blobSha]) ?? []);
    const changedPaths = snapshot.files
      .filter((file) => parentFiles.get(file.path) !== file.blobSha)
      .map((file) => file.path)
      .sort();
    return {
      observationId: sourceObservationId(snapshot),
      commitSha: snapshot.commitSha,
      fileCount: snapshot.files.length,
      discoveredBlobCount: firstPathByBlob.size,
      reusedBlobCount: firstPathByBlob.size - missingBlobs.length,
      changedPaths,
      missingBlobs
    };
  }

  async applyBlobAnalyses(
    scope: Pick<RepositorySnapshot, "tenantId" | "repository" | "commitSha">,
    analyses: readonly BlobAnalysis[]
  ): Promise<void> {
    const snapshot = this.snapshots.get(snapshotKey(scope.tenantId, scope.repository, scope.commitSha));
    if (!snapshot) throw new Error("repository snapshot must be recorded before blob analysis");
    const known = new Set(snapshot.files.map((file) => file.blobSha));
    for (const analysis of analyses) {
      if (!known.has(analysis.blobSha)) throw new Error(`blob ${analysis.blobSha} is not in the recorded snapshot`);
      const key = blobKey(scope.tenantId, analysis.blobSha, analysis.parserVersion);
      if (!this.blobAnalyses.has(key)) this.blobAnalyses.set(key, structuredClone(analysis));
    }
  }

  async hasAssertionGeneration(
    tenantId: string,
    repository: string,
    commitSha: string,
    generatorVersion: string
  ): Promise<OntologyAssertionResult | undefined> {
    const stored = this.assertionBatches.get(assertionKey(tenantId, repository, commitSha, generatorVersion));
    return stored ? assertionResult(stored.batch, stored.assertions, true) : undefined;
  }

  async saveAssertionBatch(batch: OntologyAssertionBatch): Promise<OntologyAssertionResult> {
    const key = assertionKey(batch.tenantId, batch.repository, batch.commitSha, batch.generatorVersion);
    const existing = this.assertionBatches.get(key);
    if (existing) return assertionResult(existing.batch, existing.assertions, true);
    const normalized = normalizeAssertionBatchLenient(batch);
    const assertions = normalized.assertions;
    this.assertionBatches.set(key, { batch: structuredClone(batch), assertions });
    return assertionResult(batch, assertions, false, normalized.warnings);
  }

  async project(request: OntologyProjectionRequest): Promise<OntologyGraph> {
    const snapshot = this.snapshots.get(snapshotKey(request.tenantId, request.repository, request.commitSha));
    if (!snapshot) throw new Error("cannot project an ontology before repository ingestion");
    const assertions = dedupeApplicableAssertions([...this.assertionBatches.values()]
      .filter(({ batch }) => batch.tenantId === request.tenantId && batch.repository === request.repository)
      .flatMap(({ assertions: values }) => values)
      .filter((assertion) => assertion.status === "active")
      .filter((assertion) => {
        const source = this.snapshots.get(snapshotKey(assertion.tenantId, assertion.repository, assertion.commitSha));
        return source ? assertionEvidenceIsCurrent(assertion, source, snapshot) : false;
      }));
    const graph = createOntologyProjection(snapshot, this.blobAnalyses, assertions, request);
    await this.save(graph);
    return graph;
  }

  async migrateTenantAliases(tenantId: string, aliases: readonly string[]): Promise<void> {
    for (const [id, graph] of this.graphs) {
      if (aliases.includes(graph.tenantId)) this.graphs.set(id, { ...graph, tenantId });
    }
  }

  async close(): Promise<void> {}
}

export function createOntologyProjection(
  snapshot: RepositorySnapshot,
  analyses: ReadonlyMap<string, BlobAnalysis>,
  assertions: readonly StoredAssertion[],
  request: OntologyProjectionRequest
): OntologyGraph {
  const files = [...snapshot.files]
    .sort((a, b) => filePriority(a.path) - filePriority(b.path) || a.path.localeCompare(b.path))
    .slice(0, 80);
  if (files.length === 0) throw new Error("cannot project an empty repository snapshot");
  const fallbackEvidence = `${files[0]!.path}:1`;
  const nodes = new Map<string, OntologyNode>();
  const edges: Omit<OntologyEdge, "id">[] = [];
  nodes.set("repo", {
    id: "repo",
    kind: "Repository",
    label: snapshot.repository,
    description: `Repository at ${snapshot.commitSha.slice(0, 12)}`,
    evidence: [fallbackEvidence]
  });
  for (const file of files) {
    const fileId = `file:${file.path}`;
    nodes.set(fileId, {
      id: fileId,
      kind: isDocument(file.path) ? "Document" : "File",
      label: file.path.split("/").at(-1) ?? file.path,
      description: file.path,
      path: file.path,
      evidence: [`${file.path}:1`]
    });
    edges.push({ source: "repo", target: fileId, predicate: "CONTAINS", plane: "code", evidence: [`${file.path}:1`] });
    const analysis = analyses.get(blobKey(snapshot.tenantId, file.blobSha, ONTOLOGY_PARSER_VERSION));
    for (const symbol of analysis?.symbols.slice(0, 8) ?? []) {
      if (nodes.size >= 200) break;
      const symbolId = `symbol:${file.path}:${symbol.moniker}`;
      nodes.set(symbolId, {
        id: symbolId,
        kind: "Symbol",
        label: symbol.name,
        description: `${symbol.kind} in ${file.path}`,
        path: file.path,
        evidence: [`${file.path}:${symbol.startLine}-${symbol.endLine}`]
      });
      edges.push({ source: fileId, target: symbolId, predicate: "DECLARES", plane: "code", evidence: [`${file.path}:${symbol.startLine}`] });
    }
  }
  const projectedPaths = new Set(files.map((file) => file.path));
  for (const file of files) {
    const analysis = analyses.get(blobKey(snapshot.tenantId, file.blobSha, ONTOLOGY_PARSER_VERSION));
    for (const item of analysis?.imports ?? []) {
      const targetPath = resolveImportPath(file.path, item.specifier, projectedPaths);
      if (!targetPath) continue;
      edges.push({
        source: `file:${file.path}`,
        target: `file:${targetPath}`,
        predicate: "IMPORTS",
        plane: "code",
        evidence: [`${file.path}:${item.line}`]
      });
    }
  }
  for (const assertion of assertions) {
    const source = projectionEntityId(assertion.subject);
    const target = projectionEntityId(assertion.object);
    ensureAssertionNode(nodes, source, assertion.subject, assertion.evidence);
    ensureAssertionNode(nodes, target, assertion.object, assertion.evidence);
    edges.push({
      source,
      target,
      predicate: assertion.predicate,
      plane: "knowledge",
      confidence: assertion.confidence,
      evidence: assertion.evidence
    });
  }
  return createOntologyGraph({
    request: { tenantId: request.tenantId, repository: request.repository, ref: request.ref, commitSha: request.commitSha, taskId: request.taskId },
    commitSha: request.commitSha,
    generatedAt: request.generatedAt,
    executor: "projection",
    model: ONTOLOGY_PROJECTION_VERSION,
    generated: {
      summary: `Projected ${files.length} files, ${[...nodes.values()].filter((node) => node.kind === "Symbol").length} symbols, and ${assertions.length} active semantic assertions from canonical Ontology data.`,
      nodes: [...nodes.values()],
      edges
    }
  });
}

function ensureAssertionNode(nodes: Map<string, OntologyNode>, id: string, entity: StoredAssertion["subject"], evidence: readonly string[]): void {
  if (nodes.has(id)) return;
  const path = entity.kind === "File" || entity.kind === "Document" ? entity.naturalKey : undefined;
  nodes.set(id, { id, kind: entity.kind, label: entity.label, description: entity.naturalKey, ...(path ? { path } : {}), evidence });
}

function projectionEntityId(entity: StoredAssertion["subject"]): string {
  if (entity.kind === "Repository") return "repo";
  if (entity.kind === "File" || entity.kind === "Document") return `file:${entity.naturalKey}`;
  return `entity:${stableId("node", entityKey(entity))}`;
}

function assertionResult(
  batch: OntologyAssertionBatch,
  assertions: readonly StoredAssertion[],
  cached: boolean,
  warnings: readonly string[] = []
): OntologyAssertionResult {
  return {
    observationId: assertionObservationId(batch),
    assertionCount: assertions.length,
    activeCount: assertions.filter((assertion) => assertion.status === "active").length,
    proposedCount: assertions.filter((assertion) => assertion.status === "proposed").length,
    knowledgeCheckpoint: knowledgeCheckpoint(batch.tenantId, batch.repository, batch.commitSha, batch.generatorVersion),
    cached,
    warnings
  };
}

function snapshotKey(tenantId: string, repository: string, commitSha: string): string { return `${tenantId}:${repository}:${commitSha}`; }
function blobKey(tenantId: string, blobSha: string, parserVersion: string): string { return `${tenantId}:${blobSha}:${parserVersion}`; }
function assertionKey(tenantId: string, repository: string, commitSha: string, generatorVersion: string): string {
  return `${tenantId}:${repository}:${commitSha}:${generatorVersion}`;
}
function dedupeApplicableAssertions(assertions: readonly StoredAssertion[]): readonly StoredAssertion[] {
  const selected = new Map<string, StoredAssertion>();
  for (const assertion of assertions) {
    const key = `${entityKey(assertion.subject)}:${assertion.predicate}:${entityKey(assertion.object)}`;
    const current = selected.get(key);
    if (!current || current.recordedAt < assertion.recordedAt) selected.set(key, assertion);
  }
  return [...selected.values()];
}
function assertionEvidenceIsCurrent(assertion: StoredAssertion, source: RepositorySnapshot, current: RepositorySnapshot): boolean {
  const sourceFiles = new Map(source.files.map((file) => [file.path, file.blobSha]));
  const currentFiles = new Map(current.files.map((file) => [file.path, file.blobSha]));
  return assertion.evidence.every((citation) => {
    const path = citation.replace(/:\d+(?:-\d+)?$/, "");
    return sourceFiles.get(path) !== undefined && sourceFiles.get(path) === currentFiles.get(path);
  });
}
function filePriority(path: string): number {
  if (/^README(?:\.|$)/i.test(path)) return 0;
  if (/^(docs?|src|app|packages)\//i.test(path)) return 1;
  if (isDocument(path)) return 2;
  return 3;
}
function isDocument(path: string): boolean { return /(?:^|\/)(?:README[^/]*|[^/]+\.(?:md|mdx|rst|txt))$/i.test(path); }
function resolveImportPath(importer: string, specifier: string, paths: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = importer.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
  const stem = base.join("/");
  const candidates = [stem, ...["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs"].map((extension) => `${stem}.${extension}`),
    ...["ts", "tsx", "js", "jsx", "py"].map((extension) => `${stem}/index.${extension}`)];
  return candidates.find((candidate) => paths.has(candidate));
}
