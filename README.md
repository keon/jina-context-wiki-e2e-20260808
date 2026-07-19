# Jina

Jina is a tenant-scoped task board for software-work agents, starting with GitHub pull request review and repository Ontology generation.

The current implementation receives signed GitHub webhooks, creates review tasks and dependencies, persists the board in PostgreSQL, and leases ready work to Cloud Run workers. The review worker reads a PR diff through the GitHub API and calls the OpenAI Responses API. The Ontology worker clones a requested repository into a Daytona sandbox, runs Codex, validates every citation against the checkout, and stores an immutable graph generation. The current publish step records an idempotent internal publication; posting findings back to GitHub is not shipped yet.

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

Six concepts carry the whole design: **board**, **task**, **pipeline**, **run**, **gate**, **epoch**. Anything else is introduced only when a second concrete use exists.

## Quick Start

```sh
pnpm install
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

`ontology_build` is a worker-owned task type registered with the generic board. The API durably leases `run-ontology` work to a separate worker; a Daytona sandbox clones the requested GitHub repository and runs Codex with a strict, cited graph schema. Citations are checked against that checkout before immutable graph generations are stored in PostgreSQL and rendered on the dashboard's `/ontology` page.

Local execution requires `DAYTONA_API_KEY`, `GITHUB_CLONE_TOKEN`, and either `OPENAI_API_KEY` (preferred) or `OPENROUTER_API_KEY`. Override provider and model with `ONTOLOGY_CODEX_PROVIDER` and `ONTOLOGY_CODEX_MODEL` when needed.

## GitHub App Intake

The API accepts signed GitHub App deliveries at `POST /webhooks/github`. A newly opened pull request creates the review task graph; a newly opened issue creates one manual triage card. Configure the App with read-only Pull requests and Issues permissions. See [GitHub App Setup](docs/GITHUB_APP.md).

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
  policy/       capabilities, budgets, review policy decisions
  db/           PostgreSQL state/graph stores and schema bootstrap
  github/       GitHub webhook signatures and payload parsing
  daytona/      Ontology sandbox executor
  ontology/     repository graph contract, task type, schema, and store port
  ai/           model clients and agent harnesses
  shared-kernel/ small shared primitives: ids, result, time, env, logging
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
