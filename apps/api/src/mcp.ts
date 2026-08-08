import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as z from "zod/v4";
import { parseWikiSelector, type WikiSelector } from "./context-wiki-query.js";

export interface ContextMcpHandlers {
  search(input: {
    repository: string;
    query: string;
    selector?: WikiSelector;
    locale?: string;
    limit?: number;
  }): Promise<unknown>;
  list(input: { repository: string; selector?: WikiSelector; locale?: string }): Promise<unknown>;
  read(input: { repository: string; document: string; selector?: WikiSelector; locale?: string }): Promise<unknown>;
  diff(input: { repository: string; fromReleaseId: string; toReleaseId: string }): Promise<unknown>;
  ask(input: {
    repository: string;
    question: string;
    selector?: WikiSelector;
    locale?: string;
    maxEvidenceItems?: number;
  }): Promise<unknown>;
}

const repository = z.string().trim().min(1).max(300).describe("Repository name, for example omlabs/jina");
const branch = z.string().trim().min(1).max(255).optional().describe("Git branch name");
const pullRequest = z.number().int().positive().optional().describe("GitHub pull request number");
const commitSha = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{40}$/)
  .optional()
  .describe("Full Git commit SHA");
const ref = z.string().trim().min(1).max(300).optional().describe("Legacy canonical ref selector");
const releaseId = z.string().trim().min(1).max(300).optional().describe("Immutable context release ID");
const locale = z.string().trim().min(2).max(80).optional().describe("Wiki locale; defaults to the configured locale");
const selectorSchema = { releaseId, branch, pullRequest, commitSha, ref, locale };

/** Creates the release-explicit context-pack and grounded answer MCP surface. */
function createContextMcpServer(handlers: ContextMcpHandlers): McpServer {
  const server = new McpServer(
    { name: "jina-context", version: "2.0.0" },
    {
      instructions:
        "Use ask_context for a release-explicit citation-grounded answer, search_context to retrieve evidence, list_context to browse its tree, read_context for a complete document, and diff_context to compare immutable releases. Selectors are mutually exclusive and locale-isolated."
    }
  );

  server.registerTool(
    "search_context",
    {
      title: "Search context",
      description:
        "Deterministically select relevant PageIndex-tree nodes with lexical scoring and return document excerpts with immutable evidence citations. No model is called and no answer is generated.",
      inputSchema: {
        repository,
        query: z.string().trim().min(1).max(4_000),
        ...selectorSchema,
        limit: z.number().int().min(1).max(25).optional()
      },
      annotations: readOnlyAnnotations
    },
    async (input) =>
      result(
        await handlers.search({
          repository: input.repository,
          query: input.query,
          ...mcpSelection(input),
          ...(input.limit ? { limit: input.limit } : {})
        }),
        "context search"
      )
  );

  server.registerTool(
    "list_context",
    {
      title: "List context",
      description: "List derived context documents and their deterministic PageIndex-style hierarchy.",
      inputSchema: { repository, ...selectorSchema },
      annotations: readOnlyAnnotations
    },
    async (input) =>
      result(
        await handlers.list({
          repository: input.repository,
          ...mcpSelection(input)
        }),
        "context catalog"
      )
  );

  server.registerTool(
    "read_context",
    {
      title: "Read context",
      description: "Read one complete derived context document with its immutable source citations.",
      inputSchema: {
        repository,
        document: z.string().trim().min(1).max(1_000).describe("Document ID, logical ID, or revision ID"),
        ...selectorSchema
      },
      annotations: readOnlyAnnotations
    },
    async (input) =>
      result(
        await handlers.read({
          repository: input.repository,
          document: input.document,
          ...mcpSelection(input)
        }),
        "context document"
      )
  );

  server.registerTool(
    "diff_context",
    {
      title: "Diff context",
      description: "Compare two immutable context releases without using a model.",
      inputSchema: {
        repository,
        fromReleaseId: z.string().trim().min(1).max(300),
        toReleaseId: z.string().trim().min(1).max(300)
      },
      annotations: readOnlyAnnotations
    },
    async (input) => result(await handlers.diff(input), "context diff")
  );

  server.registerTool(
    "ask_context",
    {
      title: "Ask context",
      description:
        "Answer a question from one immutable wiki release and return its release identity, evidence citations, coverage, audit summary, and separately metered usage.",
      inputSchema: {
        repository,
        question: z.string().trim().min(1).max(4_000),
        ...selectorSchema,
        maxEvidenceItems: z.number().int().min(1).max(25).optional()
      },
      annotations: readOnlyAnnotations
    },
    async (input) =>
      result(
        await handlers.ask({
          repository: input.repository,
          question: input.question,
          ...mcpSelection(input),
          ...(input.maxEvidenceItems ? { maxEvidenceItems: input.maxEvidenceItems } : {})
        }),
        "context answer"
      )
  );

  return server;
}

function mcpSelection(input: {
  readonly releaseId?: string | undefined;
  readonly branch?: string | undefined;
  readonly pullRequest?: number | undefined;
  readonly commitSha?: string | undefined;
  readonly ref?: string | undefined;
  readonly locale?: string | undefined;
}): { readonly selector?: WikiSelector; readonly locale?: string } {
  const selector = parseWikiSelector(input, { allowOmitted: true });
  return {
    ...(selector ? { selector } : {}),
    ...(input.locale ? { locale: input.locale } : {})
  };
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

function result(value: unknown, label: string) {
  return {
    content: [{ type: "text" as const, text: `${label}:\n${JSON.stringify(value, null, 2)}` }],
    structuredContent: value as Record<string, unknown>
  };
}

/** Handles one stateless Streamable HTTP request. */
export async function handleContextMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handlers: ContextMcpHandlers,
  parsedBody?: unknown
): Promise<void> {
  if (request.method !== "POST") {
    response.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed" },
        id: null
      })
    );
    return;
  }

  const server = createContextMcpServer(handlers);
  const transportOptions = {
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  } as unknown as StreamableHTTPServerTransportOptions;
  const transport = new StreamableHTTPServerTransport(transportOptions);
  await server.connect(transport as unknown as Transport);
  response.once("close", () => {
    void transport.close();
    void server.close();
  });
  await transport.handleRequest(request, response, parsedBody);
}
