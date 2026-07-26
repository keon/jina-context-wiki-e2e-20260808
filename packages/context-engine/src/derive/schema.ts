import {
  knowledgeDocumentKinds,
  type KnowledgeDocumentDraft,
  type KnowledgeDocumentDraftCitation,
  type KnowledgeGenerationOutput,
  type KnowledgeScope
} from "../domain/knowledge.js";

export const KNOWLEDGE_OUTPUT_SCHEMA_VERSION = "knowledge-documents-v2";

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(input: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const extras = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${path} has unsupported fields: ${extras.join(", ")}`);
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string`);
  return value.trim();
}

function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${path} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined || value === null ? undefined : string(value, path);
}

function optionalPositiveInteger(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${path} must be a positive integer`);
  return value as number;
}

function parseScope(value: unknown, path: string): Omit<KnowledgeScope, "ref" | "commitSha"> {
  const input = object(value, path);
  onlyKeys(input, ["paths", "symbols", "pullRequests", "issues"], path);
  return {
    paths: strings(input.paths, `${path}.paths`),
    symbols: strings(input.symbols, `${path}.symbols`),
    pullRequests: strings(input.pullRequests, `${path}.pullRequests`),
    issues: strings(input.issues, `${path}.issues`)
  };
}

function parseCitation(value: unknown, path: string): KnowledgeDocumentDraftCitation {
  const input = object(value, path);
  onlyKeys(input, ["claim", "sourceType", "sourceId", "pathOrUrl", "startLine", "endLine", "jsonPointer"], path);
  const sourceType = string(input.sourceType, `${path}.sourceType`);
  if (!["observation", "blob", "commit", "pull_request", "issue", "document"].includes(sourceType)) {
    throw new Error(`${path}.sourceType is unsupported`);
  }
  return {
    claim: string(input.claim, `${path}.claim`),
    sourceType: sourceType as KnowledgeDocumentDraftCitation["sourceType"],
    sourceId: string(input.sourceId, `${path}.sourceId`),
    ...(optionalString(input.pathOrUrl, `${path}.pathOrUrl`) === undefined
      ? {}
      : { pathOrUrl: optionalString(input.pathOrUrl, `${path}.pathOrUrl`)! }),
    ...(optionalPositiveInteger(input.startLine, `${path}.startLine`) === undefined
      ? {}
      : { startLine: optionalPositiveInteger(input.startLine, `${path}.startLine`)! }),
    ...(optionalPositiveInteger(input.endLine, `${path}.endLine`) === undefined
      ? {}
      : { endLine: optionalPositiveInteger(input.endLine, `${path}.endLine`)! }),
    ...(optionalString(input.jsonPointer, `${path}.jsonPointer`) === undefined
      ? {}
      : { jsonPointer: optionalString(input.jsonPointer, `${path}.jsonPointer`)! })
  };
}

function parseStructuredSummary(value: unknown, path: string): Record<string, unknown> {
  const input = object(value, path);
  onlyKeys(input, ["facts", "claimSubject", "claimValue"], path);
  return {
    facts: strings(input.facts, `${path}.facts`),
    ...(optionalString(input.claimSubject, `${path}.claimSubject`) === undefined
      ? {}
      : { claimSubject: optionalString(input.claimSubject, `${path}.claimSubject`)! }),
    ...(optionalString(input.claimValue, `${path}.claimValue`) === undefined
      ? {}
      : { claimValue: optionalString(input.claimValue, `${path}.claimValue`)! })
  };
}

function parseDocument(value: unknown, path: string): KnowledgeDocumentDraft {
  const input = object(value, path);
  onlyKeys(
    input,
    ["logicalId", "kind", "title", "summary", "bodyMarkdown", "structuredSummary", "scope", "confidence", "citations"],
    path
  );
  const kind = string(input.kind, `${path}.kind`);
  if (!knowledgeDocumentKinds.includes(kind as KnowledgeDocumentDraft["kind"])) {
    throw new Error(`${path}.kind is unsupported`);
  }
  if (!Array.isArray(input.citations) || input.citations.length === 0) {
    throw new Error(`${path}.citations must contain at least one citation`);
  }
  if (typeof input.confidence !== "number" || !Number.isFinite(input.confidence)) {
    throw new Error(`${path}.confidence must be a number`);
  }
  return {
    logicalId: string(input.logicalId, `${path}.logicalId`).toLowerCase(),
    kind: kind as KnowledgeDocumentDraft["kind"],
    title: string(input.title, `${path}.title`),
    summary: string(input.summary, `${path}.summary`),
    bodyMarkdown: string(input.bodyMarkdown, `${path}.bodyMarkdown`),
    structuredSummary: parseStructuredSummary(input.structuredSummary, `${path}.structuredSummary`),
    scope: parseScope(input.scope, `${path}.scope`),
    confidence: input.confidence,
    citations: input.citations.map((citation, index) => parseCitation(citation, `${path}.citations[${index}]`))
  };
}

export function parseKnowledgeGenerationOutput(value: unknown): KnowledgeGenerationOutput {
  const input = object(value, "output");
  const prohibited = ["nodes", "edges", "predicates", "operations"];
  for (const field of prohibited) {
    if (field in input) throw new Error(`output.${field} is prohibited`);
  }
  onlyKeys(input, ["documents"], "output");
  if (!Array.isArray(input.documents)) throw new Error("output.documents must be an array");
  if (input.documents.length > 50) throw new Error("output.documents exceeds the maximum of 50");
  return { documents: input.documents.map((document, index) => parseDocument(document, `documents[${index}]`)) };
}

export const knowledgeGenerationJsonSchema = {
  $id: KNOWLEDGE_OUTPUT_SCHEMA_VERSION,
  type: "object",
  additionalProperties: false,
  required: ["documents"],
  properties: {
    documents: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          logicalId: { type: "string", minLength: 1 },
          kind: { type: "string", enum: knowledgeDocumentKinds },
          title: { type: "string", minLength: 1 },
          summary: { type: "string", minLength: 1 },
          bodyMarkdown: { type: "string", minLength: 1 },
          structuredSummary: {
            type: "object",
            additionalProperties: false,
            properties: {
              facts: {
                type: "array",
                maxItems: 100,
                items: { type: "string", minLength: 1 }
              },
              claimSubject: { type: ["string", "null"], minLength: 1 },
              claimValue: { type: ["string", "null"], minLength: 1 }
            },
            required: ["facts", "claimSubject", "claimValue"]
          },
          scope: {
            type: "object",
            additionalProperties: false,
            properties: {
              paths: { type: "array", maxItems: 500, items: { type: "string", minLength: 1 } },
              symbols: { type: "array", maxItems: 500, items: { type: "string", minLength: 1 } },
              pullRequests: { type: "array", maxItems: 500, items: { type: "string", minLength: 1 } },
              issues: { type: "array", maxItems: 500, items: { type: "string", minLength: 1 } }
            },
            required: ["paths", "symbols", "pullRequests", "issues"]
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          citations: {
            type: "array",
            minItems: 1,
            maxItems: 500,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                claim: { type: "string", minLength: 1 },
                sourceType: {
                  type: "string",
                  enum: ["observation", "blob", "commit", "pull_request", "issue", "document"]
                },
                sourceId: { type: "string", minLength: 1 },
                pathOrUrl: { type: ["string", "null"], minLength: 1 },
                startLine: { type: ["integer", "null"], minimum: 1 },
                endLine: { type: ["integer", "null"], minimum: 1 },
                jsonPointer: { type: ["string", "null"], minLength: 1 }
              },
              required: ["claim", "sourceType", "sourceId", "pathOrUrl", "startLine", "endLine", "jsonPointer"]
            }
          }
        },
        required: [
          "logicalId",
          "kind",
          "title",
          "summary",
          "bodyMarkdown",
          "structuredSummary",
          "scope",
          "confidence",
          "citations"
        ]
      }
    }
  }
} as const;
