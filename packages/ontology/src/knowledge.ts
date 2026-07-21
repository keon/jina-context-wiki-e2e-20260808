import { stableId, type OntologyNodeKind } from "./model.js";
import {
  ONTOLOGY_REGISTRY_VERSION,
  literalTypes,
  predicateDefinition,
  validatePredicateEndpoints,
  validateQualifiers,
  type LiteralType,
  type PredicateDefinition
} from "./registry.js";

export type AssertionStatus = "proposed" | "active" | "rejected" | "superseded" | "retracted";
export type IdentityStatus = "proposed" | "accepted" | "rejected" | "erased";
export type QualifierValue = string | number | boolean;

export interface KnowledgeEntity {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: OntologyNodeKind;
  readonly key: string;
  readonly displayName?: string;
  readonly createdAt: string;
  readonly retiredAt?: string;
}

export interface ExternalIdentity {
  readonly id: string;
  readonly tenantId: string;
  readonly source: string;
  readonly externalId: string;
  readonly entityId: string;
  readonly status: IdentityStatus;
  readonly confidence?: number;
  readonly sourceObservationId?: string;
  readonly createdAt: string;
}

export interface EntityRedirect {
  readonly id: string;
  readonly tenantId: string;
  readonly fromEntityId: string;
  readonly toEntityId: string;
  readonly kind: "merge" | "unmerge";
  readonly auditId: string;
  readonly createdAt: string;
}

export interface KnowledgeAssertion {
  readonly id: string;
  readonly tenantId: string;
  readonly repoId?: string;
  readonly subjectId: string;
  readonly predicate: string;
  readonly objectId?: string;
  readonly literalType?: LiteralType;
  readonly literalValue?: unknown;
  readonly qualifiers: Readonly<Record<string, QualifierValue>>;
  readonly qualifiersHash: string;
  readonly status: AssertionStatus;
  readonly explanation: string;
  readonly confidence?: number;
  readonly sourceObservationId?: string;
  readonly assertedBy?: string;
  readonly generator?: string;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly lastConfirmedAt: string;
  readonly recordedAt: string;
  readonly supersededBy?: string;
  readonly registryVersion: string;
}

export interface AuditEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly action: string;
  readonly input: unknown;
  readonly result: "accepted" | "rejected";
  readonly reason?: string;
  readonly createdAt: string;
  readonly parentAuditId?: string;
}

export type AssertionRelationKind = "supports" | "contradicts";

export interface AssertionRelation {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceAssertionId: string;
  readonly relation: AssertionRelationKind;
  readonly targetAssertionId: string;
  readonly evidenceObservationId: string;
  readonly createdAt: string;
}

export interface AssertionInput {
  readonly tenantId: string;
  readonly repoId?: string;
  readonly subjectId: string;
  readonly predicate: string;
  readonly objectId?: string;
  readonly literalType?: LiteralType;
  readonly literalValue?: unknown;
  readonly qualifiers?: Readonly<Record<string, QualifierValue>>;
  readonly explanation: string;
  readonly confidence?: number;
  readonly sourceObservationId?: string;
  readonly assertedBy?: string;
  readonly generator?: string;
  readonly validFrom?: string;
  readonly recordedAt: string;
  readonly registryVersion?: string;
}

export interface KnowledgeState {
  readonly entities: readonly KnowledgeEntity[];
  readonly identities: readonly ExternalIdentity[];
  readonly redirects: readonly EntityRedirect[];
  readonly assertions: readonly KnowledgeAssertion[];
  readonly assertionRelations: readonly AssertionRelation[];
  readonly auditLog: readonly AuditEntry[];
}

export function emptyKnowledgeState(): KnowledgeState {
  return { entities: [], identities: [], redirects: [], assertions: [], assertionRelations: [], auditLog: [] };
}

export function relateAssertions(
  state: KnowledgeState,
  input: Omit<AssertionRelation, "id" | "createdAt"> & { readonly now: string }
): { readonly state: KnowledgeState; readonly relation: AssertionRelation; readonly created: boolean } {
  const source = state.assertions.find((assertion) => assertion.tenantId === input.tenantId && assertion.id === input.sourceAssertionId);
  const target = state.assertions.find((assertion) => assertion.tenantId === input.tenantId && assertion.id === input.targetAssertionId);
  if (!source || !target) throw new Error("assertion relation endpoints must exist in the tenant");
  if (source.id === target.id) throw new Error("an assertion cannot support or contradict itself");
  if (!source.repoId || source.repoId !== target.repoId) throw new Error("assertion relations must stay within one repository");
  const existing = state.assertionRelations.find((relation) =>
    relation.tenantId === input.tenantId && relation.sourceAssertionId === source.id &&
    relation.relation === input.relation && relation.targetAssertionId === target.id &&
    relation.evidenceObservationId === input.evidenceObservationId
  );
  if (existing) return { state, relation: existing, created: false };
  const relation: AssertionRelation = {
    id: stableId("assertion_relation", `${input.tenantId}:${source.id}:${input.relation}:${target.id}:${input.evidenceObservationId}`),
    tenantId: input.tenantId,
    sourceAssertionId: source.id,
    relation: input.relation,
    targetAssertionId: target.id,
    evidenceObservationId: input.evidenceObservationId,
    createdAt: input.now
  };
  return { state: { ...state, assertionRelations: [...state.assertionRelations, relation] }, relation, created: true };
}

export function ensureEntity(
  state: KnowledgeState,
  input: Pick<KnowledgeEntity, "tenantId" | "kind" | "key"> & { readonly displayName?: string; readonly now: string }
): { readonly state: KnowledgeState; readonly entity: KnowledgeEntity; readonly created: boolean } {
  const existing = state.entities.find((entity) =>
    entity.tenantId === input.tenantId && entity.kind === input.kind && entity.key === input.key
  );
  if (existing) return { state, entity: existing, created: false };
  const entity: KnowledgeEntity = {
    id: stableId("entity", `${input.tenantId}:${input.kind}:${input.key}`),
    tenantId: input.tenantId, kind: input.kind, key: input.key,
    ...(input.displayName ? { displayName: input.displayName } : {}), createdAt: input.now
  };
  return { state: { ...state, entities: [...state.entities, entity] }, entity, created: true };
}

export function upsertIdentity(
  state: KnowledgeState,
  input: Omit<ExternalIdentity, "id" | "createdAt"> & { readonly now: string }
): { readonly state: KnowledgeState; readonly identity: ExternalIdentity } {
  requireEntity(state, input.tenantId, input.entityId);
  const conflictingAccepted = state.identities.find((identity) =>
    identity.tenantId === input.tenantId && identity.source === input.source && identity.externalId === input.externalId &&
    identity.status === "accepted" && identity.entityId !== input.entityId
  );
  if (conflictingAccepted && input.status === "accepted") {
    throw new Error(`accepted identity ${input.source}:${input.externalId} already resolves to another entity`);
  }
  const existing = state.identities.find((identity) =>
    identity.tenantId === input.tenantId && identity.source === input.source && identity.externalId === input.externalId &&
    identity.entityId === input.entityId
  );
  if (existing) return { state, identity: existing };
  const identity: ExternalIdentity = {
    id: stableId("identity", `${input.tenantId}:${input.source}:${input.externalId}:${input.entityId}`),
    tenantId: input.tenantId, source: input.source, externalId: input.externalId, entityId: input.entityId,
    status: input.status, ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.sourceObservationId ? { sourceObservationId: input.sourceObservationId } : {}), createdAt: input.now
  };
  return { state: { ...state, identities: [...state.identities, identity] }, identity };
}

export function applyAssertion(
  state: KnowledgeState,
  input: AssertionInput
): { readonly state: KnowledgeState; readonly assertion: KnowledgeAssertion; readonly created: boolean } {
  validateAssertionInput(state, input);
  const definition = predicateDefinition(input.predicate);
  const qualifiers = input.qualifiers ?? {};
  const qualifiersHash = hashCanonical(qualifiers);
  const valueKey = input.objectId ?? `${input.literalType}:${canonicalJson(input.literalValue)}`;
  const naturalKey = `${input.tenantId}:${input.subjectId}:${definition.name}:${valueKey}:${qualifiersHash}`;
  const existing = state.assertions.find((assertion) =>
    assertion.tenantId === input.tenantId && assertion.status !== "rejected" && assertion.status !== "superseded" &&
    assertion.status !== "retracted" && assertion.subjectId === input.subjectId && assertion.predicate === definition.name &&
    (assertion.objectId ?? `${assertion.literalType}:${canonicalJson(assertion.literalValue)}`) === valueKey &&
    assertion.qualifiersHash === qualifiersHash
  );
  if (existing) {
    const confirmed = { ...existing, lastConfirmedAt: input.recordedAt };
    return {
      state: { ...state, assertions: state.assertions.map((assertion) => assertion.id === existing.id ? confirmed : assertion) },
      assertion: confirmed, created: false
    };
  }
  const status = initialStatus(definition, input);
  const assertion: KnowledgeAssertion = {
    id: stableId("assertion", naturalKey), tenantId: input.tenantId,
    ...(input.repoId ? { repoId: input.repoId } : {}), subjectId: input.subjectId, predicate: definition.name,
    ...(input.objectId ? { objectId: input.objectId } : {}),
    ...(input.literalType ? { literalType: input.literalType, literalValue: input.literalValue } : {}),
    qualifiers, qualifiersHash, status, explanation: input.explanation.replace(/\s+/g, " ").trim(),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.sourceObservationId ? { sourceObservationId: input.sourceObservationId } : {}),
    ...(input.assertedBy ? { assertedBy: input.assertedBy } : {}),
    ...(input.generator ? { generator: input.generator } : {}),
    ...(input.validFrom ? { validFrom: input.validFrom } : {}),
    lastConfirmedAt: input.recordedAt, recordedAt: input.recordedAt,
    registryVersion: input.registryVersion ?? ONTOLOGY_REGISTRY_VERSION
  };
  const assertions = status === "active"
    ? supersedeCardinalityOne(state.assertions, assertion, definition, input.recordedAt)
    : state.assertions;
  return { state: { ...state, assertions: [...assertions, assertion] }, assertion, created: true };
}

export function reviewAssertion(
  state: KnowledgeState,
  input: {
    readonly tenantId: string; readonly assertionId: string; readonly decision: "accept" | "reject" | "retract";
    readonly actorId: string; readonly now: string; readonly reason?: string;
    readonly rejectionCode?: "incorrect_relationship" | "insufficient_evidence" | "unsupported_explanation" | "other";
  }
): { readonly state: KnowledgeState; readonly assertion: KnowledgeAssertion; readonly audit: AuditEntry } {
  if (input.decision === "reject" && (!input.reason || !input.rejectionCode)) {
    throw new Error("assertion rejection requires a reason and rejection code");
  }
  const current = state.assertions.find((assertion) => assertion.tenantId === input.tenantId && assertion.id === input.assertionId);
  if (!current) throw new Error("assertion not found");
  const allowed = input.decision === "accept" ? current.status === "proposed"
    : input.decision === "reject" ? current.status === "proposed"
      : current.status === "active";
  if (!allowed) throw new Error(`cannot ${input.decision} assertion in ${current.status}`);
  const nextStatus: AssertionStatus = input.decision === "accept" ? "active" : input.decision === "reject" ? "rejected" : "retracted";
  const next: KnowledgeAssertion = {
    ...current, status: nextStatus,
    ...(nextStatus === "retracted" ? { validTo: input.now } : {})
  };
  const definition = predicateDefinition(current.predicate);
  const base = state.assertions.map((assertion) => assertion.id === current.id ? next : assertion);
  const assertions = nextStatus === "active" ? supersedeCardinalityOne(base, next, definition, input.now) : base;
  const audit = auditEntry(input.tenantId, input.actorId, `${input.decision}_assertion`, {
    assertionId: current.id, generator: current.generator, predicate: current.predicate,
    ...(input.rejectionCode ? { rejectionCode: input.rejectionCode } : {})
  }, input.now, input.reason);
  return { state: { ...state, assertions, auditLog: [...state.auditLog, audit] }, assertion: next, audit };
}

export function addRedirect(
  state: KnowledgeState,
  input: { readonly tenantId: string; readonly fromEntityId: string; readonly toEntityId: string; readonly kind: "merge" | "unmerge"; readonly actorId: string; readonly now: string; readonly reason?: string }
): { readonly state: KnowledgeState; readonly redirect: EntityRedirect; readonly audit: AuditEntry } {
  requireEntity(state, input.tenantId, input.fromEntityId);
  requireEntity(state, input.tenantId, input.toEntityId);
  if (input.fromEntityId === input.toEntityId) throw new Error("cannot redirect an entity to itself");
  const audit = auditEntry(input.tenantId, input.actorId, `${input.kind}_entities`, {
    fromEntityId: input.fromEntityId, toEntityId: input.toEntityId
  }, input.now, input.reason);
  const redirect: EntityRedirect = {
    id: stableId("redirect", `${input.tenantId}:${input.fromEntityId}:${input.toEntityId}:${input.kind}:${input.now}`),
    tenantId: input.tenantId, fromEntityId: input.fromEntityId, toEntityId: input.toEntityId,
    kind: input.kind, auditId: audit.id, createdAt: input.now
  };
  const redirects = [...state.redirects, redirect];
  if (input.kind === "merge") resolveEntityId({ ...state, redirects }, input.tenantId, input.fromEntityId);
  return { state: { ...state, redirects, auditLog: [...state.auditLog, audit] }, redirect, audit };
}

export function resolveEntityId(state: Pick<KnowledgeState, "redirects">, tenantId: string, entityId: string): string {
  const mapping = new Map<string, string>();
  for (const redirect of state.redirects.filter((item) => item.tenantId === tenantId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    if (redirect.kind === "merge") mapping.set(redirect.fromEntityId, redirect.toEntityId);
    else if (mapping.get(redirect.fromEntityId) === redirect.toEntityId) mapping.delete(redirect.fromEntityId);
  }
  const seen = new Set<string>();
  let current = entityId;
  while (mapping.has(current)) {
    if (seen.has(current)) throw new Error("entity redirect cycle detected");
    seen.add(current);
    current = mapping.get(current)!;
  }
  return current;
}

export function reconcileAssertions(
  state: KnowledgeState,
  input: { readonly tenantId: string; readonly actorId?: string; readonly now: string; readonly parentAuditId?: string }
): { readonly state: KnowledgeState; readonly supersededCount: number; readonly audit?: AuditEntry } {
  const active = state.assertions.filter((assertion) => assertion.tenantId === input.tenantId && assertion.status === "active");
  const groups = new Map<string, KnowledgeAssertion[]>();
  for (const assertion of active) {
    const subject = resolveEntityId(state, input.tenantId, assertion.subjectId);
    const object = assertion.objectId ? resolveEntityId(state, input.tenantId, assertion.objectId) : `${assertion.literalType}:${canonicalJson(assertion.literalValue)}`;
    const exactKey = `${subject}:${assertion.predicate}:${object}:${assertion.qualifiersHash}`;
    const definition = predicateDefinition(assertion.predicate);
    const key = definition.cardinality === "one" ? `${subject}:${assertion.predicate}:${assertion.qualifiersHash}` : exactKey;
    groups.set(key, [...(groups.get(key) ?? []), assertion]);
  }
  const updates = new Map<string, KnowledgeAssertion>();
  for (const values of groups.values()) {
    if (values.length < 2) continue;
    const definition = predicateDefinition(values[0]!.predicate);
    const ordered = [...values].sort((a, b) => {
      if (definition.cardinality === "one") {
        return (b.validFrom ?? b.recordedAt).localeCompare(a.validFrom ?? a.recordedAt) || b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id);
      }
      return a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id);
    });
    const winner = ordered[0]!;
    for (const loser of ordered.slice(1)) updates.set(loser.id, { ...loser, status: "superseded", validTo: input.now, supersededBy: winner.id });
  }
  if (updates.size === 0) return { state, supersededCount: 0 };
  const audit: AuditEntry = {
    ...auditEntry(input.tenantId, input.actorId ?? "svc:reconciliation", "reconcile_redirect_collisions", {
      assertionIds: [...updates.keys()]
    }, input.now),
    ...(input.parentAuditId ? { parentAuditId: input.parentAuditId } : {})
  };
  return {
    state: {
      ...state,
      assertions: state.assertions.map((assertion) => updates.get(assertion.id) ?? assertion),
      auditLog: [...state.auditLog, audit]
    },
    supersededCount: updates.size,
    audit
  };
}

export function acceptanceRates(state: KnowledgeState, tenantId: string): readonly {
  readonly generator: string;
  readonly predicate: string;
  readonly accepted: number;
  readonly rejected: number;
  readonly rate: number;
}[] {
  const assertions = new Map(state.assertions.map((assertion) => [assertion.id, assertion]));
  const counters = new Map<string, { generator: string; predicate: string; accepted: number; rejected: number }>();
  for (const audit of state.auditLog) {
    if (audit.tenantId !== tenantId || !["accept_assertion", "reject_assertion", "retract_assertion"].includes(audit.action)) continue;
    const payload = isRecord(audit.input) ? audit.input : {};
    const assertion = typeof payload.assertionId === "string" ? assertions.get(payload.assertionId) : undefined;
    if (!assertion?.generator) continue;
    const key = `${assertion.generator}:${assertion.predicate}`;
    const counter = counters.get(key) ?? { generator: assertion.generator, predicate: assertion.predicate, accepted: 0, rejected: 0 };
    if (audit.action === "accept_assertion") counter.accepted += 1;
    else counter.rejected += 1;
    counters.set(key, counter);
  }
  return [...counters.values()].map((counter) => ({
    ...counter, rate: counter.accepted / Math.max(1, counter.accepted + counter.rejected)
  }));
}

function validateAssertionInput(state: KnowledgeState, input: AssertionInput): void {
  requireEntity(state, input.tenantId, input.subjectId);
  const subject = state.entities.find((entity) => entity.id === input.subjectId)!;
  const object = input.objectId ? requireEntity(state, input.tenantId, input.objectId) : undefined;
  const provenanceCount = Number(Boolean(input.sourceObservationId)) + Number(Boolean(input.assertedBy));
  if (provenanceCount !== 1) throw new Error("assertion provenance requires sourceObservationId XOR assertedBy");
  if (!input.explanation.trim()) throw new Error("assertion explanation is required");
  if (input.explanation.length > 1_000) throw new Error("assertion explanation must not exceed 1000 characters");
  if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
    throw new Error("assertion confidence must be between 0 and 1");
  }
  if (input.literalType && !literalTypes.includes(input.literalType)) throw new Error(`unsupported literal type ${input.literalType}`);
  const definition = predicateDefinition(input.predicate);
  validatePredicateEndpoints(definition, subject.kind, object?.kind, input.literalType);
  validateQualifiers(definition, input.qualifiers);
  if (definition.class === "inference" && input.confidence === undefined) throw new Error(`${definition.name} requires confidence`);
}

function initialStatus(definition: PredicateDefinition, input: AssertionInput): AssertionStatus {
  if (definition.review !== "none") return "proposed";
  return input.generator?.startsWith("model:") ? "proposed" : "active";
}

function supersedeCardinalityOne(
  assertions: readonly KnowledgeAssertion[],
  winner: KnowledgeAssertion,
  definition: PredicateDefinition,
  now: string
): readonly KnowledgeAssertion[] {
  if (definition.cardinality !== "one") return assertions;
  return assertions.map((assertion) => {
    if (
      assertion.id === winner.id || assertion.tenantId !== winner.tenantId || assertion.status !== "active" ||
      assertion.subjectId !== winner.subjectId || assertion.predicate !== winner.predicate ||
      assertion.qualifiersHash !== winner.qualifiersHash
    ) return assertion;
    return { ...assertion, status: "superseded", validTo: now, supersededBy: winner.id };
  });
}

function requireEntity(state: KnowledgeState, tenantId: string, entityId: string): KnowledgeEntity {
  const entity = state.entities.find((candidate) => candidate.tenantId === tenantId && candidate.id === entityId);
  if (!entity) throw new Error(`entity ${entityId} not found in tenant`);
  return entity;
}

function auditEntry(tenantId: string, actorId: string, action: string, input: unknown, now: string, reason?: string): AuditEntry {
  return {
    id: stableId("audit", `${tenantId}:${actorId}:${action}:${canonicalJson(input)}:${now}`),
    tenantId, actorId, action, input, result: "accepted", ...(reason ? { reason } : {}), createdAt: now
  };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function hashCanonical(value: unknown): string { return stableId("q", canonicalJson(value)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
