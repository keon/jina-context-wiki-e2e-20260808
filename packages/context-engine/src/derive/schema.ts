import {
  knowledgeDocumentKinds,
  type KnowledgeDocumentDraft,
  type KnowledgeDocumentDraftCitation,
  type KnowledgeGenerationOutput,
  type KnowledgeScope
} from "../domain/knowledge.js";

export const KNOWLEDGE_OUTPUT_SCHEMA_VERSION = "knowledge-documents-v1";

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
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
  return value === undefined ? undefined : string(value, path);
}

function optionalPositiveInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${path} must be a positive integer`);
  return value as number;
}

function parseScope(value: unknown, path: string): Omit<KnowledgeScope, "ref" | "commitSha"> {
  const input = object(value, path);
  return {
    paths: strings(input.paths, `${path}.paths`),
    symbols: strings(input.symbols, `${path}.symbols`),
    pullRequests: strings(input.pullRequests, `${path}.pullRequests`),
    issues: strings(input.issues, `${path}.issues`)
  };
}

function parseCitation(value: unknown, path: string): KnowledgeDocumentDraftCitation {
  const input = object(value, path);
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

function parseDocument(value: unknown, path: string): KnowledgeDocumentDraft {
  const input = object(value, path);
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
    structuredSummary: object(input.structuredSummary, `${path}.structuredSummary`),
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
