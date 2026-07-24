import { canonicalJson } from "./knowledge.js";
import { contextGraphNodeKinds, type ContextGraphNodeKind } from "./model.js";
import type { ContextGraphEntityRef } from "./pipeline.js";
import { evidenceLocatorKey, parseEvidenceLocator, type EvidenceLocator } from "./evidence.js";
import { predicateRegistry, type PredicateDefinition } from "./registry.js";

export const ASSERTION_CHANGESET_CONTRACT_VERSION = "assertion-changeset/v1" as const;
export const assertionScopeKinds = ["pull_request", "incremental", "initialize", "backfill"] as const;
export type AssertionScopeKind = (typeof assertionScopeKinds)[number];

export const assertionTruthClasses = [
  "authoritative_fact",
  "source_observation",
  "agent_claim",
  "human_decision",
  "preference",
  "timeline_event",
  "quality_finding"
] as const;
export type AssertionTruthClass = (typeof assertionTruthClasses)[number];

export const assertionRelationKinds = ["supports", "contradicts"] as const;
export type AssertionRelationKind = (typeof assertionRelationKinds)[number];

export const assertionQualifierKeys = [
  ...new Set(
    (Object.values(predicateRegistry) as readonly PredicateDefinition[]).flatMap(
      (definition) => definition.qualifierKeys ?? []
    )
  )
].sort();

export const ASSERTION_CHANGESET_LIMITS = {
  operations: 500,
  evidencePerOperation: 32,
  unresolvedFindings: 100,
  requiredEvidencePerFinding: 32,
  explanationCharacters: 8_000,
  qualifierCharacters: 8_000
} as const;

export interface AssertionChangeSetScope {
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly kind: AssertionScopeKind;
}

export interface AssertionChangeSetBase {
  readonly assertionSetVersion: string;
  readonly registryVersion: string;
  readonly evidenceFingerprint: string;
}

export interface AssertionCandidate {
  readonly subject: ContextGraphEntityRef;
  readonly predicate: string;
  readonly object: ContextGraphEntityRef;
  readonly qualifiers: Readonly<Record<string, string | number | boolean>>;
  readonly truthClass: AssertionTruthClass;
  readonly confidence: number;
  readonly explanation: string;
  readonly evidence: readonly EvidenceLocator[];
  readonly validFrom: string | null;
  readonly validUntil: string | null;
}

export interface ProposeAssertionOperation {
  readonly operationId: string;
  readonly type: "propose";
  readonly assertion: AssertionCandidate;
}

export interface ConfirmAssertionOperation {
  readonly operationId: string;
  readonly type: "confirm";
  readonly assertionId: string;
  readonly attestations: readonly EvidenceLocator[];
  readonly reason: string;
}

export interface SupersedeAssertionOperation {
  readonly operationId: string;
  readonly type: "supersede";
  readonly assertionId: string;
  readonly replacement: AssertionCandidate;
  readonly reason: string;
}

export interface RetractAssertionOperation {
  readonly operationId: string;
  readonly type: "retract";
  readonly assertionId: string;
  readonly evidence: readonly EvidenceLocator[];
  readonly reason: string;
}

export interface RelateAssertionsOperation {
  readonly operationId: string;
  readonly type: "relate";
  readonly relation: AssertionRelationKind;
  readonly sourceAssertionId: string;
  readonly targetAssertionId: string;
  readonly evidence: readonly EvidenceLocator[];
  readonly reason: string;
}

export type AssertionOperation =
  | ProposeAssertionOperation
  | ConfirmAssertionOperation
  | SupersedeAssertionOperation
  | RetractAssertionOperation
  | RelateAssertionsOperation;

export interface UnresolvedFinding {
  readonly findingId: string;
  readonly question: string;
  readonly reason: string;
  readonly requiredEvidence: readonly string[];
  readonly suggestedAction: string;
}

export interface AssertionChangeSetV1 {
  readonly contractVersion: typeof ASSERTION_CHANGESET_CONTRACT_VERSION;
  readonly changeSetId: string;
  readonly scope: AssertionChangeSetScope;
  readonly base: AssertionChangeSetBase;
  readonly summary: string;
  readonly operations: readonly AssertionOperation[];
  readonly unresolved: readonly UnresolvedFinding[];
}

export interface AssertionChangeSetExpectations {
  readonly scope?: AssertionChangeSetScope;
  readonly base?: AssertionChangeSetBase;
}

export function parseAssertionChangeSet(
  value: unknown,
  expectations: AssertionChangeSetExpectations = {}
): AssertionChangeSetV1 {
  if (!isRecord(value)) throw new Error("assertion changeset must be an object");
  assertOnlyKeys(
    value,
    ["contractVersion", "changeSetId", "scope", "base", "summary", "operations", "unresolved"],
    "assertion changeset"
  );
  if (value.contractVersion !== ASSERTION_CHANGESET_CONTRACT_VERSION) {
    throw new Error(`unsupported assertion changeset contract: ${String(value.contractVersion)}`);
  }
  const operations = requiredArray(value.operations, "operations", ASSERTION_CHANGESET_LIMITS.operations).map(
    (operation, index) => parseAssertionOperation(operation, index)
  );
  const unresolved = requiredArray(value.unresolved, "unresolved", ASSERTION_CHANGESET_LIMITS.unresolvedFindings).map(
    (finding, index) => parseUnresolvedFinding(finding, index)
  );
  const parsed: AssertionChangeSetV1 = {
    contractVersion: value.contractVersion,
    changeSetId: requiredString(value.changeSetId, "changeSetId"),
    scope: parseScope(value.scope),
    base: parseBase(value.base),
    summary: requiredString(value.summary, "summary"),
    operations,
    unresolved
  };
  validateUniqueOperations(parsed.operations);
  validateEvidenceScope(parsed.operations, parsed.scope);
  validateExpectedScope(parsed.scope, expectations.scope);
  validateExpectedBase(parsed.base, expectations.base);
  return parsed;
}

export function assertionSemanticKey(candidate: AssertionCandidate): string {
  return [
    entityKey(candidate.subject),
    candidate.predicate.trim().toUpperCase(),
    entityKey(candidate.object),
    canonicalJson(candidate.qualifiers)
  ].join(":");
}

function parseScope(value: unknown): AssertionChangeSetScope {
  if (!isRecord(value)) throw new Error("scope must be an object");
  assertOnlyKeys(value, ["tenantId", "repository", "ref", "commitSha", "kind"], "scope");
  const kind = requiredString(value.kind, "scope.kind");
  if (!assertionScopeKinds.includes(kind as AssertionScopeKind)) {
    throw new Error(`scope.kind is unsupported: ${kind}`);
  }
  return {
    tenantId: requiredString(value.tenantId, "scope.tenantId"),
    repository: requiredString(value.repository, "scope.repository"),
    ref: requiredString(value.ref, "scope.ref"),
    commitSha: requiredCommitSha(value.commitSha, "scope.commitSha"),
    kind: kind as AssertionScopeKind
  };
}

function parseBase(value: unknown): AssertionChangeSetBase {
  if (!isRecord(value)) throw new Error("base must be an object");
  assertOnlyKeys(value, ["assertionSetVersion", "registryVersion", "evidenceFingerprint"], "base");
  return {
    assertionSetVersion: requiredString(value.assertionSetVersion, "base.assertionSetVersion"),
    registryVersion: requiredString(value.registryVersion, "base.registryVersion"),
    evidenceFingerprint: requiredString(value.evidenceFingerprint, "base.evidenceFingerprint")
  };
}

function parseAssertionOperation(value: unknown, index: number): AssertionOperation {
  const owner = `operations[${index}]`;
  if (!isRecord(value)) throw new Error(`${owner} must be an object`);
  const type = requiredString(value.type, `${owner}.type`);
  if (type === "propose") {
    assertOnlyKeys(value, ["operationId", "type", "assertion"], owner);
    return {
      operationId: requiredString(value.operationId, `${owner}.operationId`),
      type,
      assertion: parseAssertionCandidate(value.assertion, `${owner}.assertion`)
    };
  }
  if (type === "confirm") {
    assertOnlyKeys(value, ["operationId", "type", "assertionId", "attestations", "reason"], owner);
    return {
      operationId: requiredString(value.operationId, `${owner}.operationId`),
      type,
      assertionId: requiredString(value.assertionId, `${owner}.assertionId`),
      attestations: parseEvidenceList(value.attestations, `${owner}.attestations`),
      reason: boundedExplanation(value.reason, `${owner}.reason`)
    };
  }
  if (type === "supersede") {
    assertOnlyKeys(value, ["operationId", "type", "assertionId", "replacement", "reason"], owner);
    return {
      operationId: requiredString(value.operationId, `${owner}.operationId`),
      type,
      assertionId: requiredString(value.assertionId, `${owner}.assertionId`),
      replacement: parseAssertionCandidate(value.replacement, `${owner}.replacement`),
      reason: boundedExplanation(value.reason, `${owner}.reason`)
    };
  }
  if (type === "retract") {
    assertOnlyKeys(value, ["operationId", "type", "assertionId", "evidence", "reason"], owner);
    return {
      operationId: requiredString(value.operationId, `${owner}.operationId`),
      type,
      assertionId: requiredString(value.assertionId, `${owner}.assertionId`),
      evidence: parseEvidenceList(value.evidence, `${owner}.evidence`),
      reason: boundedExplanation(value.reason, `${owner}.reason`)
    };
  }
  if (type === "relate") {
    assertOnlyKeys(
      value,
      ["operationId", "type", "relation", "sourceAssertionId", "targetAssertionId", "evidence", "reason"],
      owner
    );
    const relation = requiredString(value.relation, `${owner}.relation`);
    if (!assertionRelationKinds.includes(relation as AssertionRelationKind)) {
      throw new Error(`${owner}.relation is unsupported: ${relation}`);
    }
    const sourceAssertionId = requiredString(value.sourceAssertionId, `${owner}.sourceAssertionId`);
    const targetAssertionId = requiredString(value.targetAssertionId, `${owner}.targetAssertionId`);
    if (sourceAssertionId === targetAssertionId) {
      throw new Error(`${owner} cannot relate an assertion to itself`);
    }
    return {
      operationId: requiredString(value.operationId, `${owner}.operationId`),
      type,
      relation: relation as AssertionRelationKind,
      sourceAssertionId,
      targetAssertionId,
      evidence: parseEvidenceList(value.evidence, `${owner}.evidence`),
      reason: boundedExplanation(value.reason, `${owner}.reason`)
    };
  }
  throw new Error(`${owner}.type is unsupported: ${type}`);
}

function parseAssertionCandidate(value: unknown, owner: string): AssertionCandidate {
  if (!isRecord(value)) throw new Error(`${owner} must be an object`);
  assertOnlyKeys(
    value,
    [
      "subject",
      "predicate",
      "object",
      "qualifiers",
      "truthClass",
      "confidence",
      "explanation",
      "evidence",
      "validFrom",
      "validUntil"
    ],
    owner
  );
  const truthClass = requiredString(value.truthClass, `${owner}.truthClass`);
  if (!assertionTruthClasses.includes(truthClass as AssertionTruthClass)) {
    throw new Error(`${owner}.truthClass is unsupported: ${truthClass}`);
  }
  const confidence = value.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`${owner}.confidence must be between 0 and 1`);
  }
  const validFrom = nullableTimestamp(value.validFrom, `${owner}.validFrom`);
  const validUntil = nullableTimestamp(value.validUntil, `${owner}.validUntil`);
  if (validFrom && validUntil && Date.parse(validUntil) < Date.parse(validFrom)) {
    throw new Error(`${owner}.validUntil must not be earlier than validFrom`);
  }
  return {
    subject: parseEntityReference(value.subject, `${owner}.subject`),
    predicate: requiredString(value.predicate, `${owner}.predicate`),
    object: parseEntityReference(value.object, `${owner}.object`),
    qualifiers: parseQualifiers(value.qualifiers, `${owner}.qualifiers`),
    truthClass: truthClass as AssertionTruthClass,
    confidence,
    explanation: boundedExplanation(value.explanation, `${owner}.explanation`),
    evidence: parseEvidenceList(value.evidence, `${owner}.evidence`),
    validFrom,
    validUntil
  };
}

function parseEntityReference(value: unknown, owner: string): ContextGraphEntityRef {
  if (!isRecord(value)) throw new Error(`${owner} must be an object`);
  assertOnlyKeys(value, ["kind", "naturalKey", "label"], owner);
  const kind = requiredString(value.kind, `${owner}.kind`);
  if (!contextGraphNodeKinds.includes(kind as ContextGraphNodeKind)) {
    throw new Error(`${owner}.kind is unsupported: ${kind}`);
  }
  return {
    kind: kind as ContextGraphNodeKind,
    naturalKey: requiredString(value.naturalKey, `${owner}.naturalKey`),
    label: requiredString(value.label, `${owner}.label`)
  };
}

function parseQualifiers(value: unknown, owner: string): Readonly<Record<string, string | number | boolean>> {
  if (!isRecord(value)) throw new Error(`${owner} must be an object`);
  const qualifiers: Record<string, string | number | boolean> = {};
  for (const [key, qualifier] of Object.entries(value)) {
    if (!key.trim()) throw new Error(`${owner} contains an empty key`);
    if (!assertionQualifierKeys.includes(key)) throw new Error(`${owner} contains unsupported qualifier ${key}`);
    if (qualifier === null) continue;
    if (typeof qualifier !== "string" && typeof qualifier !== "number" && typeof qualifier !== "boolean") {
      throw new Error(`${owner}.${key} must be a string, number, or boolean`);
    }
    if (typeof qualifier === "number" && !Number.isFinite(qualifier)) {
      throw new Error(`${owner}.${key} must be finite`);
    }
    qualifiers[key] = qualifier;
  }
  if (canonicalJson(qualifiers).length > ASSERTION_CHANGESET_LIMITS.qualifierCharacters) {
    throw new Error(`${owner} exceeds the qualifier size limit`);
  }
  return qualifiers;
}

function parseEvidenceList(value: unknown, owner: string): readonly EvidenceLocator[] {
  const evidence = requiredArray(value, owner, ASSERTION_CHANGESET_LIMITS.evidencePerOperation);
  if (evidence.length === 0) throw new Error(`${owner} must contain at least one item`);
  const parsed = evidence.map((locator, index) => parseEvidenceLocator(locator, `${owner}[${index}]`));
  const keys = parsed.map(evidenceLocatorKey);
  if (new Set(keys).size !== keys.length) throw new Error(`${owner} contains duplicate evidence`);
  return parsed;
}

function parseUnresolvedFinding(value: unknown, index: number): UnresolvedFinding {
  const owner = `unresolved[${index}]`;
  if (!isRecord(value)) throw new Error(`${owner} must be an object`);
  assertOnlyKeys(value, ["findingId", "question", "reason", "requiredEvidence", "suggestedAction"], owner);
  const requiredEvidence = requiredArray(
    value.requiredEvidence,
    `${owner}.requiredEvidence`,
    ASSERTION_CHANGESET_LIMITS.requiredEvidencePerFinding
  ).map((item, evidenceIndex) => requiredString(item, `${owner}.requiredEvidence[${evidenceIndex}]`));
  return {
    findingId: requiredString(value.findingId, `${owner}.findingId`),
    question: boundedExplanation(value.question, `${owner}.question`),
    reason: boundedExplanation(value.reason, `${owner}.reason`),
    requiredEvidence,
    suggestedAction: requiredString(value.suggestedAction, `${owner}.suggestedAction`)
  };
}

function validateUniqueOperations(operations: readonly AssertionOperation[]): void {
  const operationIds = new Set<string>();
  const lifecycleTargets = new Map<string, string>();
  const candidateKeys = new Map<string, string>();
  const relationKeys = new Set<string>();
  for (const operation of operations) {
    if (operationIds.has(operation.operationId)) {
      throw new Error(`duplicate assertion operationId: ${operation.operationId}`);
    }
    operationIds.add(operation.operationId);
    if (operation.type === "propose" || operation.type === "supersede") {
      const candidate = operation.type === "propose" ? operation.assertion : operation.replacement;
      const key = assertionSemanticKey(candidate);
      const prior = candidateKeys.get(key);
      if (prior) throw new Error(`operations ${prior} and ${operation.operationId} propose the same assertion`);
      candidateKeys.set(key, operation.operationId);
    }
    if (operation.type === "confirm" || operation.type === "supersede" || operation.type === "retract") {
      const prior = lifecycleTargets.get(operation.assertionId);
      if (prior) {
        throw new Error(
          `operations ${prior} and ${operation.operationId} contain conflicting lifecycle changes for ${operation.assertionId}`
        );
      }
      lifecycleTargets.set(operation.assertionId, operation.operationId);
    }
    if (operation.type === "relate") {
      const key = `${operation.relation}:${operation.sourceAssertionId}:${operation.targetAssertionId}`;
      if (relationKeys.has(key)) throw new Error(`duplicate assertion relation: ${key}`);
      relationKeys.add(key);
    }
  }
}

function validateEvidenceScope(operations: readonly AssertionOperation[], scope: AssertionChangeSetScope): void {
  for (const operation of operations) {
    for (const locator of operationEvidence(operation)) {
      if (locator.type !== "repository_range") continue;
      if (locator.repository !== scope.repository) {
        throw new Error(`operation ${operation.operationId} evidence repository does not match changeset scope`);
      }
      if (locator.commitSha !== scope.commitSha) {
        throw new Error(`operation ${operation.operationId} evidence commit does not match changeset scope`);
      }
    }
  }
}

function operationEvidence(operation: AssertionOperation): readonly EvidenceLocator[] {
  if (operation.type === "propose") return operation.assertion.evidence;
  if (operation.type === "confirm") return operation.attestations;
  if (operation.type === "supersede") return operation.replacement.evidence;
  return operation.evidence;
}

function validateExpectedScope(actual: AssertionChangeSetScope, expected: AssertionChangeSetScope | undefined): void {
  if (!expected) return;
  for (const key of ["tenantId", "repository", "ref", "commitSha", "kind"] as const) {
    if (actual[key] !== expected[key]) throw new Error(`assertion changeset scope.${key} does not match trusted scope`);
  }
}

function validateExpectedBase(actual: AssertionChangeSetBase, expected: AssertionChangeSetBase | undefined): void {
  if (!expected) return;
  for (const key of ["assertionSetVersion", "registryVersion", "evidenceFingerprint"] as const) {
    if (actual[key] !== expected[key]) throw new Error(`assertion changeset base.${key} does not match trusted base`);
  }
}

function entityKey(entity: ContextGraphEntityRef): string {
  return `${entity.kind}:${entity.naturalKey}`;
}

function requiredArray(value: unknown, name: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  if (value.length > maximum) throw new Error(`${name} exceeds its maximum of ${maximum} items`);
  return value;
}

function nullableTimestamp(value: unknown, name: string): string | null {
  if (value === null) return null;
  const timestamp = requiredString(value, name);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${name} must be an ISO-8601 timestamp`);
  return timestamp;
}

function boundedExplanation(value: unknown, name: string): string {
  const explanation = requiredString(value, name);
  if (explanation.length > ASSERTION_CHANGESET_LIMITS.explanationCharacters) {
    throw new Error(`${name} exceeds the explanation size limit`);
  }
  return explanation;
}

function requiredCommitSha(value: unknown, name: string): string {
  const sha = requiredString(value, name).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error(`${name} must be a full 40-character commit SHA`);
  return sha;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

function assertOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[], owner: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) throw new Error(`${owner} contains unsupported fields: ${unknown.sort().join(", ")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
