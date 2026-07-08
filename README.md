# Jina

Jina is a multi-tenant agentic software factory, starting with GitHub pull request review.

The MVP receives GitHub webhooks, creates review work on a Postgres-backed factory board, runs stateless agent tasks on Trigger.dev, clones PR repositories only inside Daytona sandboxes, and publishes advisory feedback back to GitHub. It does not execute untrusted PR code, install dependencies, create fixes, push commits, or open PRs.

## Core Shape

```text
GitHub event
  -> work_order
  -> assembly_line + factory_run
  -> board tasks and dependencies
  -> outbox relay
  -> Trigger.dev task run
  -> Daytona checkout when repository files are needed
  -> task events, artifacts, findings, gates, publications
```

The board is the source of truth and orchestrator. Trigger.dev schedules durable attempts. Daytona is the isolated repository workbench. Agents and humans act through the same validated verbs.

## Repo Layout

```text
apps/
  api/          GitHub webhooks, dashboard API, verb application
  dashboard/    Next.js operator UI
  workflows/    Trigger.dev tasks and outbox relay

packages/
  board/        tasks, dependencies, verbs, reducer, completion
  factory/      work orders, assembly lines, factory runs, stage runs, gates
  review/       PR review line, review profiles, findings, dedupe
  context/      context handoff, source policy, citations, extracted context
  publication/  publication planning, keys, publish results
  policy/       capabilities, budgets, review policy decisions
  db/           schema, migrations, repositories
  github/       GitHub App and publication adapter
  daytona/      checkout broker adapter
  ai/           model clients and agent harnesses
  shared-kernel/ small shared primitives: ids, result, time, env, logging
```

`apps/*` own runtime wiring. Domain packages own their bounded rules and should not import HTTP, Trigger.dev, GitHub, Daytona, or model SDKs. `shared-kernel` stays small and contains no business workflows.

## PR Review Line

```text
intake -> policy_snapshot -> checkout -> review_passes -> finding_grouping -> publish -> close
```

Context handoff is part of the review line:

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
