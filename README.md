# Jina

Jina is a multi-tenant agent platform for software work, starting with GitHub pull request review.

The MVP receives GitHub webhooks, creates review tasks on a Postgres-backed board, runs stateless agent tasks on Trigger.dev, clones PR repositories only inside Daytona sandboxes, and publishes advisory feedback back to GitHub. It does not execute untrusted PR code, install dependencies, create fixes, push commits, or open PRs.

## Core Shape

```text
GitHub event
  -> pipeline plans board tasks and dependencies
  -> readiness reducer queues ready tasks + writes outbox rows (one tx)
  -> outbox relay triggers a Trigger.dev run per task
  -> Daytona checkout when repository files are needed
  -> task events, artifacts, findings, gates, publications
```

The board is the source of truth and the orchestrator. Trigger.dev schedules durable attempts. Daytona is the isolated repository workbench. Agents and humans act through the same validated commands.

Six concepts carry the whole design: **board**, **task**, **pipeline**, **run**, **gate**, **epoch**. Anything else is introduced only when a second concrete use exists.

## Quick Start

```sh
pnpm install
pnpm test                # build + run the board simulations
pnpm dev                 # api dev server :4000 + live board dashboard :3000

# Review a real GitHub PR through the pipeline (needs gh + OPENROUTER_API_KEY):
pnpm review:pr owner/repo 123 --dry-run              # real PR data, no model call
pnpm review:pr owner/repo 123                        # openrouter-chat harness (default)
pnpm review:pr owner/repo 123 --harness codex-cli    # Codex CLI harness
pnpm review:pr owner/repo 123 --model openai/gpt-5.5 # any OpenRouter catalog model
pnpm review:pr owner/repo 123 --post                 # also publish as a PR comment
```

Every run prints its trace (each step the harness took), exact model usage (tokens and cost from OpenRouter), and the credit math — the same data that lands on the board as `run.step` events and `model_usage` rows. See [docs/BILLING.md](docs/BILLING.md).

`pnpm dev` runs in-memory stand-ins for Postgres/Trigger.dev: the api seeds a PR, a relay tick completes one run per interval, and the dashboard shows cards moving across the board — including epoch supersession when you force-push from the toolbar.

## Ontology Worker

`ontology_build` is a worker-owned task type registered with the generic board. The API durably leases `run-ontology` work to a separate worker; a Daytona sandbox clones the requested GitHub repository and runs Codex with a strict, cited graph schema. Citations are checked against that checkout before immutable graph generations are stored in PostgreSQL and rendered on the dashboard's `/ontology` page.

Local execution requires `DAYTONA_API_KEY`, `GITHUB_CLONE_TOKEN`, and either `OPENAI_API_KEY` (preferred) or `OPENROUTER_API_KEY`. Override provider and model with `ONTOLOGY_CODEX_PROVIDER` and `ONTOLOGY_CODEX_MODEL` when needed.

## GitHub App Intake

The API accepts signed GitHub App deliveries at `POST /webhooks/github`. A newly opened pull request creates the review task graph; a newly opened issue creates one manual triage card. Configure the App with read-only Pull requests and Issues permissions. See [GitHub App Setup](docs/GITHUB_APP.md).

## Repo Layout

```text
apps/
  api/          GitHub webhooks, dashboard API, command application
  dashboard/    Next.js operator UI
  workflows/    Trigger.dev tasks and outbox relay

packages/
  board/        tasks, dependencies, commands, reducer, gates
  review/       PR review pipeline, review profiles, findings, dedupe
  context/      context handoff, source policy, citations, extracted context
  publication/  publication planning, keys, publish results
  policy/       capabilities, budgets, review policy decisions
  db/           schema, migrations, repositories
  github/       GitHub App and publication adapter
  daytona/      checkout broker adapter
  ontology/     repository graph contract, task type, schema, and store port
  ai/           model clients and agent harnesses
  shared-kernel/ small shared primitives: ids, result, time, env, logging
```

`apps/*` own runtime wiring. Domain packages own their bounded rules and should not import HTTP, Trigger.dev, GitHub, Daytona, or model SDKs. `shared-kernel` stays small and contains no business workflows.

## PR Review Pipeline

```text
intake -> policy_snapshot -> checkout -> review_passes -> finding_grouping -> publish -> close
```

Context handoff is part of the pipeline:

```text
review_pass R
  -> creates context task C
  -> R blocks on C
  -> researcher attaches cited context
  -> C completes
  -> R is requeued and resumes from board state
```

External context fetching is capability-gated and requires source policy, citation, retention, and prompt-injection controls. Future grounding, fixing, testing, release, and incident work remain disabled until their capabilities and gates exist.

## Active Docs

- [Architecture](docs/ARCHITECTURE.md) - system decisions, runtime model, security boundaries, and failure handling.
- [Data Models](docs/DATA_MODELS.md) - Postgres schema and constraints.
- [Sequence Diagrams](docs/SEQUENCE_DIAGRAM.md) - happy paths and edge-case flows.
- [Billing](docs/BILLING.md) - OpenRouter gateway, Autumn credits, usage capture, and run observability.
- [GitHub App Setup](docs/GITHUB_APP.md) - signed webhook intake for new pull requests and issues.
- [Deployment](docs/DEPLOYMENT.md) - Cloud Run services, CI/CD, and keyless GitHub authentication.
