# Jina

Jina is a tenant-scoped task board and repository context engine for software-work agents.
Signed GitHub events create durable board workflows. Cloud Run workers perform pull-request
review and build repository context at an exact commit. PostgreSQL stores board state,
canonical evidence, immutable knowledge-document revisions, disposable indexes, ACLs, and
query telemetry.

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
Opened PRs create review and publication tasks. Opened issues create manual triage tasks.
Signed branch pushes create a current-ref context build fenced by the event head SHA,
deduplicate unchanged heads, and supersede stale ref work. Ingestion fetches the
authoritative remote branch head and rejects the build if the ref has moved since the
event, rather than indexing a historical commit as current.

External review publication, automated fixes, repository dependency installation, and
repository test execution are not shipped.

## Repository context

The context engine's conceptual data flow is
`ingest-evidence` → required `derive-knowledge` → `index-context`. The coordinator also
publishes a raw-evidence `index-context` baseline before derivation, then an enriched
successor after derivation:

1. `ingest-evidence` fetches the authoritative remote branch head, verifies any
   event-supplied full SHA against it, checks it out detached, and stores immutable
   provider observations, an exact tree, content-addressed blobs, bounded commit/parent
   history, deterministic parser output, structural facts, and ACL observations. Git
   uses a full blob-filtered clone rather than a shallow clone. Every checkpoint is
   explicitly `complete` or `partial`; the observation frontier records Git/GitHub
   limits and omitted file bodies instead of overstating coverage.
2. `index-context` publishes the coherent raw-evidence baseline: indexable
   context documents, fragments, exact and lexical indexes, deterministic structure, and
   a deterministic long-document hierarchy. Projection consumers use independent leases
   and scoped acknowledgements; rebuild/drain work replays pending checkpoints without
   sharing a global processed bit.
3. Only after baseline publication, required `derive-knowledge` gives Codex a
   checkpoint-pinned, read-only repository plus separate immutable evidence, exact
   manifest, and prior-knowledge inputs. The agent explores the repository with read-only
   shell tools and organizes a complete subject-oriented catalog as
   `knowledge-documents-v4`: immutable, versioned documents rather than graph nodes.
   Commit evidence includes the checkpoint's changed paths, and bounded GitHub evidence
   includes PRs, issues, issue comments, PR review comments, and commit discussion
   comments. On an incremental build every prior logical document must be re-emitted
   with current citations or explicitly retired.
   Documents carry cited summaries, facts, answered questions, and diagnostic symptoms,
   likely causes, checks, and fixes. Host validation checks stable subject identity,
   resolves each exact line range or JSON pointer against original evidence, validates
   every body/structured citation ordinal, and requires the normalized citation claim to
   occur verbatim in that selected excerpt before persistence.
   Logical IDs are canonical lowercase; repository/commit portions come from the
   checkpoint and every model-controlled subject segment must be supported by resolved
   cited evidence. Identity and scope grounding sees only the exact selected
   line-range/JSON-pointer excerpt plus intrinsic cited-source identity; unrelated record
   text and a merely present manifest path do not count.
   The untrusted Codex run ignores user configuration and repository instructions. Its
   shell is read-only, has no inherited environment or login shell, and cannot use the
   network, web search, repository credentials, unified execution, multi-agent, apps,
   plugins, hooks, browser/computer/image tools, workspace dependencies, or skill MCP
   dependency installation. It can return only the requested schema-constrained JSON.
   Invalid output receives exactly one constrained repair. A successful commit publishes
   the required enriched successor generation; a second invalid result or executor
   failure fails the derivation stage and root build. Derived revisions are
   eligible only when every stored citation's source identity and `contentDigest` exists
   in that exact evidence checkpoint.

The baseline index does not depend on a model. Derived knowledge can enrich a later
generation. If derivation fails, the already-published baseline remains queryable for
diagnosis and retry, but the root build is failed rather than reported as degraded
success. The coordinator queues only ingestion, then only baseline indexing, then
required derivation/enriched publication. This prevents different context workers from
racing projection-input changes against the baseline build.
The generation's `derivedKnowledge` capability is computed only from logical IDs and
eligible revisions whose citations are present in that exact checkpoint; matching
repository/ref/commit history alone cannot make it report `available`. Unchanged cited
facts can be reused across equivalent same-commit checkpoints, while changed mutable
PR/issue evidence changes its identity or digest and excludes stale derived facts.
Successful derivation runs are cache-reused only for the same immutable focus/evidence
fingerprints, and index eligibility still rechecks every cached revision against the
target checkpoint.

Dense retrieval is implemented behind a port but disabled until an approved embedding
backend demonstrates an evaluation win. PageIndex is an optional hierarchy adapter; the
Jina-owned heading-tree fallback is active, and no PageIndex client is wired into the
deployed runtime. PageIndex stays off until it beats the fallback on long-document
quality, latency, cost, ACL, and citation gates.

`POST /context/query` routes requests across exact, structured, structural, lexical,
knowledge, temporal, hierarchy, and bounded long-context retrieval. Results identify the
selected ref, commit, and generation and return original-evidence citations, conflicts,
ambiguities, coverage, and a trace ID. Omitting `ref` selects `main`. Authorization and
its exact ACL-fingerprint set are rechecked after retrieval and synthesis, so a concurrent
revoke cannot release a response.
The `diagnose` task kind routes agent-derived symptoms, causes, checks, and fixes together
with structured issue/PR state and temporal change history.

Stateless Streamable HTTP MCP is served at `POST /mcp`. The `jina-context` server exposes
exactly one read-only tool, `query_context`, with the same storage-neutral query contract.
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

Public HTTP and MCP query request bodies are capped at 128 KiB. Each raw target category
accepts at most 100 entries; entries are trimmed, empty values are dropped, accepted
values are deduplicated, and each non-empty value is at most 1,000 characters. The
100-entry limit is checked before deduplication to prevent duplicate amplification.

API, context worker, task worker, dashboard, and admin are built from the same source
revision and deployed as one Cloud Run release. Database DDL and capability-role grants
run first under a separate migration login; the runtime login is `NOINHERIT` and every
context transaction explicitly activates its capability with `SET LOCAL ROLE`. Runtime
membership excludes the wildcard `jina_context_admin` role; tenant administration uses a
strictly RLS-scoped capability.
The deployed API uses 2 vCPU, 2 GiB memory, concurrency 4, and a 60-minute Cloud Run
request timeout. Context workers use a 62-minute operation timeout, a 10-minute terminal
completion timeout, and the 75-minute context lease described above. Production
acceptance exercises a real repository build, HTTP query, and MCP `query_context` call
before a release passes.

Webhook-triggered private-repository builds carry the GitHub installation ID and mint a
short-lived, installation-scoped token for ingestion. Manual builds may pass
`githubInstallationId`; builds without one can use `GITHUB_API_TOKEN` or
`GITHUB_CLONE_TOKEN` as a read-only fallback. Public repositories need no token.
Knowledge derivation requires `DAYTONA_API_KEY` and either `OPENAI_API_KEY` or
`OPENROUTER_API_KEY`.

## Repository layout

```text
apps/api/             webhooks, board API, context API, MCP, leases
apps/admin/           tenant-wide context health UI
apps/dashboard/       operator board and context workspace
apps/worker/          review and context-stage workers
apps/workflows/       local review CLI and deterministic simulation
packages/board/       generic tasks, dependencies, commands, reducer
packages/context-engine/ evidence, knowledge, indexes, routed retrieval
packages/db/          PostgreSQL stores, context adapters, migrations
packages/github/      webhook verification and parsing
packages/daytona/     isolated knowledge-document executor
packages/ai/          review harnesses and model clients
packages/observability/ structured logging, traces, live metrics
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Context engine decision](docs/CONTEXT_ENGINE_DECISION.md)
- [Context engine implementation record](docs/CONTEXT_ENGINE_IMPLEMENTATION_PLAN.md)
- [Agentic knowledge derivation](docs/AGENTIC_DERIVATION.md)
- [Context evaluation report and runbook](docs/CONTEXT_ENGINE_EVALUATION.md)
- [Data models](docs/DATA_MODELS.md)
- [Sequence diagrams](docs/SEQUENCE_DIAGRAM.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Shared original Jina database](docs/SHARED_TENANCY.md)
- [GitHub App setup](docs/GITHUB_APP.md)
- [Observability](docs/OBSERVABILITY.md)
- [Archived prior design](docs/CONTEXT_GRAPH.md)
