import { evidenceExcerpt } from "../domain/evidence.js";
import { fingerprint, newId, normalizeRepository } from "../domain/fingerprint.js";
import type {
  QueryCitation,
  QueryContextRequest,
  QueryContextResponse,
  QueryPlan,
  QueryRoute,
  RetrievalCandidate,
  SynthesisOutput
} from "../domain/query.js";
import type { ContextEngineStore, QueryRunTelemetry } from "../ports/context-engine-store.js";
import type { ContextSynthesizer, ScopeAuthorizer } from "../ports/synthesizer.js";
import { verifySynthesisCitations } from "./citation-verifier.js";
import { detectSourceConflicts } from "./conflicts.js";
import { assembleEvidencePack } from "./evidence-pack.js";
import { fuseRetrievalCandidates, type FusedCandidate } from "./fusion.js";
import { planContextQuery } from "./planner.js";
import type { ContextRetriever } from "./retrievers/common.js";
import {
  ExactRetriever,
  KnowledgeRetriever,
  LexicalRetriever,
  LongContextRetriever,
  StructuredRetriever,
  TemporalRetriever
} from "./retrievers/documents.js";
import { HierarchyIndexRetriever } from "./retrievers/hierarchy.js";
import { StructuralRetriever } from "./retrievers/structural.js";
import { ExtractiveContextSynthesizer } from "./synthesis.js";

export class StoreScopeAuthorizer implements ScopeAuthorizer {
  constructor(private readonly store: ContextEngineStore) {}

  async authorize(input: {
    tenantId: string;
    principalId: string;
    repository: string;
    ref: string;
  }): Promise<{ allowed: boolean; allowedAclFingerprints: ReadonlySet<string>; reason?: string }> {
    const repositories = await this.store.repositoriesForPrincipal(input.tenantId, input.principalId);
    const allowed = repositories.includes(input.repository);
    const allowedAclFingerprints = allowed
      ? await this.store.aclFingerprintsForPrincipal(input.tenantId, input.principalId, input.repository)
      : [];
    return {
      allowed,
      allowedAclFingerprints: new Set(allowedAclFingerprints),
      ...(allowed ? {} : { reason: "principal does not have repository access" })
    };
  }
}

export class StaticScopeAuthorizer implements ScopeAuthorizer {
  constructor(
    private readonly entries: {
      tenantId: string;
      principalId: string;
      repository: string;
      aclFingerprints: string[];
    }[]
  ) {}

  async authorize(input: {
    tenantId: string;
    principalId: string;
    repository: string;
    ref: string;
  }): Promise<{ allowed: boolean; allowedAclFingerprints: ReadonlySet<string>; reason?: string }> {
    const entry = this.entries.find(
      (candidate) =>
        candidate.tenantId === input.tenantId &&
        candidate.principalId === input.principalId &&
        candidate.repository === input.repository
    );
    return {
      allowed: entry !== undefined,
      allowedAclFingerprints: new Set(entry?.aclFingerprints ?? []),
      ...(entry === undefined ? { reason: "principal does not have repository access" } : {})
    };
  }
}

export class QueryContextService {
  readonly #retrievers: Map<QueryRoute, ContextRetriever>;

  constructor(
    private readonly store: ContextEngineStore,
    private readonly authorizer: ScopeAuthorizer = new StoreScopeAuthorizer(store),
    private readonly synthesizer: ContextSynthesizer = new ExtractiveContextSynthesizer(),
    retrievers: ContextRetriever[] = [
      new ExactRetriever(),
      new StructuredRetriever(),
      new StructuralRetriever(),
      new LexicalRetriever(),
      new KnowledgeRetriever(),
      new TemporalRetriever(),
      new LongContextRetriever(),
      new HierarchyIndexRetriever()
    ]
  ) {
    this.#retrievers = new Map(retrievers.map((retriever) => [retriever.route, retriever]));
  }

  async query(request: QueryContextRequest): Promise<QueryContextResponse> {
    return (await this.queryWithTrace(request)).response;
  }

  async queryWithTrace(request: QueryContextRequest): Promise<{
    response: QueryContextResponse;
    telemetry: Pick<QueryRunTelemetry, "candidates" | "citations" | "routeMetrics">;
    plan: QueryPlan;
  }> {
    const repository = normalizeRepository(request.repository);
    const ref = request.ref ?? "main";
    const authorization = await this.authorizer.authorize({
      tenantId: request.tenantId,
      principalId: request.principalId,
      repository,
      ref
    });
    if (!authorization.allowed) throw new Error(authorization.reason ?? "Repository access denied");
    const latestAuthorizedGeneration = this.store.latestAuthorizedGeneration?.bind(this.store);
    const retrieveIndexed = this.store.retrieveIndexed?.bind(this.store);
    const useIndexedRetrieval = Boolean(latestAuthorizedGeneration && retrieveIndexed);
    const indexedGeneration = useIndexedRetrieval
      ? await latestAuthorizedGeneration!(request.tenantId, repository, ref, request.principalId)
      : undefined;
    const projection = useIndexedRetrieval
      ? undefined
      : await this.#latestForRepository(request.tenantId, repository, ref, request.principalId);
    const generation = indexedGeneration ?? projection?.generation;
    if (generation === undefined) throw new Error("No published context generation for the requested scope");
    const plan = planContextQuery({ ...request, repository, ref: generation.ref });
    if (
      generation.capabilities.dense === "available" &&
      this.#retrievers.has("dense") &&
      !plan.routes.some((route) => route.route === "dense")
    ) {
      plan.routes.push({
        route: "dense",
        reason: "published generation has an evaluated dense capability",
        limit: 20,
        timeoutMs: 1_000
      });
    }
    if (
      projection &&
      ["overview", "intent"].includes(plan.taskKind) &&
      projection.documents.some((document) => document.body.length >= 16_000) &&
      !plan.routes.some((route) => route.route === "long_context")
    ) {
      plan.routes.push({
        route: "long_context",
        reason: "eligible source exceeds the bounded fragment context",
        limit: 4,
        timeoutMs: 1_000
      });
    }
    const routeExecutions = await Promise.all(
      plan.routes.map(async (route) => {
        const started = Date.now();
        if (useIndexedRetrieval) {
          const candidates = await retrieveIndexed!({
            tenantId: request.tenantId,
            repository,
            principalId: request.principalId,
            generation,
            plan,
            route: route.route,
            limit: route.limit,
            allowedAclFingerprints: authorization.allowedAclFingerprints
          });
          return { route: route.route, candidates, durationMs: Math.max(0, Date.now() - started) };
        }
        const retriever = this.#retrievers.get(route.route);
        if (retriever === undefined || !projection) {
          return { route: route.route, candidates: [], durationMs: Math.max(0, Date.now() - started) };
        }
        const candidates = await retriever.retrieve({
          projection: projection,
          plan,
          allowedAclFingerprints: authorization.allowedAclFingerprints,
          route: route.route,
          limit: route.limit
        });
        return { route: route.route, candidates, durationMs: Math.max(0, Date.now() - started) };
      })
    );
    const lists = routeExecutions.map((execution) => execution.candidates);
    const temporallyScoped = lists.map((candidates) =>
      candidates.filter((candidate) => this.#withinTimeWindow(candidate, plan.timeWindow))
    );
    const fused = await this.#hydrateOriginalEvidence(
      generation.checkpointId,
      fuseRetrievalCandidates(temporallyScoped)
    );
    const candidates = fused.map((item) => item.candidate);
    const conflicts = detectSourceConflicts(candidates);
    const evidence = assembleEvidencePack(fused);
    let synthesis = await this.synthesizer.synthesize({
      request,
      evidence,
      conflicts: conflicts.map((conflict) => conflict.description)
    });
    let verification = verifySynthesisCitations(synthesis, evidence);
    if (!verification.valid) {
      synthesis = await this.synthesizer.synthesize({
        request,
        evidence,
        conflicts: conflicts.map((conflict) => conflict.description),
        repairErrors: verification.errors
      });
      verification = verifySynthesisCitations(synthesis, evidence);
    }
    if (!verification.valid) {
      synthesis = this.#failedSynthesis(
        evidence.items.map((item) => item.candidate),
        verification.errors
      );
    }
    const citations: QueryCitation[] = evidence.items.map((item) => ({
      id: item.citationId,
      title: item.title,
      excerpt: item.sourceText,
      anchors: item.candidate.anchors,
      authorityClass: item.candidate.authorityClass,
      sourceKind: item.candidate.sourceKind === "structure" ? "code" : item.candidate.sourceKind,
      sourceId: item.candidate.sourceId,
      ...(item.candidate.sourceRevisionId === undefined ? {} : { sourceRevisionId: item.candidate.sourceRevisionId })
    }));
    const used = [...new Set(candidates.map((candidate) => candidate.retriever))].sort();
    const missing = [...synthesis.missing];
    if (generation.capabilities.sourceCompleteness === "partial") {
      missing.push("source-completeness:partial");
    }
    for (const [kind, targets] of Object.entries(plan.targets)) {
      for (const target of targets) {
        if (
          !candidates.some((candidate) =>
            `${candidate.title}\n${candidate.excerpt}`.toLowerCase().includes(target.toLowerCase())
          )
        ) {
          missing.push(`${kind}:${target}`);
        }
      }
    }
    const response: QueryContextResponse = {
      answer: synthesis.answer,
      generation: {
        id: generation.id,
        ref: generation.ref,
        commitSha: generation.commitSha,
        derivedKnowledge: generation.capabilities.derivedKnowledge
      },
      citations,
      conflicts: conflicts.map((conflict) => ({
        ...conflict,
        citationIds: conflict.citationIds
          .map((candidateId) => evidence.items.find((item) => item.candidate.id === candidateId)?.citationId)
          .filter((value): value is string => value !== undefined)
      })),
      ambiguities: synthesis.ambiguities,
      coverage: {
        status: citations.length === 0 ? "insufficient" : missing.length > 0 ? "partial" : "complete",
        missing: [...new Set(missing)],
        retrieversUsed: used
      },
      traceId: newId("trace")
    };
    const finalAuthorization = await this.authorizer.authorize({
      tenantId: request.tenantId,
      principalId: request.principalId,
      repository,
      ref
    });
    if (
      !finalAuthorization.allowed ||
      !sameFingerprints(authorization.allowedAclFingerprints, finalAuthorization.allowedAclFingerprints)
    ) {
      throw new Error(finalAuthorization.reason ?? "Repository access changed while querying");
    }
    const fusedScores = new Map(
      fused.map((item) => [candidateIdentity(item.candidate), { score: item.score, selectedId: item.candidate.id }])
    );
    const candidateTelemetry = temporallyScoped
      .flat()
      .sort((left, right) => left.retriever.localeCompare(right.retriever) || left.id.localeCompare(right.id))
      .map((candidate, ordinal) => {
        const fusedResult = fusedScores.get(candidateIdentity(candidate));
        return {
          ordinal,
          candidateId: candidate.id,
          retriever: candidate.retriever,
          sourceKind: candidate.sourceKind,
          sourceId: candidate.sourceId,
          ...(candidate.sourceRevisionId ? { sourceRevisionId: candidate.sourceRevisionId } : {}),
          rawScore: candidate.rawScore,
          ...(fusedResult ? { fusedScore: fusedResult.score } : {}),
          selected: fusedResult !== undefined,
          diagnostics: {
            explanation: candidate.explanation,
            scoreSemantics: candidate.scoreSemantics,
            exactMatch: candidate.exactMatch,
            selectedRepresentative: fusedResult?.selectedId
          }
        };
      });
    const supportingCitationIds = new Set(synthesis.claims.flatMap((claim) => claim.citationIds));
    const citationTelemetry = citations.flatMap((citation) =>
      citation.anchors.map((anchor) => ({
        citation,
        anchor
      }))
    );
    return {
      response,
      plan,
      telemetry: {
        candidates: candidateTelemetry,
        citations: citationTelemetry.map(({ citation, anchor }, ordinal) => ({
          ordinal,
          citationId: citation.id,
          sourceKind: citation.sourceKind,
          sourceId: citation.sourceId,
          ...(citation.sourceRevisionId ? { sourceRevisionId: citation.sourceRevisionId } : {}),
          sourceAnchor: { ...anchor },
          contentDigest: anchor.contentDigest,
          accessible: true,
          digestValid: true,
          supportsClaim: supportingCitationIds.has(citation.id),
          diagnostics: {}
        })),
        routeMetrics: routeExecutions.map((execution) => ({
          route: execution.route,
          candidateCount: execution.candidates.length,
          durationMs: execution.durationMs
        }))
      }
    };
  }

  async #latestForRepository(tenantId: string, repository: string, ref: string, principalId: string) {
    const generations = await this.store.listGenerations(tenantId, repository);
    const latest = generations.find((generation) => generation.status === "published" && generation.ref === ref);
    if (latest === undefined) return undefined;
    return this.authorizer instanceof StoreScopeAuthorizer
      ? this.store.getAuthorizedGeneration(latest.id, principalId)
      : this.store.getGeneration(latest.id);
  }

  async #hydrateOriginalEvidence(checkpointId: string, fused: FusedCandidate[]): Promise<FusedCandidate[]> {
    return Promise.all(
      fused.map(async (item) => {
        if (!["knowledge", "structure"].includes(item.candidate.sourceKind)) return item;
        const excerpts: string[] = [];
        for (const anchor of item.candidate.anchors) {
          const record = await this.store.resolveAnchor(checkpointId, {
            tenantId: anchor.tenantId,
            repository: anchor.repository,
            sourceType: anchor.sourceType,
            sourceId: anchor.sourceId,
            ...(anchor.commitSha === undefined ? {} : { commitSha: anchor.commitSha }),
            ...(anchor.pathOrUrl === undefined ? {} : { pathOrUrl: anchor.pathOrUrl }),
            ...(anchor.startLine === undefined ? {} : { startLine: anchor.startLine }),
            ...(anchor.endLine === undefined ? {} : { endLine: anchor.endLine }),
            ...(anchor.jsonPointer === undefined ? {} : { jsonPointer: anchor.jsonPointer })
          });
          if (record === undefined || record.anchor.contentDigest !== anchor.contentDigest) continue;
          const sourceText = evidenceExcerpt(record, anchor);
          excerpts.push(
            [`Source: ${anchor.pathOrUrl ?? `${anchor.sourceType}:${anchor.sourceId}`}`, sourceText].join("\n")
          );
        }
        if (excerpts.length === 0) return item;
        const excerpt = excerpts.join("\n\n").slice(0, 4_000);
        return {
          ...item,
          candidate: {
            ...item.candidate,
            excerpt,
            contextualText: [item.candidate.contextualText, `Retrieved interpretation: ${item.candidate.excerpt}`]
              .filter(Boolean)
              .join("\n"),
            contentFingerprint: fingerprint({
              prior: item.candidate.contentFingerprint,
              originalEvidence: excerpt
            })
          }
        };
      })
    );
  }

  #withinTimeWindow(candidate: RetrievalCandidate, window: { from?: string; to?: string } | undefined): boolean {
    if ((!window?.from && !window?.to) || candidate.sourceKind !== "provider") return true;
    const observed = candidate.anchors
      .map((anchor) => anchor.observedAt)
      .filter((value): value is string => Boolean(value));
    return observed.some((value) => (!window.from || value >= window.from) && (!window.to || value <= window.to));
  }

  #failedSynthesis(candidates: RetrievalCandidate[], errors: string[]): SynthesisOutput {
    return {
      answer: `Synthesis failed citation verification. ${candidates.length} evidence item(s) were retrieved.`,
      claims: [],
      ambiguities: errors,
      missing: ["verified synthesis"]
    };
  }
}

function candidateIdentity(candidate: RetrievalCandidate): string {
  return `${candidate.sourceId}\u0000${candidate.sourceRevisionId ?? ""}\u0000${candidate.contentFingerprint}`;
}

function sameFingerprints(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
