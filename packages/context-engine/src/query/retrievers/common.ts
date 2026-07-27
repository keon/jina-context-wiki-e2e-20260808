import { fingerprint, stableId } from "../../domain/fingerprint.js";
import type { QueryPlan, QueryRoute, RetrievalCandidate } from "../../domain/query.js";
import type { ContextDocument, GenerationProjection } from "../../domain/projection.js";
import { tokenizeContext } from "../../index/lexical.js";

export interface RetrieverInput {
  projection: GenerationProjection;
  plan: QueryPlan;
  allowedAclFingerprints: ReadonlySet<string>;
  route: QueryRoute;
  limit: number;
}

export interface ContextRetriever {
  readonly route: QueryRoute;
  retrieve(input: RetrieverInput): Promise<RetrievalCandidate[]>;
}

export function aclAllows(document: ContextDocument, allowed: ReadonlySet<string>): boolean {
  const required = Array.isArray(document.metadata.requiredAclFingerprints)
    ? document.metadata.requiredAclFingerprints.filter((value): value is string => typeof value === "string")
    : [document.effectiveAclFingerprint];
  return required.every((fingerprintValue) => allowed.has(fingerprintValue));
}

export function documentCandidate(
  document: ContextDocument,
  route: QueryRoute,
  excerpt: string,
  rawScore: number,
  exactMatch: boolean,
  explanation: string
): RetrievalCandidate {
  return {
    id: stableId("rc", { route, documentId: document.id, excerpt }),
    retriever: route,
    documentId: document.id,
    sourceKind: document.sourceKind,
    sourceId: document.sourceId,
    ...(document.sourceRevisionId === undefined ? {} : { sourceRevisionId: document.sourceRevisionId }),
    title: document.title,
    excerpt,
    contextualText: document.contextualText,
    anchors: document.anchors,
    rawScore,
    scoreSemantics: route === "exact" ? "matched query tokens" : "normalized token overlap",
    exactMatch,
    authorityClass: document.authorityClass,
    effectiveAclFingerprint: document.effectiveAclFingerprint,
    contentFingerprint: fingerprint({ sourceFingerprint: document.sourceFingerprint, excerpt }),
    explanation,
    metadata: document.metadata
  };
}

export function overlapScore(query: string, text: string): number {
  const queryTokens = [...new Set(tokenizeContext(query))];
  if (queryTokens.length === 0) return 0;
  const tokens = new Set(tokenizeContext(text));
  return queryTokens.filter((token) => tokens.has(token)).length / queryTokens.length;
}

export function exactTerms(plan: QueryPlan): string[] {
  const quoted = [...plan.normalizedQuestion.matchAll(/`([^`]+)`|"([^"]+)"/g)].map((match) => match[1] ?? match[2]!);
  const identifiers = [
    ...plan.normalizedQuestion.matchAll(
      /(?:[a-z0-9_.-]+\/)+[a-z0-9_.-]+|#[1-9][0-9]*|\b[0-9a-f]{7,40}\b|[A-Za-z_$][\w$]*(?=\s*\()/g
    )
  ].map((match) => match[0]);
  return [
    ...new Set([
      ...quoted,
      ...identifiers,
      ...(plan.targets.paths ?? []),
      ...(plan.targets.symbols ?? []),
      ...(plan.targets.pullRequests ?? []),
      ...(plan.targets.issues ?? [])
    ])
  ].filter((value) => value.length > 1);
}

export function matchesExplicitCodeTargets(document: ContextDocument, plan: QueryPlan): boolean {
  const paths = (plan.targets.paths ?? []).map(normalizeTarget);
  const symbols = (plan.targets.symbols ?? []).map((target) => target.toLowerCase());
  if (paths.length === 0 && symbols.length === 0) return true;
  if (document.sourceKind === "provider") return false;

  const documentPaths = [
    typeof document.metadata.path === "string" ? document.metadata.path : undefined,
    document.title,
    ...document.anchors.map((anchor) => anchor.pathOrUrl)
  ]
    .filter((value): value is string => value !== undefined)
    .map(normalizeTarget);
  const ownershipSource =
    /\b(?:who owns|owner|ownership)\b/i.test(plan.normalizedQuestion) &&
    documentPaths.some((path) => /(?:^|\/)codeowners$/.test(path));
  const ownershipMatches =
    ownershipSource &&
    paths.some((target) => new RegExp(`(^|[\\s/])${escapeRegex(target)}(?=$|[\\s])`, "i").test(document.body));
  const pathMatches =
    paths.length === 0 ||
    ownershipMatches ||
    paths.some((target) =>
      documentPaths.some(
        (candidate) => candidate === target || candidate.endsWith(`/${target}`) || target.endsWith(`/${candidate}`)
      )
    );
  const searchable = `${document.title}\n${document.contextualText}\n${document.body}`.toLowerCase();
  const symbolMatches =
    symbols.length === 0 ||
    symbols.some((symbol) => new RegExp(`(^|[^a-z0-9_$])${escapeRegex(symbol)}([^a-z0-9_$]|$)`, "i").test(searchable));
  return pathMatches && symbolMatches;
}

function normalizeTarget(value: string): string {
  return value.trim().replace(/^\.\//, "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
