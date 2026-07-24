import { askGraph, getGraph, JinaApiError } from "../../../../../lib/jina-api";
import { parseGraphQuestion } from "../../../../../lib/graph-query";

export const dynamic = "force-dynamic";

const SAFE_TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> }
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  let question: string;
  try {
    question = parseGraphQuestion(
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { readonly question?: unknown }).question
        : undefined
    );
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "invalid question" }, { status: 400 });
  }

  const tenantId = new URL(request.url).searchParams.get("tenantId")?.trim();
  if (tenantId && !SAFE_TENANT_ID.test(tenantId)) {
    return Response.json({ error: "invalid tenant ID" }, { status: 400 });
  }

  const { id } = await params;
  try {
    const graph = await getGraph(decodeURIComponent(id), tenantId);
    if (!graph) return Response.json({ error: "graph not found" }, { status: 404 });
    return Response.json(await askGraph(graph, question, request.headers.get("x-jina-admin-actor-id") ?? undefined));
  } catch (error) {
    const status =
      error instanceof JinaApiError && error.status && error.status >= 400 && error.status < 600 ? error.status : 502;
    return Response.json({ error: error instanceof Error ? error.message : "graph query failed" }, { status });
  }
}
