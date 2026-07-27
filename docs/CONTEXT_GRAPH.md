# Archived: graph-first repository context design

> **Historical document.** This design was removed in the 2026-07-26 clean context-engine
> cutover. It is not an API, migration guide, deployment option, or supported data model.

The former runtime centered general repository knowledge on model-generated semantic
nodes, edges, assertions, and immutable graph generations. It exposed `/context-graph/*`,
the MCP tool `query_graph`, graph-specific worker topics and environment variables, the
`@jina/context-graph` package, and the PostgreSQL schema `jina_context_graph`.

None of those surfaces remain. There is intentionally no compatibility router, dual
write, queue translation, package alias, schema view, or old-data migration.

The separate legacy code-review application must leave `JINA_GRAPH_API_URL` and
`JINA_GRAPH_API_TOKEN` unset. Its `/internal/graph/mcp-access` bridge is retired rather
than translated onto the new model. Callers that need repository context must integrate
with the current `/mcp` endpoint and its sole `query_context` tool using a bound tenant
and principal.

Use the current documentation instead:

- [Architecture](ARCHITECTURE.md)
- [Context engine decision and research synthesis](CONTEXT_ENGINE_DECISION.md)
- [Implementation record](CONTEXT_ENGINE_IMPLEMENTATION_PLAN.md)
- [Data models](DATA_MODELS.md)
- [Sequence diagrams](SEQUENCE_DIAGRAM.md)
- [Deployment and rollback](DEPLOYMENT.md)
- [Evaluation report and runbook](CONTEXT_ENGINE_EVALUATION.md)

The replacement keeps relational structure only where it is deterministic or explicitly
sourced. Canonical provider/Git evidence and immutable knowledge-document revisions feed
disposable, indexable context documents. Query-time routing chooses exact, lexical,
structured, structural, temporal, knowledge, hierarchy, and bounded long-context
retrieval. Answers expose original evidence citations, conflicts, coverage, ref, commit,
generation, and trace identity.

Historical operational procedures from the prior design must not be followed. Emergency
rollback requires the complete old release and its matching database backup; old code
must never be pointed at the new `jina_context` schema.
