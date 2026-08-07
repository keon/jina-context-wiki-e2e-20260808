# Jina

Jina is a multi-tenant code-review and repository-intelligence platform. GitHub App
intake, review orchestration, isolated Daytona execution, billing, model routing, the
task Board, Context, causal graphs, MCP, and the customer dashboard live in this
repository and share one tenant boundary.

## Quick start

```sh
pnpm install
pnpm check
pnpm dev
```

`pnpm dev` starts the API on port 4000 and dashboard on port 3000.
`pnpm --filter @jina/admin dev` starts the tenant-wide administration app on port 3100.
The same API process serves product/review routes, Context, causal graph, and MCP.
Set `JINA_PRODUCT_API_ENABLED=true` plus the product credentials to exercise the
review, integration, and billing routes locally. Apply their schema with
`pnpm --filter @jina/api build && pnpm --filter @jina/api migrate:product`.
Development uses in-memory stores unless PostgreSQL configuration is supplied. Production
requires PostgreSQL, `INTERNAL_API_TOKEN`, `CONTEXT_API_TOKEN`, and either fixed or
shared-database tenancy configuration.

Review quality experiments use the same `@jina/review-agent` runtime as deployed
workers; see [`evals/review/README.md`](evals/review/README.md).

## Runtime

```text
GitHub event
  -> API plans board tasks and dependencies
  -> reducer queues ready tasks and durable outbox messages
  -> worker claims and renews a fenced lease
  -> worker completes through the API
  -> reducer advances dependents
```

The board is the orchestrator. A cross-instance PostgreSQL transaction lock protects each
snapshot mutation, and lease/write fences prevent a stale worker from committing.
Context claims use a renewable lease (five minutes in the production deployment) and a
one-minute heartbeat. Long-running sandbox work retains authority by renewal; a dead
worker becomes reclaimable, and any late completion is rejected by its write fence.
Opened PRs create a review workflow and one executable review pass. Opened issues create
manual triage tasks.
Signed branch pushes create a current-ref context build fenced by the event head SHA,
deduplicate unchanged heads, and supersede stale ref work. Ingestion fetches the
authoritative remote branch head and rejects the build if the ref has moved since the
event, rather than indexing a historical commit as current.

The review runtime publishes validated GitHub feedback and runs execution-first
investigations in isolated Daytona sandboxes. The Board review task is a separate
operational workflow; automated fixes are not shipped.

## Repository context

The generic Board orchestrates the complete Context workflow:

1. Ingestion captures an immutable repository/GitHub snapshot, exact manifest, provider
   frontier, ACL state, and citation evidence. It no longer builds a parser graph or a
   raw-source search corpus.
2. Codex creates repository-specific Markdown context from the checkpoint and prior
   release. One durable planner task checkpoints research planning, bounded subject
   research, and publication planning; independent durable page tasks checkpoint writing,
   citation audit, and at most one repair/audit cycle.
3. Each page returns an explicit accepted, retained-prior, or omitted disposition. The
   publication task validates those dispositions, builds PageIndex, and atomically advances
   the release; retries reuse digest-addressed phase checkpoints.
4. Only citation-valid derived context enters exact, lexical, and hierarchy projections.
   Raw source and provider observations remain evidence and can never be returned as
   context.
5. The hierarchy uses the self-hosted, pinned open-source PageIndex Markdown builder.
   Querying uses bounded deterministic lexical scoring over that derived-context tree;
   it never invokes a model or generates an answer.

`POST /wiki/search` returns selected context excerpts and original-evidence citations;
it does not synthesize an answer. `GET /wiki/releases`, `/wiki/list`,
`/wiki/read`, and `/wiki/diff` browse immutable releases. Default-branch builds are
canonical, PR heads publish to `pull/<number>/head`, and newly opened issues build against
the default branch. Comments and edits do not schedule builds.

Stateless Streamable HTTP MCP is served at `POST /mcp`. The `jina-context` server exposes
exactly four read-only tools: `search_context`, `list_context`, `read_context`, and
`diff_context`.
Both HTTP and MCP retrieval enforce repository access before candidate generation and
require a bound principal. Principal access resolves to repository ACL fingerprints;
PostgreSQL filters documents, fragments, exact entries, hierarchy rows, manifest rows,
and current-knowledge rows before retrievers can create candidates. In production,
`CONTEXT_API_TOKEN` reaches these two query surfaces and the read-only context
projections, and is server-side bound by `JINA_CONTEXT_TENANT_ID` plus
`JINA_CONTEXT_PRINCIPAL_ID`; callers cannot use identity headers to change that binding.
Administrative routes require the internal credential. Per-principal tokens
(`jina_atk_…`) carry their own tenant, principal and scopes instead of being bound by
configuration; see `docs/API_TOKENS.md`.
Repository-access synchronization also requires that credential, but applies only to the
same server-bound tenant and principal; caller headers cannot select another identity.

Public HTTP and MCP search request bodies are capped at 128 KiB. Search queries are
bounded to 4,000 characters and 25 selected nodes.

API, context worker, task worker, dashboard, and admin are built from the same source
revision and deployed as one Cloud Run release. Database DDL and capability-role grants
run first under a separate migration login; the runtime login is `NOINHERIT` and every
context transaction explicitly activates its capability with `SET LOCAL ROLE`. Runtime
membership excludes the wildcard `jina_context_admin` role; tenant administration uses a
strictly RLS-scoped capability.
Cloud Run sizing is controlled by `cloudbuild.yaml` and validated by the deployment
script. Context worker stage budgets and terminal-completion deadlines are bounded
independently from the renewable Board lease. Production acceptance exercises a real
repository build, HTTP search, and all four MCP context tools before a release passes.

Webhook-triggered private-repository builds carry the GitHub installation ID and mint a
short-lived, installation-scoped token for ingestion. Manual builds may pass
`githubInstallationId`; builds without one can use `GITHUB_API_TOKEN` or
`GITHUB_CLONE_TOKEN` as a read-only fallback. Public repositories need no token.
Local derivation uses the signed-in Codex session by default. The remote sandbox requires
`DAYTONA_API_KEY` plus an explicitly selected Codex session or API-key provider;
production uses the API-key path and never copies a developer session.

## Repository layout

```text
apps/api/             product/review API, webhooks, billing, Board, Context, MCP
apps/api/product-migrations/ product and review schema
apps/admin/           tenant-wide context health UI
apps/dashboard/       single customer dashboard, operations, and Context workspace
apps/docs/            customer documentation application
apps/worker/          review, Context, control, and causal-graph workers
packages/review-agent/   portable Daytona review runtime used by Board workers
evals/review/         review evaluation datasets and tools
packages/board/       generic tasks, dependencies, commands, reducer
packages/context-engine/ evidence, derived context, releases, retrieval
packages/db/          PostgreSQL stores, context adapters, migrations
packages/github/      webhook verification and parsing
packages/daytona/     isolated Board-stage context workers
packages/observability/ structured logging, traces, live metrics
packages/shared-kernel/ shared IDs, timestamps, and queue-topic wire contracts
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Architecture simplification and cutover gates](docs/ARCHITECTURE_SIMPLIFICATION.md)
- [Agentic context derivation](docs/AGENTIC_DERIVATION.md)
- [Context quality benchmark](docs/CONTEXT_QUALITY_BENCHMARK.md)
- [Daytona Board-stage acceptance](docs/CONTEXT_DAYTONA_BOARD_STAGE_ACCEPTANCE.md)
- [Retired multi-topic Context remediation](docs/CONTEXT_PAGE_REMEDIATION.md)
- [Data models](docs/DATA_MODELS.md)
- [Sequence diagrams](docs/SEQUENCE_DIAGRAM.md)
- [Deployment](docs/DEPLOYMENT.md)
- [API tokens and authentication](docs/API_TOKENS.md)
- [GitHub App setup](docs/GITHUB_APP.md)
- [Observability](docs/OBSERVABILITY.md)
- [Billing and credits](docs/BILLING.md)
