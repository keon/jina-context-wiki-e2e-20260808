import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { QueryContextResponse } from "@jina/context-engine";
import * as z from "zod/v4";

const taskKindSchema = z.enum(["lookup", "structure", "change", "intent", "overview", "status"]);

const citationSchema = z.object({
  id: z.string(),
  title: z.string(),
  excerpt: z.string(),
  anchors: z.array(
    z.object({
      tenantId: z.string(),
      repository: z.string(),
      sourceType: z.enum(["observation", "blob", "commit", "pull_request", "issue", "document"]),
      sourceId: z.string(),
      contentDigest: z.string(),
      commitSha: z.string().optional(),
      pathOrUrl: z.string().optional(),
      startLine: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional(),
      jsonPointer: z.string().optional(),
      observedAt: z.string().optional()
    })
  ),
  authorityClass: z.string(),
  sourceKind: z.enum(["code", "provider", "knowledge"]),
  sourceId: z.string(),
  sourceRevisionId: z.string().optional()
});

const queryContextResultSchema = {
  answer: z.string(),
  generation: z.object({
    id: z.string(),
    ref: z.string(),
    commitSha: z.string(),
    derivedKnowledge: z.enum(["available", "partial", "unavailable"])
  }),
  citations: z.array(citationSchema),
  conflicts: z.array(
    z.object({
      subject: z.string(),
      description: z.string(),
      citationIds: z.array(z.string())
    })
  ),
  ambiguities: z.array(z.string()),
  coverage: z.object({
    status: z.enum(["complete", "partial", "insufficient"]),
    missing: z.array(z.string()),
    retrieversUsed: z.array(z.string())
  }),
  traceId: z.string()
};

interface ContextMcpQuery {
  readonly repository: string;
  readonly question: string;
  readonly ref?: string;
  readonly taskKind?: "lookup" | "structure" | "change" | "intent" | "overview" | "status";
  readonly targets?: {
    readonly paths?: readonly string[];
    readonly symbols?: readonly string[];
    readonly pullRequests?: readonly string[];
    readonly issues?: readonly string[];
  };
  readonly timeWindow?: { readonly from?: string; readonly to?: string };
}

export type ContextQueryExecutor = (query: ContextMcpQuery) => Promise<QueryContextResponse>;

/** Creates Jina's storage-neutral, read-only repository-context MCP surface. */
function createContextMcpServer(execute: ContextQueryExecutor): McpServer {
  const server = new McpServer(
    { name: "jina-context", version: "1.0.0" },
    {
      instructions:
        "Use query_context for repository questions. Answers include the selected ref, index generation, original evidence citations, material conflicts, and coverage gaps."
    }
  );
  server.registerTool(
    "query_context",
    {
      title: "Query repository context",
      description:
        "Answer a repository question using routed exact, lexical, structural, knowledge-document, and hierarchy retrieval with verified original-evidence citations.",
      inputSchema: {
        repository: z.string().trim().min(1).max(300).describe("Repository name, for example omlabs/jina"),
        question: z.string().trim().min(1).max(4_000).describe("Natural-language repository question"),
        ref: z.string().trim().min(1).max(300).optional().describe("Optional branch, tag, or ref"),
        taskKind: taskKindSchema.optional().describe("Optional retrieval intent hint"),
        targets: z
          .object({
            paths: z.array(z.string().trim().min(1).max(1_000)).max(100).optional(),
            symbols: z.array(z.string().trim().min(1).max(1_000)).max(100).optional(),
            pullRequests: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
            issues: z.array(z.string().trim().min(1).max(100)).max(100).optional()
          })
          .optional(),
        timeWindow: z
          .object({
            from: z.iso.datetime().optional(),
            to: z.iso.datetime().optional()
          })
          .optional()
      },
      outputSchema: queryContextResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input) => {
      const targets = input.targets
        ? {
            ...(input.targets.paths ? { paths: input.targets.paths } : {}),
            ...(input.targets.symbols ? { symbols: input.targets.symbols } : {}),
            ...(input.targets.pullRequests ? { pullRequests: input.targets.pullRequests } : {}),
            ...(input.targets.issues ? { issues: input.targets.issues } : {})
          }
        : undefined;
      const timeWindow = input.timeWindow
        ? {
            ...(input.timeWindow.from ? { from: input.timeWindow.from } : {}),
            ...(input.timeWindow.to ? { to: input.timeWindow.to } : {})
          }
        : undefined;
      const result = await execute({
        repository: input.repository,
        question: input.question,
        ...(input.ref ? { ref: input.ref } : {}),
        ...(input.taskKind ? { taskKind: input.taskKind } : {}),
        ...(targets ? { targets } : {}),
        ...(timeWindow ? { timeWindow } : {})
      });
      return {
        content: [{ type: "text", text: renderContextQueryResult(result) }],
        structuredContent: { ...result }
      };
    }
  );
  return server;
}

/** Handles one stateless Streamable HTTP request. */
export async function handleContextMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  execute: ContextQueryExecutor,
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

  const server = createContextMcpServer(execute);
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

function renderContextQueryResult(result: QueryContextResponse): string {
  const evidence = result.citations.map((citation) => `- ${formatCitation(citation)}`);
  const conflicts = result.conflicts.map((conflict) => `- ${conflict.subject}: ${conflict.description}`);
  const gaps = result.coverage.missing.map((gap) => `- ${gap}`);
  return [
    result.answer,
    "",
    `Generation: ${result.generation.id} (${result.generation.ref}@${result.generation.commitSha})`,
    ...(evidence.length ? ["", "Evidence:", ...evidence] : []),
    ...(conflicts.length ? ["", "Conflicts:", ...conflicts] : []),
    ...(gaps.length ? ["", "Coverage gaps:", ...gaps] : [])
  ].join("\n");
}

function formatCitation(citation: QueryContextResponse["citations"][number]): string {
  const anchor = citation.anchors[0];
  if (!anchor) return `${citation.sourceKind}:${citation.sourceId}`;
  const revision = anchor.commitSha ? `@${anchor.commitSha}` : "";
  const location = anchor.pathOrUrl
    ? ` ${anchor.pathOrUrl}${
        anchor.startLine
          ? `:${anchor.startLine}${anchor.endLine && anchor.endLine !== anchor.startLine ? `-${anchor.endLine}` : ""}`
          : ""
      }`
    : "";
  return `${anchor.repository}${revision}${location}; ${anchor.sourceType}:${anchor.sourceId}`;
}
