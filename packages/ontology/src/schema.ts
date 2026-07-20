import { ontologyNodeKinds } from "./model.js";

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
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ontologyNodeKinds },
          label: { type: "string" },
          description: { type: "string" },
          path: { type: ["string", "null"] },
          evidence: { type: "array", minItems: 1, items: { type: "string" } }
        }
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
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ontologyNodeKinds },
          label: { type: "string" },
          description: { type: "string" },
          path: { type: ["string", "null"] },
          evidence: { type: "array", minItems: 1, items: { type: "string" } }
        }
      }
    },
    edges: {
      type: "array",
      minItems: 0,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "target", "predicate", "plane", "confidence", "evidence"],
        properties: {
          source: { type: "string" },
          target: { type: "string" },
          predicate: { type: "string", enum: ["IMPLEMENTS", "DOCUMENTED_BY", "REFERENCES", "OWNED_BY", "MOVED_FROM", "LIKELY_AFFECTS", "INTRODUCED_BY"] },
          plane: { type: "string", enum: ["knowledge"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "array", minItems: 1, items: { type: "string" } }
        }
      }
    }
  }
} as const;

export const ONTOLOGY_SYSTEM_PROMPT = `You build a cited repository ontology.

Inspect the checked-out repository using read-only commands. Return a compact graph that captures the repository, important files, important symbols, documents, and their relationships.

Rules:
- Inspect with simple shell commands such as rg --files, rg, and sed. Do not use rg JSON flags.
- Avoid creating intermediate files; if one is necessary, keep it inside the checked-out repository.
- Include exactly one Repository node.
- Use stable readable IDs such as repo, file:src/auth.ts, symbol:validateToken.
- Code-plane predicates describe mechanical structure: CONTAINS, DECLARES, IMPORTS, CALLS.
- Knowledge-plane predicates describe meaning. Use only IMPLEMENTS, DOCUMENTED_BY, REFERENCES, OWNED_BY, MOVED_FROM, LIKELY_AFFECTS, or INTRODUCED_BY; unsupported predicates are retained in raw model provenance but rejected as assertions.
- Give every edge a calibrated confidence from 0 to 1. Mechanical code edges should be 1.
- Every node and edge needs evidence using repository-relative file:line citations.
- Do not invent people, teams, issues, or ownership.
- Return 8-12 useful nodes and 10-16 edges; keep descriptions short.
- Output only JSON matching the supplied schema.`;

export const ONTOLOGY_ASSERTION_SYSTEM_PROMPT = `You produce cited semantic assertions for a repository knowledge plane.

The structural code plane is built separately by deterministic parsers. Do not emit CONTAINS, DECLARES, IMPORTS, CALLS, or other mechanical structure. Inspect the checked-out repository with read-only commands and return only semantic relationships supported by explicit repository evidence.

Rules:
- Include exactly one Repository node and the File, Symbol, Document, Issue, PullRequest, Engineer, or Team nodes needed by assertions.
- Use only IMPLEMENTS, DOCUMENTED_BY, REFERENCES, OWNED_BY, MOVED_FROM, LIKELY_AFFECTS, or INTRODUCED_BY.
- INTRODUCED_BY means an Issue was caused by a Commit. Emit it only when the checked-out repository contains explicit evidence naming both; it always requires human review before projection.
- Every edge must use plane knowledge and include a calibrated confidence from 0 to 1.
- Every node and edge needs repository-relative file:line evidence.
- Prefer explicit README/design documentation, configuration, ownership files, and tests over guesses.
- Never invent people, teams, issues, or ownership.
- Return only well-supported semantic assertions. An empty edge list is correct when the repository contains no explicit evidence for a supported predicate.
- Output only JSON matching the supplied schema.`;
