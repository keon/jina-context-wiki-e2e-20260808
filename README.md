# Jina

Jina is a tenant-scoped task board for software-work agents, starting with GitHub pull request review and repository Ontology generation.

The current implementation receives signed GitHub webhooks, creates review tasks and dependencies, persists the board in PostgreSQL, and leases ready work to Cloud Run workers. The review worker reads a PR diff through the GitHub API and calls the OpenAI Responses API. The Ontology worker records immutable source observations, parses only previously unseen content-addressed blobs, records cited Codex output as provenance-bearing assertions, and projects the dashboard graph from canonical code and knowledge data. The current publish step records an idempotent internal publication; posting findings back to GitHub is not shipped yet.

## Core Shape

```text
GitHub event
  -> pipeline plans board tasks and dependencies
  -> readiness reducer queues ready tasks + durable outbox messages
  -> Cloud Run worker claims a five-minute renewable lease
  -> topic handler performs review, research, publication, cleanup, or Ontology work
  -> worker completes through the API; reducer advances dependents
```

The board is the source of truth and the orchestrator. PostgreSQL makes board state, delivery deduplication, leases, and Ontology graphs durable. Daytona is used only for Ontology repository inspection in the current runtime. Agents and humans act through the same validated commands.

Every board mutation loads and writes the JSON snapshot while holding one cross-instance PostgreSQL transaction lock. Multiple Cloud Run API instances therefore cannot derive and overwrite state from stale process-local snapshots.

Six concepts carry the whole design: **board**, **task**, **pipeline**, **run**, **gate**, **epoch**. Anything else is introduced only when a second concrete use exists.

## Quick Start

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test                # unit, API, worker-protocol, and optional Postgres tests
pnpm dev                 # api dev server :4000 + live board dashboard :3000

# Review a real GitHub PR through the pipeline (needs gh + OPENROUTER_API_KEY):
pnpm review:pr owner/repo 123 --dry-run              # real PR data, no model call
pnpm review:pr owner/repo 123                        # openrouter-chat harness (default)
pnpm review:pr owner/repo 123 --harness codex-cli    # Codex CLI harness
pnpm review:pr owner/repo 123 --model openai/gpt-5.5 # any OpenRouter catalog model
pnpm review:pr owner/repo 123 --post                 # also publish as a PR comment
```

The CLI review harness is a separate local evaluation path. Its trace and usage output are not the deployed Cloud Run worker's persistence model. See [docs/BILLING.md](docs/BILLING.md) for the target billing design and its implementation status.

`pnpm dev` uses memory stores, enables the unsigned demo endpoint, seeds a PR, and simulates non-Ontology task completion. Production disables demo endpoints and simulation and requires PostgreSQL, `INTERNAL_API_TOKEN`, and `JINA_TENANT_ID`.

## Ontology Worker

`ontology_build` is an aggregate with three worker-owned children: `ontology_ingest` stores each immutable commit's exact tree plus first-parent churn, parses only blob SHA/parser-version misses, and normalizes explicit work items, ownership, packages, named services, deployments, and incidents; `ontology_assert` runs Codex in Daytona against a bounded cross-commit focus list and records cited Feature, derived Issue, movement, impact, documentation, ownership, and causal proposals; `ontology_project` materializes the hot-ref manifest and builds disposable graph/search read models from the canonical stores. Parser-cache misses and semantic change scope are intentionally separate. Assertion generations are reused only on an exact code/source evidence fingerprint; a generator-contract or evidence change performs one bounded semantic scan and caches that generation. Every new semantic assertion carries checked evidence plus an immutable explanation of how that evidence supports the relationship, and reviewed facts retain their explanation, evidence, review, and provenance when reconfirmed. Generic causal traces root at Issue, Feature, Incident, or Service. Counterfactual questions synchronously remove PR, commit, package, deployment, or implementation paths from that same reviewed graph and report all known paths removed or remaining; they create no task, assertion, or cache row. Internal blob work remains batched and does not create per-file board tasks.

Local execution requires `DAYTONA_API_KEY`, `GITHUB_CLONE_TOKEN`, and either `OPENAI_API_KEY` (preferred) or `OPENROUTER_API_KEY`. Override provider and model with `ONTOLOGY_CODEX_PROVIDER` and `ONTOLOGY_CODEX_MODEL` when needed.

## GitHub App Intake

The API accepts signed GitHub App deliveries at `POST /webhooks/github`. A branch push creates the existing four-task Ontology workflow, skips a redelivery while that ref's latest known head is unchanged, and supersedes stale work when the ref moves—including a force-push back to an earlier SHA. A newly opened pull request creates the review task graph; a newly opened issue creates one manual triage card. See [GitHub App Setup](docs/GITHUB_APP.md).

Repository knowledge is available over stateless MCP at `POST /mcp`. Its complete public surface is one read-only tool, `query_graph`, which accepts a repository, a natural-language query, and an optional ref. Jina selects the graph traversal internally and returns a cited answer; callers do not choose storage, generation, or retrieval details. Production requests require the service credential plus a bound application principal, and repository ACLs are applied to every query.

For a credential-free local MCP smoke test, start `pnpm --filter @jina/api dev`. The development server seeds a small cited `omlabs/example` graph specifically for `query_graph`; it does not represent production data.

## Repo Layout

```text
apps/
  api/          GitHub webhooks, dashboard API, command application
  dashboard/    server-rendered operator UI and read-only API proxy
  worker/       durable polling worker for review and Ontology topics
  workflows/    local CLI harnesses and deterministic workflow simulations

packages/
  board/        tasks, dependencies, commands, reducer, gates
  review/       PR review pipeline, review profiles, findings, dedupe
  context/      context handoff, source policy, citations, extracted context
  publication/  publication planning, keys, publish results
  policy/       billing and budget policies
  db/           PostgreSQL state/graph stores and schema bootstrap
  github/       GitHub webhook signatures and payload parsing
  daytona/      Ontology sandbox executor
  ontology/     repository graph contract, task type, schema, and store port
  ai/           model clients and agent harnesses
  shared-kernel/ small shared primitives: ids, errors, time
```

`apps/*` own runtime wiring. Domain packages own their bounded rules and do not import HTTP, GitHub, Daytona, or model SDKs. `shared-kernel` stays small and contains no business workflows.

## Current PR Review Pipeline

```text
signed intake -> review pass -> internal publish record -> aggregate completion
```

The board primitives support context handoffs and the simulation package exercises them:

```text
review_pass R
  -> creates context task C
  -> R blocks on C
  -> researcher attaches cited context
  -> C completes
  -> R is requeued and resumes from board state
```

The production research handler currently records the requested sources; it does not fetch arbitrary external content. External GitHub publication, grounding, fixing, testing, release, and incident work remain unshipped.

## Active Docs

- [Architecture](docs/ARCHITECTURE.md) - deployed architecture followed by the larger target design.
- [Data Models](docs/DATA_MODELS.md) - target relational model and the currently shipped persistence subset.
- [Sequence Diagrams](docs/SEQUENCE_DIAGRAM.md) - current webhook, worker lease, Ontology, and dashboard flows.
- [Billing](docs/BILLING.md) - target OpenRouter/Autumn billing design; not yet a production subsystem.
- [GitHub App Setup](docs/GITHUB_APP.md) - signed webhook intake for new pull requests and issues.
- [Deployment](docs/DEPLOYMENT.md) - Cloud Run services, CI/CD, and keyless GitHub authentication.

## Documentation Contract

Runtime changes must update the README plus the affected architecture, sequence,
deployment, environment, and integration documents in the same pull request.
Target-design documents must keep an explicit implementation-status block so
planned capabilities cannot be mistaken for deployed controls.
