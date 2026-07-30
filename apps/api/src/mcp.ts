import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ContextCatalogService, ContextSearchResponse } from "@jina/context-engine";
import * as z from "zod/v4";

type CatalogList = Awaited<ReturnType<ContextCatalogService["listContext"]>>;
type CatalogRead = Awaited<ReturnType<ContextCatalogService["readContext"]>>;
type CatalogDiff = Awaited<ReturnType<ContextCatalogService["diffContext"]>>;

export interface ContextMcpHandlers {
  search(input: {
    repository: string;
    query: string;
    ref?: string;
    releaseId?: string;
    limit?: number;
  }): Promise<ContextSearchResponse>;
  list(input: { repository: string; ref?: string; releaseId?: string }): Promise<CatalogList>;
  read(input: { repository: string; document: string; ref?: string; releaseId?: string }): Promise<CatalogRead>;
  diff(input: { repository: string; fromReleaseId: string; toReleaseId: string }): Promise<CatalogDiff>;
}

const repository = z.string().trim().min(1).max(300).describe("Repository name, for example omlabs/jina");
const ref = z.string().trim().min(1).max(300).optional().describe("Branch or context preview ref");
const releaseId = z.string().trim().min(1).max(300).optional().describe("Immutable context release ID");

/** Creates the context-pack MCP surface. None of these tools synthesizes an answer. */
function createContextMcpServer(handlers: ContextMcpHandlers): McpServer {
  const server = new McpServer(
    { name: "jina-context", version: "2.0.0" },
    {
      instructions:
        "Use search_context to retrieve citation-grounded derived context, list_context to browse its tree, read_context for a complete document, and diff_context to compare immutable releases. These tools return context packs for the calling agent; they do not answer questions."
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
        ref,
        releaseId,
        limit: z.number().int().min(1).max(25).optional()
      },
      annotations: readOnlyAnnotations
    },
    async (input) =>
      result(
        await handlers.search({
          repository: input.repository,
          query: input.query,
          ...(input.ref ? { ref: input.ref } : {}),
          ...(input.releaseId ? { releaseId: input.releaseId } : {}),
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
      inputSchema: { repository, ref, releaseId },
      annotations: readOnlyAnnotations
    },
    async (input) =>
      result(
        await handlers.list({
          repository: input.repository,
          ...(input.ref ? { ref: input.ref } : {}),
          ...(input.releaseId ? { releaseId: input.releaseId } : {})
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
        ref,
        releaseId
      },
      annotations: readOnlyAnnotations
    },
    async (input) =>
      result(
        await handlers.read({
          repository: input.repository,
          document: input.document,
          ...(input.ref ? { ref: input.ref } : {}),
          ...(input.releaseId ? { releaseId: input.releaseId } : {})
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

  return server;
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
