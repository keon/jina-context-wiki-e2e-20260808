import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OrchestratedContext, RetrievalCitation } from "@jina/context-graph";
import * as z from "zod/v4";

const citationSchema = z.object({
  kind: z.enum(["code", "commit_change", "assertion", "observation", "entity"]),
  id: z.string(),
  repository: z.string(),
  commitSha: z.string().optional(),
  path: z.string().optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional()
});

const graphQueryResultSchema = {
  answer: z.string(),
  claims: z.array(
    z.object({
      text: z.string(),
      citations: z.array(citationSchema)
    })
  ),
  incomplete: z.boolean(),
  notes: z.array(z.string())
};

interface GraphQuery {
  readonly repository: string;
  readonly query: string;
  readonly ref?: string;
}

export interface GraphQueryResult {
  readonly answer: string;
  readonly claims: readonly {
    readonly text: string;
    readonly citations: readonly RetrievalCitation[];
  }[];
  readonly incomplete: boolean;
  readonly notes: readonly string[];
}

export type GraphQueryExecutor = (query: GraphQuery) => Promise<GraphQueryResult>;

/** Creates the complete public MCP surface. Deliberately exposes one read-only graph query. */
function createGraphMcpServer(execute: GraphQueryExecutor): McpServer {
  const server = new McpServer(
    { name: "jina-graph", version: "1.0.0" },
    {
      instructions: "Use query_graph for questions about a repository. Answers are bounded to cited graph evidence."
    }
  );
  server.registerTool(
    "query_graph",
    {
      title: "Query Jina graph",
      description:
        "Answer a question about repository code, history, ownership, issues, pull requests, commits, features, and relationships using cited graph evidence.",
      inputSchema: {
        repository: z.string().trim().min(1).max(300).describe("Repository name, for example omlabs/jina"),
        query: z.string().trim().min(1).max(4_000).describe("Natural-language question about the repository"),
        ref: z
          .string()
          .trim()
          .min(1)
          .max(300)
          .optional()
          .describe("Optional branch, tag, or ref; the default ref is used when omitted")
      },
      outputSchema: graphQueryResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input) => {
      const result = await execute({
        repository: input.repository,
        query: input.query,
        ...(input.ref ? { ref: input.ref } : {})
      });
      return {
        content: [{ type: "text", text: renderGraphQueryResult(result) }],
        structuredContent: { ...result }
      };
    }
  );
  return server;
}

/** Handles one stateless Streamable HTTP request. No sessions or server notifications are retained. */
export async function handleGraphMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  execute: GraphQueryExecutor,
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

  const server = createGraphMcpServer(execute);
  // The SDK models stateless mode as an explicit undefined, which needs a
  // boundary cast under this workspace's exactOptionalPropertyTypes setting.
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

export function publicGraphQueryResult(context: OrchestratedContext): GraphQueryResult {
  const notes = [...context.unresolvedAmbiguities, ...context.coverageGaps.map((gap) => gap.message)];
  return {
    answer: context.answer,
    claims: context.citedClaims,
    incomplete: context.truncated || notes.length > 0,
    notes
  };
}

function renderGraphQueryResult(result: GraphQueryResult): string {
  const evidence = result.claims.flatMap((claim) =>
    claim.citations.map((citation) => `- ${claim.text} (${formatCitation(citation)})`)
  );
  const notes = result.notes.map((note) => `- ${note}`);
  return [
    result.answer,
    ...(evidence.length ? ["", "Evidence:", ...evidence] : []),
    ...(notes.length ? ["", "Limitations:", ...notes] : [])
  ].join("\n");
}

function formatCitation(citation: RetrievalCitation): string {
  const revision = citation.commitSha ? `@${citation.commitSha}` : "";
  const location = citation.path
    ? ` ${citation.path}${citation.startLine ? `:${citation.startLine}${citation.endLine && citation.endLine !== citation.startLine ? `-${citation.endLine}` : ""}` : ""}`
    : "";
  return `${citation.repository}${revision}${location}; ${citation.kind}:${citation.id}`;
}
