import type { OntologyNodeKind } from "./model.js";

export const ONTOLOGY_REGISTRY_VERSION = "repository-context-v5.1";

export const literalTypes = ["string", "int", "decimal", "bool", "timestamp", "json"] as const;
export type LiteralType = (typeof literalTypes)[number];
export type PredicateClass = "relationship" | "attribute" | "inference";
export type ReviewPolicy = "none" | "manual" | { readonly threshold: number };

export interface PredicateDefinition {
  readonly name: string;
  readonly class: PredicateClass;
  readonly subjectKinds: readonly OntologyNodeKind[];
  readonly objectKinds?: readonly OntologyNodeKind[];
  readonly literalTypes?: readonly LiteralType[];
  readonly cardinality: "one" | "many";
  readonly qualifierKeys?: readonly string[];
  readonly review: ReviewPolicy;
  readonly bitemporal: boolean;
  readonly authority?: readonly string[];
}

/**
 * The ontology is code, not runtime data. Inference predicates stay manual until
 * a measured generator/predicate threshold is installed through calibration.
 */
export const predicateRegistry = {
  AUTHORED_BY: {
    name: "AUTHORED_BY", class: "relationship", subjectKinds: ["PullRequest", "Issue"],
    objectKinds: ["Engineer"], cardinality: "many", review: "none", bitemporal: false
  },
  OWNED_BY: {
    name: "OWNED_BY", class: "relationship", subjectKinds: ["Repository", "File", "Symbol"],
    objectKinds: ["Engineer", "Team"], cardinality: "one", qualifierKeys: ["pattern"],
    review: "manual", bitemporal: true, authority: ["human", "codeowners", "model"]
  },
  MEMBER_OF: {
    name: "MEMBER_OF", class: "relationship", subjectKinds: ["Engineer"], objectKinds: ["Team"],
    cardinality: "many", review: "none", bitemporal: true
  },
  INCLUDES: {
    name: "INCLUDES", class: "relationship", subjectKinds: ["PullRequest"], objectKinds: ["Commit"],
    cardinality: "many", review: "none", bitemporal: false
  },
  RESOLVES: {
    name: "RESOLVES", class: "relationship", subjectKinds: ["PullRequest"], objectKinds: ["Issue"],
    cardinality: "many", review: "none", bitemporal: false
  },
  REFERENCES: {
    name: "REFERENCES", class: "relationship", subjectKinds: ["Issue", "PullRequest"],
    objectKinds: ["File", "Symbol", "Commit", "Issue", "PullRequest"], cardinality: "many",
    review: "none", bitemporal: false
  },
  LIKELY_AFFECTS: {
    name: "LIKELY_AFFECTS", class: "inference", subjectKinds: ["Commit", "PullRequest", "Issue"],
    objectKinds: ["File", "Symbol", "Issue"], cardinality: "many", qualifierKeys: ["branch"],
    review: "manual", bitemporal: false
  },
  MOVED_FROM: {
    name: "MOVED_FROM", class: "inference", subjectKinds: ["File", "Symbol"],
    objectKinds: ["File", "Symbol"], cardinality: "one", review: "manual", bitemporal: false
  },
  IMPLEMENTS: {
    name: "IMPLEMENTS", class: "inference", subjectKinds: ["File", "Symbol"],
    objectKinds: ["Issue", "Document"], cardinality: "many", review: "manual", bitemporal: false
  },
  DOCUMENTED_BY: {
    name: "DOCUMENTED_BY", class: "inference", subjectKinds: ["Repository", "File", "Symbol", "Issue", "PullRequest"],
    objectKinds: ["Document"], cardinality: "many", review: "manual", bitemporal: false
  }
} as const satisfies Readonly<Record<string, PredicateDefinition>>;

export type PredicateName = keyof typeof predicateRegistry;

export function predicateDefinition(name: string): PredicateDefinition {
  const definition = (predicateRegistry as Readonly<Record<string, PredicateDefinition>>)[normalizePredicateName(name)];
  if (!definition) throw new Error(`unsupported ontology predicate: ${name}`);
  return definition;
}

export function normalizePredicateName(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

export function validatePredicateEndpoints(
  definition: PredicateDefinition,
  subjectKind: OntologyNodeKind,
  objectKind?: OntologyNodeKind,
  literalType?: LiteralType
): void {
  if (!definition.subjectKinds.includes(subjectKind)) {
    throw new Error(`${definition.name} does not accept subject kind ${subjectKind}`);
  }
  const hasObject = objectKind !== undefined;
  const hasLiteral = literalType !== undefined;
  if (hasObject === hasLiteral) throw new Error(`${definition.name} requires exactly one object or literal`);
  if (objectKind && !definition.objectKinds?.includes(objectKind)) {
    throw new Error(`${definition.name} does not accept object kind ${objectKind}`);
  }
  if (literalType && !definition.literalTypes?.includes(literalType)) {
    throw new Error(`${definition.name} does not accept literal type ${literalType}`);
  }
}

export function validateQualifiers(definition: PredicateDefinition, qualifiers: Readonly<Record<string, unknown>> = {}): void {
  const allowed = new Set(definition.qualifierKeys ?? []);
  for (const [key, value] of Object.entries(qualifiers)) {
    if (!allowed.has(key)) throw new Error(`${definition.name} does not declare qualifier ${key}`);
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`${definition.name} qualifier ${key} must be a string, number, or boolean`);
    }
  }
}
