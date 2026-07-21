import { ontologyNodeKinds } from "./model.js";

const ontologyNodeProperties = {
  id: { type: "string" },
  kind: { type: "string", enum: ontologyNodeKinds },
  label: { type: "string" },
  description: { type: "string" },
  path: { type: ["string", "null"] },
  evidence: { type: "array", minItems: 1, items: { type: "string" } }
} as const;

export const ONTOLOGY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "nodes", "edges"],
  properties: {
    summary: { type: "string" },
    nodes: {
      type: "array",
      minItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "label", "description", "path", "evidence"],
        properties: ontologyNodeProperties
      }
    },
    edges: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "target", "predicate", "plane", "confidence", "evidence"],
        properties: {
          source: { type: "string" },
          target: { type: "string" },
          predicate: { type: "string" },
          plane: { type: "string", enum: ["code", "knowledge"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "array", minItems: 1, items: { type: "string" } }
        }
      }
    }
  }
} as const;

export const ONTOLOGY_ASSERTION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "nodes", "edges"],
  properties: {
    summary: { type: "string" },
    nodes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "label", "description", "path", "evidence"],
        properties: ontologyNodeProperties
      }
    },
    edges: {
      type: "array",
      minItems: 0,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "target", "predicate", "plane", "confidence", "why", "evidence"],
        properties: {
          source: { type: "string" },
          target: { type: "string" },
          predicate: { type: "string", enum: ["IMPLEMENTS", "DOCUMENTED_BY", "REFERENCES", "OWNED_BY", "MOVED_FROM", "LIKELY_AFFECTS", "INTRODUCED_BY", "RESOLVED_BY", "INCIDENT_IMPACTS"] },
          plane: { type: "string", enum: ["knowledge"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          why: { type: "string", minLength: 1 },
          evidence: { type: "array", minItems: 1, items: { type: "string" } }
        }
      }
    }
  }
} as const;

export const ONTOLOGY_SYSTEM_PROMPT = `You build a cited repository ontology.

Inspect the checked-out repository using read-only commands. Return a compact graph that captures the repository, important files, important symbols, documents, product features, and their relationships.

Rules:
- Inspect with simple shell commands such as rg --files, rg, and sed. Do not use rg JSON flags.
- Avoid creating intermediate files; if one is necessary, keep it inside the checked-out repository.
- Include exactly one Repository node.
- Use stable readable IDs such as repo, file:src/auth.ts, symbol:validateToken, and feature:administrator-deletion.
- Code-plane predicates describe mechanical structure: CONTAINS, DECLARES, IMPORTS, CALLS.
- Knowledge-plane predicates describe meaning. Use only IMPLEMENTS, DOCUMENTED_BY, REFERENCES, OWNED_BY, MOVED_FROM, LIKELY_AFFECTS, INTRODUCED_BY, RESOLVED_BY, or INCIDENT_IMPACTS; unsupported predicates are retained in raw model provenance but rejected as assertions.
- Give every edge a calibrated confidence from 0 to 1. Mechanical code edges should be 1.
- Every node and edge needs evidence using repository-relative file:line citations.
- Do not invent people, teams, issues, or ownership.
- Return 8-12 useful nodes and 10-16 edges; keep descriptions short.
- Output only JSON matching the supplied schema.`;

export const ONTOLOGY_ASSERTION_SYSTEM_PROMPT = `You produce cited semantic assertions for a repository knowledge plane.

The structural code plane is built separately by deterministic parsers. Do not emit CONTAINS, DECLARES, IMPORTS, CALLS, or other mechanical structure. Inspect the checked-out repository with read-only commands and return only semantic relationships supported by explicit repository evidence.

Rules:
- Include exactly one Repository node and the File, Symbol, Document, Feature, Package, Service, Deployment, Incident, Issue, PullRequest, Engineer, or Team nodes needed by assertions.
- Use only IMPLEMENTS, DOCUMENTED_BY, REFERENCES, OWNED_BY, MOVED_FROM, LIKELY_AFFECTS, INTRODUCED_BY, RESOLVED_BY, or INCIDENT_IMPACTS. Package dependencies and source-backed deployment facts are produced by deterministic intake, not this model.
- Use bare positive GitHub numbers for external Issue and PullRequest node IDs and the bare full 40-character SHA for Commit node IDs.
- Use feature:<stable-slug> for Feature, package:<ecosystem>:<name> for Package, service:<source>:<external-id> for Service, deployment:<source>:<external-id> for Deployment, and incident:<source>:<external-id> for Incident. Source-backed identifiers must match an immutable source observation.
- A Feature is a named, externally observable product capability supported by explicit docs, tests, or source behavior. Use id feature:<stable-kebab-slug>. Do not turn files, components, chores, or implementation details into Features. Connect code with File/Symbol IMPLEMENTS Feature, documentation with Feature DOCUMENTED_BY Document, and reviewed potential impact with Commit/PullRequest/Issue LIKELY_AFFECTS Feature.
 - Explicit GitHub issue resolution is already projected deterministically from intake. Do not repeat it. Inspect every pull request in the source-evidence file. When a merged pull request has no explicit resolving issue and clearly fixes a bug, regression, or incorrect behavior, create one Issue node with id derived:pr:<pull-request-number> and emit Issue RESOLVED_BY PullRequest. Its label is a concise issue title and its description states the problem, not the implementation. Do not derive issues for refactors, dependencies, documentation, chores, or feature-only work.
 - Never use derived:pr:<n> when the pull-request observation already has a nonempty resolvesIssueNumbers list. Never invent a GitHub issue number. The host derives a stable Issue natural key from the PR anchor, so reruns resolve to the same entity.
 - Every edge must include a nonempty why field that concisely explains how the cited evidence supports that specific relationship. Do not merely restate the predicate. INTRODUCED_BY means an Issue or Incident was caused by a Commit or Deployment, and its why must explain the causal mechanism. Emit it only when the checked-out repository contains explicit evidence naming both endpoints and the reason; it always requires human review before projection.
- When a changed root-cause or incident document explicitly names that issue, full commit SHA, and causal mechanism, emit the supported INTRODUCED_BY assertion instead of reducing it to a generic reference. The INTRODUCED_BY edge's own evidence range—not merely its endpoint node evidence—must span the issue identity, full SHA, and causal explanation.
- Every edge must use plane knowledge and include a calibrated confidence from 0 to 1.
- Every node and edge needs repository-relative file:line evidence.
- Prefer explicit README/design documentation, configuration, ownership files, and tests over guesses.
- A deterministic move_candidate observation is only a similarity candidate. Emit MOVED_FROM only when repository evidence supports continuity, and keep it proposed for review.
- Map suggestive repository configuration to Service or Feature only as a proposed model assertion. Never repeat deterministic Package, DEPLOYS, TARGETS, or DEPENDS_ON facts.
- Never invent people, teams, external issue numbers, or ownership. A derived Issue is permitted only by the derived Issue rule above.
- Return only well-supported semantic assertions. An empty edge list is correct when the repository contains no explicit evidence for a supported predicate.
- Output only JSON matching the supplied schema.`;
