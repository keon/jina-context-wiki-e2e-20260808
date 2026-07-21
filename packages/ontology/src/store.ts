import {
  createOntologyGraph,
  stableId,
  summarizeOntologyGraph,
  type OntologyEdge,
  type OntologyGraph,
  type OntologyGraphSummary,
  type OntologyNode,
  type OntologySourceEvidence
} from "./model.js";
import type { OntologyAssertionSummary, OntologyCommand, OntologyCommandResult, RepositoryContextOperations } from "./operations.js";
import type { OntologyOperationalMetrics, ProjectionRebuildResult } from "./outbox.js";
import { canonicalJson } from "./knowledge.js";
import {
  normalizeGitHubSourceObservation,
  type GitHubSourceObservation,
  type GitHubWorkItemObservation
} from "./normalizers.js";
import { ONTOLOGY_REGISTRY_VERSION, predicateDefinition } from "./registry.js";
import type { IssueTraceProjection, RetrievalRequest, RetrievalResult } from "./retrieval.js";
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
  type OntologySourceIngestResult,
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
  private readonly sourceAssertions = new Map<string, StoredAssertion>();
  private readonly repositoryAcl = new Map<string, Set<string>>();
  private readonly memoryAudit: OntologyCommandResult[] = [];
  private readonly githubObservations: GitHubSourceObservation[] = [];

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

  async applyGitHubObservations(observations: readonly GitHubSourceObservation[]): Promise<OntologySourceIngestResult> {
    let newObservationCount = 0;
    let updatedObservationCount = 0;
    let confirmedObservationCount = 0;
    for (const observation of observations) {
      const observationId = observation.kind === "codeowners"
        ? `${observation.repository}:codeowners:${observation.commitSha}:${observation.path}`
        : sourceGitHubObservationId(observation);
      const existingIndex = this.githubObservations.findIndex((candidate) => {
        if (candidate.tenantId !== observation.tenantId || candidate.repository !== observation.repository || candidate.kind !== observation.kind) return false;
        if (candidate.kind === "codeowners" && observation.kind === "codeowners") return candidate.commitSha === observation.commitSha && candidate.path === observation.path;
        return candidate.kind !== "codeowners" && observation.kind !== "codeowners" && candidate.number === observation.number && sourceGitHubObservationId(candidate) === observationId;
      });
      if (existingIndex >= 0) {
        confirmedObservationCount += 1;
        continue;
      }
      const hasPriorVersion = this.githubObservations.some((candidate) =>
        candidate.tenantId === observation.tenantId && candidate.repository === observation.repository && candidate.kind === observation.kind && (
          candidate.kind === "codeowners" || observation.kind === "codeowners" || candidate.number === observation.number
        )
      );
      if (hasPriorVersion) updatedObservationCount += 1;
      else newObservationCount += 1;
      this.githubObservations.push(structuredClone(observation));
    }
    this.rebuildSourceAssertions();
    return {
      observationCount: observations.length,
      observationIds: [...new Set(observations.map(sourceObservationIdForGitHub))],
      assertionCount: observations.reduce((count, observation) => count + normalizeGitHubSourceObservation(observation).assertions.length, 0),
      newObservationCount,
      updatedObservationCount,
      confirmedObservationCount
    };
  }

  async loadAssertionEvidence(
    tenantId: string,
    repository: string,
    observationIds: readonly string[]
  ): Promise<readonly OntologySourceEvidence[]> {
    const requested = new Set(observationIds);
    const evidence = this.githubObservations.flatMap((observation) => {
      const id = sourceObservationIdForGitHub(observation);
      if (!requested.has(id) || observation.tenantId !== tenantId || observation.repository !== repository) return [];
      const payload = structuredClone(observation);
      return [{
        id,
        source: "github",
        type: "source_snapshot",
        repository,
        payloadSha: stableId("sha", JSON.stringify(payload)),
        payload
      }];
    });
    if (evidence.length !== requested.size) throw new Error("assertion evidence observation was not found");
    return evidence.sort((left, right) => left.id.localeCompare(right.id));
  }

  async hasAssertionGeneration(
    tenantId: string,
    repository: string,
    commitSha: string,
    generatorVersion: string,
    registryVersion: string,
    evidenceFingerprint: string
  ): Promise<OntologyAssertionResult | undefined> {
    const stored = this.assertionBatches.get(
      assertionKey(tenantId, repository, commitSha, generatorVersion, registryVersion, evidenceFingerprint)
    );
    return stored ? assertionResult(stored.batch, stored.assertions, true) : undefined;
  }

  async saveAssertionBatch(batch: OntologyAssertionBatch): Promise<OntologyAssertionResult> {
    const key = assertionKey(batch.tenantId, batch.repository, batch.commitSha, batch.generatorVersion, batch.registryVersion, batch.evidenceFingerprint);
    const existing = this.assertionBatches.get(key);
    if (existing) return assertionResult(existing.batch, existing.assertions, true);
    const normalized = normalizeAssertionBatchLenient(batch);
    const prior = new Map(this.allAssertions()
      .filter((assertion) => assertion.tenantId === batch.tenantId && assertion.repository === batch.repository)
      .filter((assertion) => assertion.status === "active" || assertion.status === "proposed")
      .map((assertion) => [storedAssertionNaturalKey(assertion), assertion]));
    const assertions = normalized.assertions.map((assertion) => {
      const existingAssertion = prior.get(storedAssertionNaturalKey(assertion));
      return existingAssertion
        ? { ...existingAssertion, lastConfirmedAt: batch.generatedAt }
        : assertion;
    });
    this.assertionBatches.set(key, { batch: structuredClone(batch), assertions });
    return assertionResult(batch, assertions, false, normalized.warnings);
  }

  async project(request: OntologyProjectionRequest): Promise<OntologyGraph> {
    const snapshot = this.snapshots.get(snapshotKey(request.tenantId, request.repository, request.commitSha));
    if (!snapshot) throw new Error("cannot project an ontology before repository ingestion");
    const assertions = dedupeApplicableAssertions(this.allAssertions()
      .filter((assertion) => assertion.tenantId === request.tenantId && assertion.repository === request.repository)
      .filter((assertion) => assertion.status === "active")
      .filter((assertion) => {
        if (assertion.commitSha === "source") return true;
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
      proposedAssertionCount: this.allAssertions()
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

  async listAssertions(
    tenantId: string,
    repository: string,
    filter: { readonly status?: StoredAssertion["status"]; readonly predicate?: string } = {}
  ): Promise<readonly OntologyAssertionSummary[]> {
    return this.allAssertions()
      .filter((assertion) => assertion.tenantId === tenantId && assertion.repository === repository)
      .filter((assertion) => !filter.status || assertion.status === filter.status)
      .filter((assertion) => !filter.predicate || assertion.predicate === filter.predicate)
      .map((assertion) => ({
        id: assertion.id,
        repository: assertion.repository,
        commitSha: assertion.commitSha,
        subjectKind: assertion.subject.kind,
        subjectNaturalKey: assertion.subject.naturalKey,
        subjectLabel: assertion.subject.label,
        predicate: assertion.predicate,
        objectKind: assertion.object.kind,
        objectNaturalKey: assertion.object.naturalKey,
        objectLabel: assertion.object.label,
        status: assertion.status,
        ...(assertion.confidence !== undefined ? { confidence: assertion.confidence } : {}),
        evidence: assertion.evidence,
        qualifiers: assertion.qualifiers ?? {},
        generator: assertion.commitSha === "source" ? "source:github" : `model:${assertion.generatorVersion}`,
        registryVersion: assertion.registryVersion
      }));
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    if (!request.allowedRepositories.includes(request.repository)) throw new Error("repository access denied");
    const limit = Math.max(1, Math.min(request.limit ?? 50, 200));
    const snapshot = [...this.snapshots.values()]
      .filter((value) => value.tenantId === request.tenantId && value.repository === request.repository && value.updateRef !== false && (!request.ref || value.ref === request.ref))
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
    const hasCurrentProjection = Boolean(snapshot && [...this.graphs.values()].some((graph) =>
      graph.tenantId === request.tenantId && graph.repository === request.repository &&
      graph.ref === snapshot.ref && graph.commitSha === snapshot.commitSha
    ));
    const currentAssertions = snapshot && hasCurrentProjection
      ? this.allAssertions().filter((assertion) => assertionIsCurrentForSnapshot(assertion, snapshot, this.snapshots))
      : [];
    const items = request.template === "issue_trace"
      ? memoryIssueTraceItems(
          request,
          this.githubObservations,
          this.snapshots,
          currentAssertions,
          [...this.assertionBatches.values()].map((stored) => stored.batch)
        )
      : request.template === "feature_trace"
        ? memoryFeatureTraceItems(request, currentAssertions)
      : memoryRetrievalItems(request, snapshot, this.blobAnalyses, this.allAssertions());
    return {
      template: request.template, repository: request.repository, ref: request.ref ?? snapshot?.ref ?? "main",
      items: items.slice(0, limit), truncated: items.length > limit, totalBeforeLimit: items.length, limit
    };
  }

  private allAssertions(): StoredAssertion[] {
    const assertions = [
      ...this.sourceAssertions.values(),
      ...[...this.assertionBatches.values()].flatMap((stored) => stored.assertions)
    ];
    const byId = new Map<string, StoredAssertion>();
    for (const assertion of assertions) {
      const current = byId.get(assertion.id);
      if (!current || current.lastConfirmedAt < assertion.lastConfirmedAt) byId.set(assertion.id, assertion);
    }
    return [...byId.values()];
  }

  private rebuildSourceAssertions(): void {
    this.sourceAssertions.clear();
    for (const observation of latestMemorySourceObservations(this.githubObservations)) {
      const normalized = normalizeGitHubSourceObservation(observation);
      const observationId = sourceObservationIdForGitHub(observation);
      for (const intent of normalized.assertions) {
        const subjectId = stableId("entity", `${observation.tenantId}:${intent.subject.kind}:${intent.subject.key}`);
        const objectId = stableId("entity", `${observation.tenantId}:${intent.object.kind}:${intent.object.key}`);
        const qualifiers = intent.qualifiers ?? {};
        const assertionId = stableId(
          "assertion",
          `${observation.tenantId}:${observation.repository}:${subjectId}:${intent.predicate}:${objectId}:${stableId("q", canonicalJson(qualifiers))}`
        );
        this.sourceAssertions.set(assertionId, {
          id: assertionId,
          tenantId: observation.tenantId,
          repository: observation.repository,
          commitSha: "source",
          subject: { kind: intent.subject.kind, naturalKey: intent.subject.key, label: intent.subject.displayName },
          predicate: intent.predicate,
          object: { kind: intent.object.kind, naturalKey: intent.object.key, label: intent.object.displayName },
          status: "active",
          confidence: 1,
          evidence: [],
          sourceObservationId: observationId,
          qualifiers,
          lastConfirmedAt: observation.recordedAt,
          generatorVersion: "github-normalizer-v1",
          registryVersion: ONTOLOGY_REGISTRY_VERSION,
          recordedAt: observation.recordedAt
        });
      }
    }
  }
}

function memoryIssueTraceItems(
  request: RetrievalRequest,
  observations: readonly GitHubSourceObservation[],
  snapshots: ReadonlyMap<string, RepositorySnapshot>,
  assertions: readonly StoredAssertion[],
  batches: readonly OntologyAssertionBatch[]
): RetrievalResult["items"] {
  const scoped = latestMemorySourceObservations(observations).filter((observation): observation is GitHubWorkItemObservation =>
    observation.tenantId === request.tenantId && observation.repository === request.repository && observation.kind !== "codeowners"
  );
  const active = assertions.filter((assertion) =>
    assertion.tenantId === request.tenantId && assertion.repository === request.repository && assertion.status === "active"
  );
  const resolutionAssertions = active.filter((assertion) =>
    assertion.predicate === "RESOLVES" && assertion.subject.kind === "PullRequest" && assertion.object.kind === "Issue"
  );
  const batchesByObservationId = new Map(batches.map((batch) => [assertionObservationId(batch), batch]));
  const candidates = new Map<string, {
    readonly naturalKey: string;
    readonly label: string;
    readonly description?: string;
    readonly observation?: GitHubWorkItemObservation;
  }>();
  for (const observation of scoped) {
    if (observation.kind !== "issue") continue;
    const naturalKey = `github:issue:${request.repository}#${observation.number}`;
    candidates.set(naturalKey, { naturalKey, label: observation.title, observation });
  }
  for (const assertion of [...resolutionAssertions, ...active.filter((item) => item.predicate === "INTRODUCED_BY")]) {
    const issue = assertion.predicate === "RESOLVES" ? assertion.object : assertion.subject;
    if (issue.kind !== "Issue" || candidates.has(issue.naturalKey)) continue;
    const batch = assertion.sourceObservationId ? batchesByObservationId.get(assertion.sourceObservationId) : undefined;
    const description = batch ? derivedIssueDescriptionFromBatch(batch, issue.naturalKey) : undefined;
    candidates.set(issue.naturalKey, { naturalKey: issue.naturalKey, label: issue.label, ...(description ? { description } : {}) });
  }
  const issueText = request.issueText?.trim().toLowerCase();
  const commitPrefix = request.commitSha?.toLowerCase();
  const selected = [...candidates.values()].find((candidate) => {
    const entityId = stableId("entity", `${request.tenantId}:Issue:${candidate.naturalKey}`);
    const number = /^github:issue:.*#(\d+)$/.exec(candidate.naturalKey)?.[1];
    if (request.issueEntityId) return entityId === request.issueEntityId;
    if (request.issueNumber) return Number.parseInt(number ?? "", 10) === request.issueNumber;
    if (issueText) {
      return candidate.label.toLowerCase().includes(issueText) || candidate.description?.toLowerCase().includes(issueText) === true ||
        candidate.observation?.body?.toLowerCase().includes(issueText) === true;
    }
    if (request.pullRequestNumber) {
      return resolutionAssertions.some((assertion) =>
        assertion.object.naturalKey === candidate.naturalKey && numberFromEntityNaturalKey(assertion.subject.naturalKey) === request.pullRequestNumber
      );
    }
    if (commitPrefix) {
      const caused = active.some((assertion) =>
        assertion.predicate === "INTRODUCED_BY" && assertion.subject.naturalKey === candidate.naturalKey &&
        shaFromEntityNaturalKey(assertion.object.naturalKey)?.startsWith(commitPrefix)
      );
      const resolved = resolutionAssertions.some((resolution) =>
        resolution.object.naturalKey === candidate.naturalKey && active.some((inclusion) =>
          (inclusion.predicate === "INCLUDES" || inclusion.predicate === "MERGED_AS") &&
          inclusion.subject.naturalKey === resolution.subject.naturalKey &&
          shaFromEntityNaturalKey(inclusion.object.naturalKey)?.startsWith(commitPrefix)
        )
      );
      return caused || resolved;
    }
    return false;
  });
  if (!selected) return [];
  const issueNumberText = /^github:issue:.*#(\d+)$/.exec(selected.naturalKey)?.[1];
  const issueNumber = issueNumberText ? Number.parseInt(issueNumberText, 10) : undefined;
  const issueEntityId = stableId("entity", `${request.tenantId}:Issue:${selected.naturalKey}`);
  const citations: IssueTraceProjection["citations"][number][] = [{ kind: "entity", id: issueEntityId, repository: request.repository }];
  if (selected.observation) citations.push({
    kind: "observation", id: sourceGitHubObservationId(selected.observation), repository: request.repository
  });
  const resolutions = resolutionAssertions.filter((assertion) => assertion.object.naturalKey === selected.naturalKey).flatMap((resolution) => {
    const pullRequestNumber = numberFromEntityNaturalKey(resolution.subject.naturalKey);
    if (!pullRequestNumber) return [];
    const pullRequest = scoped.find((observation) => observation.kind === "pull_request" && observation.number === pullRequestNumber);
    citations.push({ kind: "assertion", id: resolution.id, repository: request.repository });
    if (resolution.sourceObservationId) citations.push({ kind: "observation", id: resolution.sourceObservationId, repository: request.repository });
    if (pullRequest) citations.push({ kind: "observation", id: sourceGitHubObservationId(pullRequest), repository: request.repository });
    const inclusions = active.filter((assertion) =>
      (assertion.predicate === "INCLUDES" || assertion.predicate === "MERGED_AS") && assertion.subject.naturalKey === resolution.subject.naturalKey
    );
    const shas = new Map<string, "merge" | "included">();
    for (const inclusion of inclusions) {
      const sha = shaFromEntityNaturalKey(inclusion.object.naturalKey);
      if (!sha) continue;
      shas.set(sha, inclusion.predicate === "MERGED_AS" ? "merge" : shas.get(sha) ?? "included");
      citations.push({ kind: "assertion", id: inclusion.id, repository: request.repository });
    }
    const commits = [...shas].map((sha) => {
      const [commitSha, role] = sha;
      const snapshot = snapshots.get(snapshotKey(request.tenantId, request.repository, commitSha));
      const parent = snapshot?.parents[0] ? snapshots.get(snapshotKey(request.tenantId, request.repository, snapshot.parents[0]!)) : undefined;
      const changes = snapshot ? computeCommitChanges(snapshot.files, parent?.files).map((change) => ({
        commitSha, path: change.path, change: change.change, ...(change.oldPath ? { oldPath: change.oldPath } : {})
      })) : [];
      for (const change of changes) citations.push({
        kind: "commit_change", id: `${commitSha}:${change.path}`, repository: request.repository, commitSha, path: change.path
      });
      return {
        sha: commitSha,
        url: `https://github.com/${request.repository}/commit/${commitSha}`,
        role,
        changes
      };
    });
    return [{
      pullRequestNumber,
      title: pullRequest?.title ?? resolution.subject.label,
      url: pullRequest?.url ?? `https://github.com/${request.repository}/pull/${pullRequestNumber}`,
      commits,
      assertionIds: [resolution.id, ...inclusions.map((assertion) => assertion.id)],
      observationIds: [...new Set([resolution.sourceObservationId, pullRequest ? sourceGitHubObservationId(pullRequest) : undefined]
        .filter((id): id is string => Boolean(id)))]
    }];
  });
  const introducedBy = active.filter((assertion) =>
    assertion.predicate === "INTRODUCED_BY" && assertion.subject.naturalKey === selected.naturalKey
  ).flatMap((assertion) => {
    const sha = shaFromEntityNaturalKey(assertion.object.naturalKey);
    if (!sha) return [];
    citations.push({ kind: "assertion", id: assertion.id, repository: request.repository, commitSha: assertion.commitSha });
    const pullRequestAssertions = assertions.filter((candidate) =>
      candidate.tenantId === request.tenantId && candidate.repository === request.repository && candidate.status === "active" &&
      candidate.predicate === "INCLUDES" && candidate.object.naturalKey === assertion.object.naturalKey
    );
    const pullRequestsForCause = pullRequestAssertions.flatMap((candidate) => {
      const number = /#(\d+)$/.exec(candidate.subject.naturalKey)?.[1];
      if (!number) return [];
      citations.push({ kind: "assertion", id: candidate.id, repository: request.repository });
      const observed = scoped.find((item) => item.kind === "pull_request" && item.number === Number.parseInt(number, 10));
      return [{
        number: Number.parseInt(number, 10),
        title: observed?.title ?? candidate.subject.label,
        url: observed?.url ?? `https://github.com/${request.repository}/pull/${number}`
      }];
    });
    const snapshot = snapshots.get(snapshotKey(request.tenantId, request.repository, sha));
    const parent = snapshot?.parents[0] ? snapshots.get(snapshotKey(request.tenantId, request.repository, snapshot.parents[0]!)) : undefined;
    const changes = snapshot ? computeCommitChanges(snapshot.files, parent?.files).map((change) => ({
      commitSha: sha, path: change.path, change: change.change, ...(change.oldPath ? { oldPath: change.oldPath } : {})
    })) : [];
    const reason = typeof assertion.qualifiers?.reason === "string" ? assertion.qualifiers.reason : undefined;
    return [{
      sha,
      url: `https://github.com/${request.repository}/commit/${sha}`,
      role: "introduced" as const,
      changes,
      ...(reason ? { why: reason } : {}),
      evidence: assertion.evidence,
      evidenceCommitSha: assertion.commitSha,
      assertionIds: [assertion.id],
      pullRequests: pullRequestsForCause
    }];
  });
  const payload: IssueTraceProjection = {
    issue: {
      entityId: issueEntityId,
      origin: issueNumber ? "github" : "derived",
      displayId: issueNumber ? `#${issueNumber}` : "virtual",
      ...(issueNumber ? { number: issueNumber } : {}),
      title: selected.observation?.title ?? selected.label,
      ...(selected.description ? { description: selected.description } : {}),
      ...(selected.observation?.url ? { url: selected.observation.url } : {}),
      ...(selected.observation?.state ? { state: selected.observation.state } : {})
    },
    resolutions,
    introducedBy,
    citations
  };
  const first = resolutions[0];
  const issueLabel = payload.issue.displayId ? `Issue ${payload.issue.displayId}` : payload.issue.title;
  return [{
    kind: "issue_trace",
    title: first
      ? `${issueLabel} → PR #${first.pullRequestNumber}${first.commits[0] ? ` → ${first.commits[0].sha.slice(0, 12)}` : ""}`
      : `${issueLabel} has no verified commit relationship`,
    data: payload as unknown as Readonly<Record<string, unknown>>,
    citations,
    score: first ? 3 : 1
  }];
}

function numberFromEntityNaturalKey(naturalKey: string): number | undefined {
  const value = /#(\d+)$/.exec(naturalKey)?.[1];
  return value ? Number.parseInt(value, 10) : undefined;
}

function derivedIssueDescriptionFromBatch(batch: OntologyAssertionBatch, issueNaturalKey: string): string | undefined {
  const resolution = batch.assertions.find((assertion) =>
    assertion.predicate === "RESOLVES" && assertion.object.naturalKey === issueNaturalKey
  );
  const pullRequestNumber = resolution ? numberFromEntityNaturalKey(resolution.subject.naturalKey) : undefined;
  if (!pullRequestNumber) return undefined;
  return batch.rawOutput.nodes.find((node) =>
    node.kind === "Issue" && node.id === `virtual:pr:${pullRequestNumber}`
  )?.description;
}

function shaFromEntityNaturalKey(naturalKey: string): string | undefined {
  return /:sha:([a-f0-9]{40})$/i.exec(naturalKey)?.[1]?.toLowerCase();
}

function memoryFeatureTraceItems(
  request: RetrievalRequest,
  assertions: readonly StoredAssertion[]
): RetrievalResult["items"] {
  const query = request.featureText?.trim().toLowerCase() ?? "";
  if (!query) return [];
  return assertions.filter((assertion) => {
    if (
      assertion.tenantId !== request.tenantId || assertion.repository !== request.repository || assertion.status !== "active" ||
      !["IMPLEMENTS", "DOCUMENTED_BY", "LIKELY_AFFECTS", "REFERENCES"].includes(assertion.predicate)
    ) return false;
    const feature = assertion.subject.kind === "Feature"
      ? assertion.subject
      : assertion.object.kind === "Feature"
        ? assertion.object
        : undefined;
    return Boolean(feature && (feature.label.toLowerCase().includes(query) || feature.naturalKey.toLowerCase().includes(query)));
  }).map((assertion) => featureRelationshipItem(assertion));
}

function featureRelationshipItem(assertion: StoredAssertion): RetrievalResult["items"][number] {
  const featureIsSubject = assertion.subject.kind === "Feature";
  const feature = featureIsSubject ? assertion.subject : assertion.object;
  const related = featureIsSubject ? assertion.object : assertion.subject;
  const title = assertion.predicate === "IMPLEMENTS"
    ? `${related.label} implements ${feature.label}`
    : assertion.predicate === "DOCUMENTED_BY"
      ? `${feature.label} is documented by ${related.label}`
      : assertion.predicate === "LIKELY_AFFECTS"
        ? `${related.label} may affect ${feature.label}`
        : `${related.label} references ${feature.label}`;
  const citations: RetrievalResult["items"][number]["citations"][number][] = [{
    kind: "assertion", id: assertion.id, repository: assertion.repository,
    ...(/^[a-f0-9]{40}$/i.test(assertion.commitSha) ? { commitSha: assertion.commitSha } : {})
  }];
  if (assertion.sourceObservationId) citations.push({
    kind: "observation", id: assertion.sourceObservationId, repository: assertion.repository
  });
  if (/^[a-f0-9]{40}$/i.test(assertion.commitSha)) {
    for (const value of assertion.evidence) {
      const match = /^(.*):(\d+)(?:-(\d+))?$/.exec(value);
      if (!match?.[1] || !match[2]) continue;
      citations.push({
        kind: "code", id: `${assertion.commitSha}:${value}`, repository: assertion.repository,
        commitSha: assertion.commitSha, path: match[1], startLine: Number.parseInt(match[2], 10),
        endLine: Number.parseInt(match[3] ?? match[2], 10)
      });
    }
  }
  return {
    kind: "feature_relationship",
    title,
    data: {
      feature: { kind: feature.kind, naturalKey: feature.naturalKey, label: feature.label },
      related: { kind: related.kind, naturalKey: related.naturalKey, label: related.label },
      predicate: assertion.predicate
    },
    citations,
    score: assertion.confidence
  };
}

function latestMemorySourceObservations(observations: readonly GitHubSourceObservation[]): GitHubSourceObservation[] {
  const latest = new Map<string, GitHubSourceObservation>();
  for (const observation of observations) {
    const key = observation.kind === "codeowners"
      ? `${observation.tenantId}:${observation.repository}:codeowners`
      : `${observation.tenantId}:${observation.repository}:${observation.kind}:${observation.number}`;
    const current = latest.get(key);
    const version = observation.kind === "codeowners" ? observation.recordedAt : observation.occurredAt ?? observation.recordedAt;
    const currentVersion = current
      ? current.kind === "codeowners" ? current.recordedAt : current.occurredAt ?? current.recordedAt
      : undefined;
    if (!current || !currentVersion || version > currentVersion || (version === currentVersion && observation.recordedAt > current.recordedAt)) {
      latest.set(key, observation);
    }
  }
  return [...latest.values()];
}

function sourceObservationIdForGitHub(observation: GitHubSourceObservation): string {
  if (observation.kind !== "codeowners") return sourceGitHubObservationId(observation);
  const externalId = `${observation.repository}:codeowners:${observation.commitSha}:${observation.path}`;
  return stableId("observation", `${observation.tenantId}:github:${externalId}`);
}

function sourceGitHubObservationId(observation: GitHubWorkItemObservation): string {
  const externalId = `${observation.repository}:${observation.kind}:${observation.number}:${observation.occurredAt ?? observation.recordedAt}`;
  return stableId("observation", `${observation.tenantId}:github:${externalId}`);
}

function memoryRetrievalItems(
  request: RetrievalRequest,
  snapshot: RepositorySnapshot | undefined,
  analyses: ReadonlyMap<string, BlobAnalysis>,
  assertions: readonly StoredAssertion[]
): RetrievalResult["items"] {
  if (request.template === "structure") {
    if (!snapshot) return [];
    return snapshot.files.filter((file) => !request.path || file.path === request.path).flatMap((file) => {
      const analysis = analyses.get(blobKey(snapshot.tenantId, file.blobSha, ONTOLOGY_PARSER_VERSION));
      const definitions = (analysis?.symbols ?? []).filter((symbol) =>
        !request.symbol || symbol.name.toLowerCase() === request.symbol.toLowerCase() || symbol.moniker.toLowerCase().includes(request.symbol.toLowerCase())
      ).map((symbol) => ({
        kind: "symbol_definition", title: `${symbol.name} is ${symbol.kind} in ${file.path}`,
        data: { moniker: symbol.moniker, name: symbol.name, symbolKind: symbol.kind, path: file.path }, score: 2,
        citations: [{ kind: "code" as const, id: `${file.blobSha}:${symbol.startLine}:${symbol.moniker}`, repository: request.repository, commitSha: snapshot.commitSha, path: file.path, startLine: symbol.startLine, endLine: symbol.endLine }]
      }));
      const relationships = (analysis?.edges ?? []).filter((edge) => !request.symbol || edge.fromMoniker.includes(request.symbol) || edge.toMoniker.includes(request.symbol)).map((edge) => ({
        kind: edge.kind, title: `${edge.fromMoniker} ${edge.kind} ${edge.toMoniker}`,
        data: { fromMoniker: edge.fromMoniker, toMoniker: edge.toMoniker, path: file.path }, score: 1,
        citations: [{ kind: "code" as const, id: `${file.blobSha}:${edge.startLine}`, repository: request.repository, commitSha: snapshot.commitSha, path: file.path, startLine: edge.startLine, endLine: edge.endLine }]
      }));
      return [...definitions, ...relationships];
    });
  }
  if (request.template === "change") {
    if (!snapshot) return [];
    return computeCommitChanges(snapshot.files, []).map((change) => ({
      kind: "commit_change", title: `${change.change} ${change.path}`, data: { ...change }, score: 1,
      citations: [{ kind: "commit_change" as const, id: `${snapshot.commitSha}:${change.path}`, repository: request.repository, commitSha: snapshot.commitSha, path: change.path }]
    }));
  }
  if (request.template === "ownership") {
    const target = request.path ?? request.symbol;
    return assertions.filter((assertion) =>
      assertion.tenantId === request.tenantId && assertion.repository === request.repository &&
      assertion.predicate === "OWNED_BY" && assertion.status === "active" && (
        !target || assertion.subject.naturalKey.includes(target) ||
        (typeof assertion.qualifiers?.pattern === "string" && memoryCodeownersPatternMatches(assertion.qualifiers.pattern, target))
      )
    ).map((assertion) => ({
      kind: "ownership", title: `${assertion.subject.label} owned by ${assertion.object.label}`,
      data: { subject: assertion.subject, object: assertion.object, qualifiers: assertion.qualifiers ?? {} }, score: 1,
      citations: [{ kind: "assertion" as const, id: assertion.id, repository: request.repository, commitSha: assertion.commitSha }]
    }));
  }
  return assertions.filter((assertion) =>
    assertion.tenantId === request.tenantId && assertion.repository === request.repository && assertion.status === "active"
  ).map((assertion) => ({
    kind: "intent", title: `${assertion.subject.label} ${assertion.predicate} ${assertion.object.label}`,
    data: { predicate: assertion.predicate }, score: assertion.confidence,
    citations: [{ kind: "assertion" as const, id: assertion.id, repository: request.repository, commitSha: assertion.commitSha }]
  }));
}

function memoryCodeownersPatternMatches(rawPattern: string, path: string): boolean {
  const pattern = rawPattern.trim();
  if (!pattern || pattern.startsWith("!")) return false;
  const anchored = pattern.startsWith("/");
  const normalized = pattern.replace(/^\//, "").replace(/\/$/, "/**");
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\uE000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\uE000/g, ".*");
  if (!anchored && !normalized.includes("/")) return new RegExp(`(?:^|/)${escaped}$`).test(path);
  return new RegExp(`^${escaped}$`).test(path);
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
    const evidence = projectionEvidence(assertion);
    const source = projectionEntityId(assertion.subject);
    const target = projectionEntityId(assertion.object);
    ensureAssertionNode(nodes, source, assertion.subject, evidence);
    ensureAssertionNode(nodes, target, assertion.object, evidence);
    edges.push({
      source,
      target,
      predicate: assertion.predicate,
      plane: "knowledge",
      confidence: assertion.confidence,
      ...(Object.keys(assertion.qualifiers ?? {}).length > 0 ? { qualifiers: assertion.qualifiers } : {}),
      ...(assertion.predicate === "INTRODUCED_BY" && typeof assertion.qualifiers?.reason === "string"
        ? { why: assertion.qualifiers.reason }
        : {}),
      evidence
    });
  }
  return createOntologyGraph({
    request: { tenantId: request.tenantId, repository: request.repository, ref: request.ref, commitSha: request.commitSha, taskId: request.taskId },
    commitSha: request.commitSha,
    generatedAt: request.generatedAt,
    executor: "projection",
    model: ONTOLOGY_PROJECTION_VERSION,
    contentAddressed: true,
    generated: {
      summary: `Projected ${files.length} files, ${[...nodes.values()].filter((node) => node.kind === "Symbol").length} symbols, and ${assertions.length} active semantic assertions from canonical Ontology data.`,
      nodes: [...nodes.values()],
      edges
    }
  });
}

function projectionEvidence(assertion: StoredAssertion): readonly string[] {
  if (assertion.evidence.length > 0) return assertion.evidence;
  if (assertion.commitSha === "source" && assertion.sourceObservationId) {
    return [`observation:${assertion.sourceObservationId}`];
  }
  throw new Error(`active assertion ${assertion.id} has no projection evidence`);
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
    knowledgeCheckpoint: knowledgeCheckpoint(
      batch.tenantId,
      batch.repository,
      batch.commitSha,
      batch.generatorVersion,
      batch.registryVersion,
      batch.evidenceFingerprint
    ),
    cached,
    warnings
  };
}

function snapshotKey(tenantId: string, repository: string, commitSha: string): string { return `${tenantId}:${repository}:${commitSha}`; }
function blobKey(tenantId: string, blobSha: string, parserVersion: string): string { return `${tenantId}:${blobSha}:${parserVersion}`; }
function assertionKey(
  tenantId: string,
  repository: string,
  commitSha: string,
  generatorVersion: string,
  registryVersion: string,
  evidenceFingerprint: string
): string {
  return `${tenantId}:${repository}:${commitSha}:${generatorVersion}:${registryVersion}:${evidenceFingerprint}`;
}
function storedAssertionNaturalKey(assertion: StoredAssertion): string {
  return `${assertion.repository}:${entityKey(assertion.subject)}:${assertion.predicate}:${entityKey(assertion.object)}:${canonicalJson(assertion.qualifiers ?? {})}`;
}
function dedupeApplicableAssertions(assertions: readonly StoredAssertion[]): readonly StoredAssertion[] {
  const selected = new Map<string, StoredAssertion>();
  for (const assertion of assertions) {
    const key = `${entityKey(assertion.subject)}:${assertion.predicate}:${entityKey(assertion.object)}:${canonicalJson(assertion.qualifiers ?? {})}`;
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
function assertionIsCurrentForSnapshot(
  assertion: StoredAssertion,
  current: RepositorySnapshot,
  snapshots: ReadonlyMap<string, RepositorySnapshot>
): boolean {
  if (assertion.tenantId !== current.tenantId || assertion.repository !== current.repository || assertion.status !== "active") return false;
  if (assertion.commitSha === "source") return assertion.evidence.length === 0 && Boolean(assertion.sourceObservationId);
  const source = snapshots.get(snapshotKey(assertion.tenantId, assertion.repository, assertion.commitSha));
  return Boolean(source && assertion.evidence.length > 0 && assertionEvidenceIsCurrent(assertion, source, current));
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
