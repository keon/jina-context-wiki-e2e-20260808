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
          evidence: { type: "array", items: { type: "string" } }
        }
      }
    },
    edges: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "target", "predicate", "plane", "evidence"],
        properties: {
          source: { type: "string" },
          target: { type: "string" },
          predicate: { type: "string" },
          plane: { type: "string", enum: ["code", "knowledge"] },
          evidence: { type: "array", items: { type: "string" } }
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
- Knowledge-plane predicates describe meaning: IMPLEMENTS, DOCUMENTED_BY, REFERENCES, OWNED_BY.
- Every node and edge needs evidence using repository-relative file:line citations.
- Do not invent people, teams, issues, or ownership.
- Return 8-12 useful nodes and 10-16 edges; keep descriptions short.
- Output only JSON matching the supplied schema.`;
