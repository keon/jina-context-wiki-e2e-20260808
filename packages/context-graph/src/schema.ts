import { contextGraphNodeKinds } from "./model.js";
import {
  ASSERTION_CHANGESET_CONTRACT_VERSION,
  ASSERTION_CHANGESET_LIMITS,
  assertionQualifierKeys,
  assertionRelationKinds,
  assertionScopeKinds,
  assertionTruthClasses
} from "./assertion-changeset.js";
import { predicateRegistry } from "./registry.js";

const nullableQualifierSchema = {
  oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }]
} as const;

const assertionQualifierProperties = Object.fromEntries(
  assertionQualifierKeys.map((key) => [key, nullableQualifierSchema])
);

const assertionEvidenceLocatorSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "repository", "commitSha", "path", "startLine", "endLine", "contentDigest"],
      properties: {
        type: { const: "repository_range" },
        repository: { type: "string", minLength: 1 },
        commitSha: { type: "string", pattern: "^[a-fA-F0-9]{40}$" },
        path: { type: "string", minLength: 1 },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
        contentDigest: { type: ["string", "null"] }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "observationId", "observationType"],
      properties: {
        type: { const: "source_observation" },
        observationId: { type: "string", minLength: 1 },
        observationType: { type: "string", minLength: 1 }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "assertionId", "attestationId"],
      properties: {
        type: { const: "assertion_attestation" },
        assertionId: { type: "string", minLength: 1 },
        attestationId: { type: "string", minLength: 1 }
      }
    }
  ]
} as const;

const assertionEvidenceListSchema = {
  type: "array",
  minItems: 1,
  maxItems: ASSERTION_CHANGESET_LIMITS.evidencePerOperation,
  items: assertionEvidenceLocatorSchema
} as const;

const assertionEntityReferenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "naturalKey", "label"],
  properties: {
    kind: { type: "string", enum: contextGraphNodeKinds },
    naturalKey: { type: "string", minLength: 1 },
    label: { type: "string", minLength: 1 }
  }
} as const;

const assertionCandidateSchema = {
  type: "object",
  additionalProperties: false,
  required: [
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
  properties: {
    subject: assertionEntityReferenceSchema,
    predicate: { type: "string", enum: Object.keys(predicateRegistry) },
    object: assertionEntityReferenceSchema,
    qualifiers: {
      type: "object",
      additionalProperties: false,
      required: assertionQualifierKeys,
      properties: assertionQualifierProperties
    },
    truthClass: { type: "string", enum: assertionTruthClasses },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    explanation: { type: "string", minLength: 1, maxLength: ASSERTION_CHANGESET_LIMITS.explanationCharacters },
    evidence: assertionEvidenceListSchema,
    validFrom: { type: ["string", "null"] },
    validUntil: { type: ["string", "null"] }
  }
} as const;

const assertionOperationSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["operationId", "type", "assertion"],
      properties: {
        operationId: { type: "string", minLength: 1 },
        type: { const: "propose" },
        assertion: assertionCandidateSchema
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["operationId", "type", "assertionId", "attestations", "reason"],
      properties: {
        operationId: { type: "string", minLength: 1 },
        type: { const: "confirm" },
        assertionId: { type: "string", minLength: 1 },
        attestations: assertionEvidenceListSchema,
        reason: { type: "string", minLength: 1, maxLength: ASSERTION_CHANGESET_LIMITS.explanationCharacters }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["operationId", "type", "assertionId", "replacement", "reason"],
      properties: {
        operationId: { type: "string", minLength: 1 },
        type: { const: "supersede" },
        assertionId: { type: "string", minLength: 1 },
        replacement: assertionCandidateSchema,
        reason: { type: "string", minLength: 1, maxLength: ASSERTION_CHANGESET_LIMITS.explanationCharacters }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["operationId", "type", "assertionId", "evidence", "reason"],
      properties: {
        operationId: { type: "string", minLength: 1 },
        type: { const: "retract" },
        assertionId: { type: "string", minLength: 1 },
        evidence: assertionEvidenceListSchema,
        reason: { type: "string", minLength: 1, maxLength: ASSERTION_CHANGESET_LIMITS.explanationCharacters }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["operationId", "type", "relation", "sourceAssertionId", "targetAssertionId", "evidence", "reason"],
      properties: {
        operationId: { type: "string", minLength: 1 },
        type: { const: "relate" },
        relation: { type: "string", enum: assertionRelationKinds },
        sourceAssertionId: { type: "string", minLength: 1 },
        targetAssertionId: { type: "string", minLength: 1 },
        evidence: assertionEvidenceListSchema,
        reason: { type: "string", minLength: 1, maxLength: ASSERTION_CHANGESET_LIMITS.explanationCharacters }
      }
    }
  ]
} as const;

export const ASSERTION_CHANGESET_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["contractVersion", "changeSetId", "scope", "base", "summary", "operations", "unresolved"],
  properties: {
    contractVersion: { const: ASSERTION_CHANGESET_CONTRACT_VERSION },
    changeSetId: { type: "string", minLength: 1 },
    scope: {
      type: "object",
      additionalProperties: false,
      required: ["tenantId", "repository", "ref", "commitSha", "kind"],
      properties: {
        tenantId: { type: "string", minLength: 1 },
        repository: { type: "string", minLength: 1 },
        ref: { type: "string", minLength: 1 },
        commitSha: { type: "string", pattern: "^[a-fA-F0-9]{40}$" },
        kind: { type: "string", enum: assertionScopeKinds }
      }
    },
    base: {
      type: "object",
      additionalProperties: false,
      required: ["assertionSetVersion", "registryVersion", "evidenceFingerprint"],
      properties: {
        assertionSetVersion: { type: "string", minLength: 1 },
        registryVersion: { type: "string", minLength: 1 },
        evidenceFingerprint: { type: "string", minLength: 1 }
      }
    },
    summary: { type: "string", minLength: 1 },
    operations: {
      type: "array",
      maxItems: ASSERTION_CHANGESET_LIMITS.operations,
      items: assertionOperationSchema
    },
    unresolved: {
      type: "array",
      maxItems: ASSERTION_CHANGESET_LIMITS.unresolvedFindings,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["findingId", "question", "reason", "requiredEvidence", "suggestedAction"],
        properties: {
          findingId: { type: "string", minLength: 1 },
          question: {
            type: "string",
            minLength: 1,
            maxLength: ASSERTION_CHANGESET_LIMITS.explanationCharacters
          },
          reason: {
            type: "string",
            minLength: 1,
            maxLength: ASSERTION_CHANGESET_LIMITS.explanationCharacters
          },
          requiredEvidence: {
            type: "array",
            maxItems: ASSERTION_CHANGESET_LIMITS.requiredEvidencePerFinding,
            items: { type: "string", minLength: 1 }
          },
          suggestedAction: { type: "string", minLength: 1 }
        }
      }
    }
  }
} as const;

const contextGraphNodeProperties = {
  id: { type: "string", maxLength: 512 },
  kind: { type: "string", enum: contextGraphNodeKinds },
  label: { type: "string", maxLength: 300 },
  description: { type: "string", maxLength: 1_000 },
  path: { type: ["string", "null"], maxLength: 1_024 },
  evidence: { type: "array", minItems: 1, maxItems: 4, items: { type: "string", maxLength: 512 } }
} as const;

export const CONTEXT_GRAPH_ASSERTION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "nodes", "edges"],
  properties: {
    summary: { type: "string", maxLength: 4_000 },
    nodes: {
      type: "array",
      minItems: 1,
      maxItems: 128,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "label", "description", "path", "evidence"],
        properties: contextGraphNodeProperties
      }
    },
    edges: {
      type: "array",
      minItems: 0,
      maxItems: 256,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "target", "predicate", "plane", "confidence", "why", "evidence"],
        properties: {
          source: { type: "string", maxLength: 512 },
          target: { type: "string", maxLength: 512 },
          predicate: {
            type: "string",
            enum: [
              "IMPLEMENTS",
              "DOCUMENTED_BY",
              "REFERENCES",
              "OWNED_BY",
              "MOVED_FROM",
              "LIKELY_AFFECTS",
              "INTRODUCED_BY",
              "RESOLVED_BY",
              "INCIDENT_IMPACTS"
            ]
          },
          plane: { type: "string", enum: ["knowledge"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          why: { type: "string", minLength: 1, maxLength: 1_000 },
          evidence: { type: "array", minItems: 1, maxItems: 4, items: { type: "string", maxLength: 512 } }
        }
      }
    }
  }
} as const;

export const CONTEXT_GRAPH_ASSERTION_SYSTEM_PROMPT = `You produce cited semantic assertions for a repository knowledge plane.

The structural code plane is built separately by deterministic parsers. Do not emit CONTAINS, DECLARES, IMPORTS, CALLS, or other mechanical structure. Analyze only the supplied repository-evidence and source-observations, and return only semantic relationships supported by that explicit evidence.

Rules:
- Include exactly one Repository node and the File, Symbol, Document, Feature, Package, Service, Deployment, Incident, Issue, PullRequest, Engineer, or Team nodes needed by assertions.
- Use only IMPLEMENTS, DOCUMENTED_BY, REFERENCES, OWNED_BY, MOVED_FROM, LIKELY_AFFECTS, INTRODUCED_BY, RESOLVED_BY, or INCIDENT_IMPACTS. Package dependencies, source-backed deployment facts, and explicit Incident-to-Deployment history are produced by deterministic intake, not this model.
- Use bare positive GitHub numbers for external Issue and PullRequest node IDs and the bare full 40-character SHA for Commit node IDs.
- Use feature:<stable-slug> for Feature, package:<ecosystem>:<name> for Package, service:<source>:<external-id> for Service, deployment:<source>:<external-id> for Deployment, and incident:<source>:<external-id> for Incident. Source-backed identifiers must match an immutable source observation.
- A Feature is a named, externally observable product capability supported by explicit docs, tests, or source behavior. Use id feature:<stable-kebab-slug>. Do not turn files, components, chores, or implementation details into Features. Connect code with File/Symbol IMPLEMENTS Feature, documentation with Feature DOCUMENTED_BY Document, and reviewed potential impact with Commit/PullRequest/Issue LIKELY_AFFECTS Feature.
- For every named Feature, inventory every distinct current File or Symbol that explicit documentation, tests, or source behavior shows implements that same capability. Emit a separate IMPLEMENTS edge for each supported implementation. Do not split a primary and compatibility implementation into generic implementation-detail Features when the evidence connects both to the same externally observable capability.
 - Explicit GitHub issue resolution is already projected deterministically from intake. Do not repeat it. Inspect every pull request in source-observations. When a merged pull request has no explicit resolving issue and clearly fixes a bug, regression, or incorrect behavior, create one Issue node with id derived:pr:<pull-request-number> and emit Issue RESOLVED_BY PullRequest. Its label is a concise issue title and its description states the problem, not the implementation. Do not derive issues for refactors, dependencies, documentation, chores, or feature-only work.
 - The number in derived:pr:<n> and the RESOLVED_BY target are always the fixing pull request from source-observations. A different pull request named in repository evidence as introducing or causing the problem is not the derived anchor or resolution target.
 - Never use derived:pr:<n> when the pull-request observation already has a nonempty resolvesIssueNumbers list. Never invent a GitHub issue number. The host derives a stable Issue natural key from the PR anchor, so reruns resolve to the same entity.
 - Every edge must include a nonempty why field that concisely explains how the cited evidence supports that specific relationship. Do not merely restate the predicate. INTRODUCED_BY means an Issue or Incident was caused by a Commit or Deployment, and its why must explain the causal mechanism. Emit it only when the checked-out repository contains explicit evidence naming both endpoints and the reason.
- When a changed root-cause document explicitly names an Issue, full commit SHA, and causal mechanism, emit the supported Issue INTRODUCED_BY Commit assertion instead of reducing it to a generic reference. The INTRODUCED_BY edge's own evidence range—not merely its endpoint node evidence—must span the issue identity, full SHA, and causal explanation. Never repeat Incident INTRODUCED_BY Deployment or Incident RESOLVED_BY Deployment facts; repository intake owns them.
- Every edge must use plane knowledge and include a calibrated confidence from 0 to 1.
- Every node and edge needs repository-relative file:line evidence.
- Prefer explicit README/design documentation, configuration, ownership files, and tests over guesses.
- When repository evidence explicitly states that a current File or Symbol moved or was renamed from a previous File or Symbol while retaining the same feature, emit current MOVED_FROM previous with that evidence. Do not omit this continuity merely because the previous path is absent from the current tree.
- A deterministic move_candidate observation is only a similarity candidate. Emit MOVED_FROM only when repository evidence explicitly supports continuity.
- Map repository configuration to Service or Feature only when explicit evidence supports the semantic relationship. Never repeat deterministic Package, DEPLOYS, TARGETS, or DEPENDS_ON facts.
- Never invent people, teams, external issue numbers, or ownership. A derived Issue is permitted only by the derived Issue rule above.
- Before emitting JSON, perform a final synthesis pass over all candidate edges. Group candidates by semantic identity: subject, predicate, object, and meaning-bearing qualifiers. Aggregate all non-duplicate evidence for each group, keep the strongest calibrated confidence, and write one concise explanation that synthesizes the supported claim.
- During that final synthesis pass, perform a coverage check for every named Feature: compare all supplied documentation, tests, and source paths, and retain every independently cited current implementation rather than only the highest-confidence example.
- Emit exactly one edge per semantic identity. Different wording, causal-reason prose, evidence ranges, or investigation paths do not create different assertions. Preserve genuinely different relationships only when a meaning-bearing qualifier changes the claim itself.
- Return only well-supported semantic assertions. An empty edge list is correct when the repository contains no explicit evidence for a supported predicate.
- Output only JSON matching the supplied schema.`;
