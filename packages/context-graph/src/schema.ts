import { contextGraphNodeKinds } from "./model.js";

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
 - Explicit GitHub issue resolution is already projected deterministically from intake. Do not repeat it. Inspect every pull request in source-observations. When a merged pull request has no explicit resolving issue and clearly fixes a bug, regression, or incorrect behavior, create one Issue node with id derived:pr:<pull-request-number> and emit Issue RESOLVED_BY PullRequest. Its label is a concise issue title and its description states the problem, not the implementation. Do not derive issues for refactors, dependencies, documentation, chores, or feature-only work.
 - The number in derived:pr:<n> and the RESOLVED_BY target are always the fixing pull request from source-observations. A different pull request named in repository evidence as introducing or causing the problem is not the derived anchor or resolution target.
 - Never use derived:pr:<n> when the pull-request observation already has a nonempty resolvesIssueNumbers list. Never invent a GitHub issue number. The host derives a stable Issue natural key from the PR anchor, so reruns resolve to the same entity.
 - Every edge must include a nonempty why field that concisely explains how the cited evidence supports that specific relationship. Do not merely restate the predicate. INTRODUCED_BY means an Issue or Incident was caused by a Commit or Deployment, and its why must explain the causal mechanism. Emit it only when the checked-out repository contains explicit evidence naming both endpoints and the reason; it always requires human review before projection.
- When a changed root-cause document explicitly names an Issue, full commit SHA, and causal mechanism, emit the supported Issue INTRODUCED_BY Commit assertion instead of reducing it to a generic reference. The INTRODUCED_BY edge's own evidence range—not merely its endpoint node evidence—must span the issue identity, full SHA, and causal explanation. Never repeat Incident INTRODUCED_BY Deployment or Incident RESOLVED_BY Deployment facts; repository intake owns them.
- Every edge must use plane knowledge and include a calibrated confidence from 0 to 1.
- Every node and edge needs repository-relative file:line evidence.
- Prefer explicit README/design documentation, configuration, ownership files, and tests over guesses.
- When repository evidence explicitly states that a current File or Symbol moved or was renamed from a previous File or Symbol while retaining the same feature, emit current MOVED_FROM previous with that evidence. Do not omit this continuity merely because the previous path is absent from the current tree.
- A deterministic move_candidate observation is only a similarity candidate. Emit MOVED_FROM only when repository evidence supports continuity, and keep it proposed for review.
- Map suggestive repository configuration to Service or Feature only as a proposed model assertion. Never repeat deterministic Package, DEPLOYS, TARGETS, or DEPENDS_ON facts.
- Never invent people, teams, external issue numbers, or ownership. A derived Issue is permitted only by the derived Issue rule above.
- Return only well-supported semantic assertions. An empty edge list is correct when the repository contains no explicit evidence for a supported predicate.
- Output only JSON matching the supplied schema.`;
