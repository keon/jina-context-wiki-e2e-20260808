# Jina

Jina is a tenant-scoped task board for software-work agents. The current runtime handles GitHub pull-request review and repository context graph generation.

Signed GitHub events create board tasks and dependencies. The API persists the board and leases ready work to Cloud Run workers. The review worker reads PR diffs and calls the OpenAI Responses API. The context graph worker incrementally records repository facts, runs cited semantic analysis in Daytona, and builds queryable graph projections. Publication is currently an internal idempotent record; Jina does not yet post findings to GitHub.

## Quick start

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm dev
```

`pnpm dev` starts the API on port 4000 and dashboard on port 3000. `pnpm --filter @jina/admin dev` starts the Next.js admin app on port 3100, which lists every generated context graph across all repositories (see `apps/admin/README.md`). It uses memory stores, enables the unsigned demo endpoint, seeds a PR and a small cited graph, and simulates non-context-graph task completion. Production requires PostgreSQL, `INTERNAL_API_TOKEN`, and `JINA_TENANT_ID`.

To exercise the separate local PR-review harness:

```sh
pnpm review:pr owner/repo 123 --dry-run
pnpm review:pr owner/repo 123
pnpm review:pr owner/repo 123 --harness codex-cli
pnpm review:pr owner/repo 123 --post
```

The harness needs `gh` and `OPENROUTER_API_KEY`. Its local trace and usage model are separate from the deployed worker.

## Runtime

```text
GitHub event
  -> API plans board tasks and dependencies
  -> reducer queues ready tasks and durable outbox messages
  -> worker claims and renews a five-minute lease
  -> worker completes through the API
  -> reducer advances dependents
```

The board is the orchestrator. PostgreSQL owns board state, delivery deduplication, leases, and context graph data. Every board mutation loads and writes the JSON snapshot while holding a cross-instance transaction lock, preventing horizontally scaled API instances from overwriting newer state.

Opened PRs create review and publication tasks. Opened issues create manual triage tasks. Signed branch pushes create the same four-task ContextGraph workflow as `POST /context-graph/build`; unchanged heads dedupe and moved refs supersede stale work.

The current review pipeline is:

```text
signed intake -> review pass -> internal publication -> aggregate completion
```

External publication, automated fixes, test execution, releases, and arbitrary external research are not shipped.

## Repository knowledge

The context graph workflow runs as three board-visible stages:

1. `context_graph_ingest` stores immutable source observations, exact commit trees, first-parent changes, and parsed content-addressed blobs.
2. `context_graph_assert` checks out the pinned commit in Daytona and records cited, explained, typed proposals.
3. `context_graph_project` consumes canonical events and rebuilds the current manifest, search documents, and immutable graph.

Reviewed assertions retain their evidence, explanation, review state, and provenance when later runs confirm them. Counterfactual queries remove selected paths from the reviewed graph in memory; they do not create facts or tasks.

Local context graph execution requires `DAYTONA_API_KEY`, `GITHUB_CLONE_TOKEN`, and `OPENAI_API_KEY` or `OPENROUTER_API_KEY`.

Repository knowledge is also exposed over stateless Streamable HTTP MCP at `POST /mcp`. Its single read-only tool, `query_graph`, accepts a repository, natural-language query, and optional ref. Production requires the internal service credential plus a bound application principal, and every request is repository-ACL scoped. The simulation integration uses a separate `GRAPH_API_TOKEN` for graph reads and exact ACL synchronization without granting board or worker access.

## Repository layout

```text
apps/api/          webhooks, board API, graph API, MCP, commands, leases
apps/admin/        tenant-wide context graph administration UI
apps/dashboard/    operator UI and authenticated read proxy
apps/worker/       review and context graph workers
apps/workflows/    local review CLI and deterministic simulation
packages/board/    tasks, dependencies, commands, reducer
packages/context-graph/ repository facts, assertions, retrieval, projections
packages/db/       PostgreSQL stores and migrations
packages/github/   webhook verification and parsing
packages/daytona/  context graph sandbox executor
packages/ai/       review harnesses and model clients
packages/observability/ structured logging, traces, and in-process metrics
```

Smaller packages contain review planning, context policy, publication, billing policy, and shared primitives.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [ContextGraph](docs/CONTEXT_GRAPH.md)
- [Data models](docs/DATA_MODELS.md)
- [Sequence diagrams](docs/SEQUENCE_DIAGRAM.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Shared original Jina database](docs/SHARED_TENANCY.md)
- [GitHub App setup](docs/GITHUB_APP.md)
- [Billing](docs/BILLING.md)
- [Observability](docs/OBSERVABILITY.md)
