# Jina

Jina is a tenant-scoped task board and repository context engine for software-work agents.
Signed GitHub events create durable board workflows. Cloud Run workers perform pull-request
review and build repository context at an exact commit. PostgreSQL stores board state,
canonical evidence, immutable derived-context revisions, disposable indexes, ACLs, and
retrieval telemetry.

## Quick start

```sh
pnpm install
pnpm check
pnpm evaluate:context
pnpm dev
```

`pnpm dev` starts the API on port 4000 and dashboard on port 3000.
`pnpm --filter @jina/admin dev` starts the tenant-wide administration app on port 3100.
Development uses in-memory stores unless PostgreSQL configuration is supplied. Production
requires PostgreSQL, `INTERNAL_API_TOKEN`, `CONTEXT_API_TOKEN`, and either fixed or
shared-database tenancy configuration.

To exercise the separate local PR-review harness:

```sh
pnpm review:pr owner/repo 123 --dry-run
pnpm review:pr owner/repo 123
pnpm review:pr owner/repo 123 --harness codex-cli
pnpm review:pr owner/repo 123 --post
```

The harness needs `gh` and `OPENROUTER_API_KEY`. Its local trace and usage model are
separate from the deployed worker.

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
Ordinary task leases are 30 minutes. Context stages use a 75-minute lease so one
60-minute Cloud Run request, the worker's 62-minute operation deadline, and a separate
10-minute terminal-completion deadline remain ordered safely.
Opened PRs create a review workflow and one executable review pass. Opened issues create
manual triage tasks.
Signed branch pushes create a current-ref context build fenced by the event head SHA,
deduplicate unchanged heads, and supersede stale ref work. Ingestion fetches the
authoritative remote branch head and rejects the build if the ref has moved since the
event, rather than indexing a historical commit as current.

External review publication, automated fixes, repository dependency installation, and
repository test execution are not shipped.

## Repository context

The context engine runs `ingest-evidence` → required `derive-knowledge` →
`index-context`:

1. Ingestion captures an immutable repository/GitHub snapshot, exact manifest, provider
   frontier, ACL state, and citation evidence. It no longer builds a parser graph or a
   raw-source search corpus.
2. Codex incrementally creates repository-specific Markdown context from the checkpoint
   and prior release. The lead agent discovers maintenance questions, chooses the
   document organization, delegates bounded research when useful, and runs a
   context-only critic before declaring those questions answerable. Every repository
   link and natural GitHub URL is resolved by the host to an immutable blob range or
   provider JSON pointer. A page with any invalid evidence link is withheld.
3. Each finished page is stored as a digest-addressed, validated checkpoint. Valid pages
   can publish a partial immutable release while the run continues, and a retry resumes
   from the last valid pages.
4. Only citation-valid derived context enters exact, lexical, and hierarchy projections.
   Raw source and provider observations remain evidence and can never be returned as
   context.
5. The hierarchy uses the self-hosted, pinned open-source PageIndex Markdown builder.
   Natural-language retrieval uses PageIndex-style model tree selection through the
   local Codex session, with deterministic derived-text fallback.

`POST /context/search` returns selected context excerpts and original-evidence citations;
it does not synthesize an answer. `GET /context/releases`, `/context/list`,
`/context/read`, and `/context/diff` browse immutable releases. Default-branch builds are
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
script. Context workers use a 62-minute operation timeout, a 10-minute terminal
completion timeout, and the 75-minute context lease described above. Production
acceptance exercises a real repository build, HTTP search, and all four MCP context tools
before a release passes.

Webhook-triggered private-repository builds carry the GitHub installation ID and mint a
short-lived, installation-scoped token for ingestion. Manual builds may pass
`githubInstallationId`; builds without one can use `GITHUB_API_TOKEN` or
`GITHUB_CLONE_TOKEN` as a read-only fallback. Public repositories need no token.
Local derivation uses the signed-in Codex session by default. The remote sandbox requires
`DAYTONA_API_KEY` plus an explicitly selected Codex session or API-key provider;
production uses the API-key path and never copies a developer session.

## Repository layout

```text
apps/api/             webhooks, board API, context API, MCP, leases
apps/admin/           tenant-wide context health UI
apps/dashboard/       operator board and context workspace
apps/worker/          review and context-stage workers
apps/workflows/       local review CLI and deterministic simulation
packages/board/       generic tasks, dependencies, commands, reducer
packages/context-engine/ evidence, derived context, releases, retrieval
packages/db/          PostgreSQL stores, context adapters, migrations
packages/github/      webhook verification and parsing
packages/daytona/     local and isolated context-document executors
packages/ai/          review harnesses and model clients
packages/observability/ structured logging, traces, live metrics
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Agentic context derivation](docs/AGENTIC_DERIVATION.md)
- [Context orchestration comparison](docs/CONTEXT_ORCHESTRATION_COMPARISON.md)
- [Context v2 implementation plan](docs/CONTEXT_V2_IMPLEMENTATION_PLAN.md)
- [Context v2 continuation runbook](docs/CONTEXT_V2_CONTINUATION_RUNBOOK.md)
- [Context quality benchmark](docs/CONTEXT_QUALITY_BENCHMARK.md)
- [Representative repository E2E](docs/REPRESENTATIVE_REPOSITORY_E2E.md)
- [Daytona Board-stage acceptance](docs/CONTEXT_DAYTONA_BOARD_STAGE_ACCEPTANCE.md)
- [Exhausted-page remediation](docs/CONTEXT_PAGE_REMEDIATION.md)
- [Context engine evaluation](docs/CONTEXT_ENGINE_EVALUATION.md)
- [Data models](docs/DATA_MODELS.md)
- [Sequence diagrams](docs/SEQUENCE_DIAGRAM.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Shared database tenancy](docs/SHARED_TENANCY.md)
- [GitHub App setup](docs/GITHUB_APP.md)
- [Observability](docs/OBSERVABILITY.md)
- [Billing policy helper](docs/BILLING.md)
