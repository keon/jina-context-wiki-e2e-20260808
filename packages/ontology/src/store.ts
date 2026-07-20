import {
  createOntologyGraph,
  stableId,
  summarizeOntologyGraph,
  type OntologyEdge,
  type OntologyGraph,
  type OntologyGraphSummary,
  type OntologyNode
} from "./model.js";
import type { OntologyCommand, OntologyCommandResult, RepositoryContextOperations } from "./operations.js";
import type { OntologyOperationalMetrics, ProjectionRebuildResult } from "./outbox.js";
import { normalizeGitHubSourceObservation, type GitHubSourceObservation } from "./normalizers.js";
import { predicateDefinition } from "./registry.js";
import type { RetrievalRequest, RetrievalResult } from "./retrieval.js";
import {
  ONTOLOGY_PARSER_VERSION,
  ONTOLOGY_PROJECTION_VERSION,
  assertionObservationId,
  computeCommitChanges,
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

export interface OntologyGraphStore extends OntologyPipelineStore, RepositoryContextOperations {
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
  private readonly repositoryAcl = new Map<string, Set<string>>();
  private readonly memoryAudit: OntologyCommandResult[] = [];

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

  async knownCommits(tenantId: string, repository: string, commitShas: readonly string[]): Promise<readonly string[]> {
    return commitShas.filter((sha) => this.snapshots.has(snapshotKey(tenantId, repository, sha)));
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
    const changes = computeCommitChanges(snapshot.files, parent?.files);
    const changedPaths = changes.filter((change) => change.change !== "delete").map((change) => change.path);
    return {
      observationId: sourceObservationId(snapshot),
      commitSha: snapshot.commitSha,
      fileCount: snapshot.files.length,
      discoveredBlobCount: firstPathByBlob.size,
      reusedBlobCount: firstPathByBlob.size - missingBlobs.length,
      changedPaths,
      changes,
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

  async applyGitHubObservations(observations: readonly GitHubSourceObservation[]): Promise<{ readonly observationCount: number; readonly assertionCount: number }> {
    return {
      observationCount: observations.length,
      assertionCount: observations.reduce((count, observation) => count + normalizeGitHubSourceObservation(observation).assertions.length, 0)
    };
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

  async executeCommand(tenantId: string, actorId: string, command: OntologyCommand, now: string, actorIsTenantAdmin = false): Promise<OntologyCommandResult> {
    if (!actorId.startsWith("svc:") && !actorIsTenantAdmin) {
      const repository = "repository" in command ? command.repository : undefined;
      if (!repository || !this.repositoryAcl.get(`${tenantId}:${actorId}`)?.has(repository)) {
        throw new Error("ontology command access denied");
      }
    }
    const affectedIds: string[] = [];
    if (command.type === "review_assertion") {
      let found = false;
      for (const [key, stored] of this.assertionBatches) {
        const current = stored.assertions.find((assertion) => assertion.tenantId === tenantId && assertion.id === command.assertionId);
        if (!current) continue;
        const status: StoredAssertion["status"] = command.decision === "accept" ? "active" : command.decision === "reject" ? "rejected" : "retracted";
        const assertions = stored.assertions.map((assertion) => assertion.id === current.id
          ? { ...assertion, status, ...(status === "retracted" ? { validTo: now } : {}) }
          : assertion
        );
        this.assertionBatches.set(key, { ...stored, assertions });
        affectedIds.push(current.id);
        found = true;
      }
      if (!found) throw new Error("assertion not found");
    } else if (command.type === "grant_repository_access") {
      const key = `${tenantId}:${command.principalId}`;
      const repositories = this.repositoryAcl.get(key) ?? new Set<string>();
      repositories.add(command.repository);
      this.repositoryAcl.set(key, repositories);
      affectedIds.push(command.repository);
    } else if (command.type === "tombstone_repository") {
      for (const [key, snapshot] of this.snapshots) if (snapshot.tenantId === tenantId && snapshot.repository === command.repository) this.snapshots.delete(key);
      affectedIds.push(command.repository);
    } else if (command.type === "redact_observation") {
      affectedIds.push(command.observationId);
    } else if (command.type === "erase_person") {
      affectedIds.push(command.entityId);
    } else if (command.type === "merge_entities" || command.type === "unmerge_entities") {
      affectedIds.push(command.fromEntityId, command.toEntityId);
    } else if (command.type === "assign_relationship") {
      const definition = predicateDefinition(command.predicate);
      if (definition.review === "none") throw new Error("explicit-source predicates must enter through intake, not an internal assignment");
      affectedIds.push(stableId("assertion", `${tenantId}:${command.subject.key}:${definition.name}:${command.object.key}:${now}`));
    }
    const result = {
      auditId: stableId("audit", `${tenantId}:${actorId}:${command.type}:${now}:${JSON.stringify(command)}`),
      action: command.type, affectedIds, outboxEventIds: affectedIds.map((id) => stableId("outbox", `${tenantId}:${command.type}:${id}:${now}`))
    };
    this.memoryAudit.push(result);
    return result;
  }

  async rebuildDerivedProjections(tenantId: string, repository: string, ref: string, now: string): Promise<ProjectionRebuildResult> {
    const snapshot = [...this.snapshots.values()]
      .filter((value) => value.tenantId === tenantId && value.repository === repository && value.ref === ref && value.updateRef !== false)
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
    return {
      manifestFileCount: snapshot?.files.length ?? 0,
      searchDocumentCount: snapshot ? 1 : 0,
      reconciledAssertionCount: 0,
      rebuilt: true,
      processedEventCount: 0,
      projectedAt: now
    };
  }

  async drainDerivedProjectionEvents(): Promise<{ readonly processedEventCount: number; readonly rebuiltRepositories: readonly string[] }> {
    return { processedEventCount: 0, rebuiltRepositories: [] };
  }

  async operationalMetrics(tenantId: string): Promise<OntologyOperationalMetrics> {
    return {
      outboxDepth: {}, oldestOutboxAgeSeconds: 0,
      unparsedBlobCount: [...this.snapshots.values()].filter((snapshot) => snapshot.tenantId === tenantId)
        .flatMap((snapshot) => snapshot.files).filter((file) => !this.blobAnalyses.has(blobKey(tenantId, file.blobSha, ONTOLOGY_PARSER_VERSION))).length,
      manifestStalenessSeconds: 0, searchStalenessSeconds: 0,
      proposedAssertionCount: [...this.assertionBatches.values()].flatMap((stored) => stored.assertions)
        .filter((assertion) => assertion.tenantId === tenantId && assertion.status === "proposed").length,
      acceptanceRates: []
    };
  }

  async repositoriesForPrincipal(tenantId: string, principalId: string): Promise<readonly string[]> {
    if (principalId.startsWith("svc:")) {
      return [...new Set([
        ...[...this.snapshots.values()].filter((snapshot) => snapshot.tenantId === tenantId).map((snapshot) => snapshot.repository),
        ...[...this.graphs.values()].filter((graph) => graph.tenantId === tenantId).map((graph) => graph.repository)
      ])].sort();
    }
    return [...(this.repositoryAcl.get(`${tenantId}:${principalId}`) ?? [])].sort();
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    if (!request.allowedRepositories.includes(request.repository)) throw new Error("repository access denied");
    const limit = Math.max(1, Math.min(request.limit ?? 50, 200));
    const snapshot = [...this.snapshots.values()]
      .filter((value) => value.tenantId === request.tenantId && value.repository === request.repository && (!request.ref || value.ref === request.ref))
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
    const items = snapshot ? memoryRetrievalItems(request, snapshot, this.blobAnalyses, [...this.assertionBatches.values()].flatMap((stored) => stored.assertions)) : [];
    return {
      template: request.template, repository: request.repository, ref: request.ref ?? snapshot?.ref ?? "main",
      items: items.slice(0, limit), truncated: items.length > limit, totalBeforeLimit: items.length, limit
    };
  }
}

function memoryRetrievalItems(
  request: RetrievalRequest,
  snapshot: RepositorySnapshot,
  analyses: ReadonlyMap<string, BlobAnalysis>,
  assertions: readonly StoredAssertion[]
): RetrievalResult["items"] {
  if (request.template === "structure") {
    return snapshot.files.flatMap((file) => {
      const analysis = analyses.get(blobKey(snapshot.tenantId, file.blobSha, ONTOLOGY_PARSER_VERSION));
      return (analysis?.edges ?? []).filter((edge) => !request.symbol || edge.fromMoniker.includes(request.symbol) || edge.toMoniker.includes(request.symbol)).map((edge) => ({
        kind: edge.kind, title: `${edge.fromMoniker} ${edge.kind} ${edge.toMoniker}`,
        data: { fromMoniker: edge.fromMoniker, toMoniker: edge.toMoniker, path: file.path }, score: 1,
        citations: [{ kind: "code" as const, id: `${file.blobSha}:${edge.startLine}`, repository: request.repository, commitSha: snapshot.commitSha, path: file.path, startLine: edge.startLine, endLine: edge.endLine }]
      }));
    });
  }
  if (request.template === "change") {
    return computeCommitChanges(snapshot.files, []).map((change) => ({
      kind: "commit_change", title: `${change.change} ${change.path}`, data: { ...change }, score: 1,
      citations: [{ kind: "commit_change" as const, id: `${snapshot.commitSha}:${change.path}`, repository: request.repository, commitSha: snapshot.commitSha, path: change.path }]
    }));
  }
  if (request.template === "ownership") {
    return assertions.filter((assertion) => assertion.tenantId === request.tenantId && assertion.predicate === "OWNED_BY" && assertion.status === "active").map((assertion) => ({
      kind: "ownership", title: `${assertion.subject.label} owned by ${assertion.object.label}`,
      data: { subject: assertion.subject, object: assertion.object, qualifiers: assertion.qualifiers ?? {} }, score: 1,
      citations: [{ kind: "assertion" as const, id: assertion.id, repository: request.repository, commitSha: assertion.commitSha }]
    }));
  }
  return assertions.filter((assertion) => assertion.tenantId === request.tenantId && assertion.status === "active").map((assertion) => ({
    kind: "intent", title: `${assertion.subject.label} ${assertion.predicate} ${assertion.object.label}`,
    data: { predicate: assertion.predicate }, score: assertion.confidence,
    citations: [{ kind: "assertion" as const, id: assertion.id, repository: request.repository, commitSha: assertion.commitSha }]
  }));
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
  const symbolByScopedName = new Map<string, string>();
  const symbolsByName = new Map<string, string[]>();
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
      symbolByScopedName.set(`${file.path}:${symbol.name}`, symbolId);
      symbolsByName.set(symbol.name, [...(symbolsByName.get(symbol.name) ?? []), symbolId]);
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
    for (const item of analysis?.edges ?? []) {
      if (item.kind === "imports") continue;
      const fromName = item.fromMoniker.split(/[.#]/).filter(Boolean).at(-1) ?? item.fromMoniker;
      const targetName = item.toMoniker.split(/[.(#]/).filter(Boolean).at(-1) ?? item.toMoniker;
      const sourceId = item.fromMoniker.includes("<module>")
        ? `file:${file.path}`
        : symbolByScopedName.get(`${file.path}:${fromName}`) ?? symbolsByName.get(fromName)?.[0] ?? `file:${file.path}`;
      let targetId = symbolByScopedName.get(`${file.path}:${targetName}`) ?? symbolsByName.get(targetName)?.[0];
      if (!targetId && nodes.size < 200) {
        targetId = `external:${stableId("moniker", item.toMoniker)}`;
        nodes.set(targetId, {
          id: targetId, kind: "Symbol", label: item.toMoniker, description: "Unresolved external or cross-file moniker",
          evidence: [`${file.path}:${item.startLine}-${item.endLine}`]
        });
      }
      if (!targetId) continue;
      edges.push({
        source: sourceId, target: targetId, predicate: item.kind.toUpperCase(), plane: "code",
        evidence: [`${file.path}:${item.startLine}-${item.endLine}`]
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
  const path = entity.kind === "File" || entity.kind === "Document" ? entityPath(entity.naturalKey) : undefined;
  nodes.set(id, { id, kind: entity.kind, label: entity.label, description: entity.naturalKey, ...(path ? { path } : {}), evidence });
}

function projectionEntityId(entity: StoredAssertion["subject"]): string {
  if (entity.kind === "Repository") return "repo";
  if (entity.kind === "File" || entity.kind === "Document") return `file:${entityPath(entity.naturalKey)}`;
  return `entity:${stableId("node", entityKey(entity))}`;
}

function entityPath(naturalKey: string): string {
  const marker = ":path:";
  const index = naturalKey.indexOf(marker);
  return index >= 0 ? naturalKey.slice(index + marker.length) : naturalKey;
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
