# Jina Architecture

## Purpose

Jina is a multi-tenant agent platform for software work, starting with GitHub pull request review. It receives GitHub events, represents work as tasks on a Postgres-backed **board**, schedules and executes specialized AI agents as **stateless durable runs on Trigger.dev**, publishes feedback or artifacts to developer systems, and stores durable state for a Next.js dashboard.

Specialized workers keep their domain state outside the generic board. See [ONTOLOGY.md](ONTOLOGY.md) for the complete Ontology worker architecture and implementation strategy.

The system is designed for agent collaboration without handing the whole job to one opaque autonomous agent. A PR review is the first pipeline: a root task plus stage tasks for checkout, review passes, context handoffs, publishing, and human decisions. New GitHub issues enter the board as manual triage cards; automated issue-triage, fix, test, documentation, release, and incident pipelines remain future capabilities.

## Vocabulary

Six concepts carry the whole design:

- **Board** — the Postgres tables (`tasks`, `task_dependencies`, `task_events`, `task_runs`, `outbox`) that are the source of truth *and* the orchestrator.
- **Task** — one unit of work; a board card. MVP types: `pr_review`, `review_pass`, `context`, `publish`, `issue_triage`, `human_decision`.
- **Pipeline** — a versioned template that says which tasks a trigger creates and how they depend on each other. The MVP has one, the PR review pipeline, defined in code (`packages/review`), not in a database table.
- **Run** — one stateless execution attempt of a task on Trigger.dev, recorded in `task_runs`.
- **Gate** — an explicit recorded pass/fail/waived result (`gate_results`) required for important transitions: budget, checkout readiness, publication, human approval.
- **Epoch** — a PR's head-SHA generation counter; the fencing unit for supersession.

Everything else is introduced only when a second concrete use exists. A normalized intake table (`work_orders`) remains deferred while GitHub PRs and issues can map directly to their subject rows/tasks; it becomes useful when another intake provider or configurable intake workflow ships. A configurable pipeline table is likewise deferred until tenants can configure pipelines.

## MVP Boundary

The MVP is the PR review pipeline, but review still requires a repository checkout. Review agents clone and inspect the repository inside short-lived Daytona sandboxes. GCP runtimes orchestrate the sandbox lifecycle and persist results; they do not host PR working trees on their own filesystem.

In scope:

- Signed GitHub App webhook ingestion for newly opened PRs and issues.
- Manual `issue_triage` cards for newly opened GitHub issues.
- PR comment and review-comment commands such as re-review, retry, dismiss, or explain.
- Root `pr_review` tasks for pull requests, one per active PR epoch.
- `review_pass` child tasks for specialized review agents.
- `context` child tasks for board-mediated handoff when a review pass needs dependency docs, external references, or other cited context.
- Gates for budget, checkout readiness, publication, and human decisions.
- Daytona sandbox creation for each review pass or review batch.
- Repository clone/checkout inside Daytona at the PR base and head SHAs.
- Structured findings with fingerprints and review-run provenance.
- GitHub review/check/summary publication.
- Dashboard views for PR review state, findings, review runs, publications, and task timelines.
- Retry, cancellation, and supersession when a PR updates.

Out of scope for MVP:

- Executing untrusted PR code; installing dependencies; running tests/reproduction.
- Grounding suspected findings; creating fix tasks; pushing commits; opening/updating PRs.
- Uncontrolled researcher egress. External context fetching requires source allowlists, retention policy, prompt-injection defenses, and explicit `can_fetch_external_docs`.

Grounding, fixing, testing, documentation, release, and incident-response remain future, capability-gated pipelines. Context research is non-mutating but still capability-gated; its commands exist as rejected/disabled operations until egress, source attribution, retention, gate, permission, and tenant-policy controls are implemented.

## Design Principles

1. **The board is the operational source of truth and the orchestrator.**
   The dashboard, agent handoffs, retry controls, readiness, completion, and audit trail are built around tasks, task dependencies, and task events. No long-lived coordinator workflow holds the graph; the board does. Execution status lives only on `tasks` — every other view of progress is derived.

2. **Pipelines are versioned code, not configuration.**
   Each pipeline is a planner function that maps a trigger to tasks, dependencies, required capabilities, gates, and a harness version, stamped with a version string. A pipeline becomes data only when tenants need to configure it.

3. **Gates beat model confidence.**
   Important transitions depend on explicit gate results: budget, checkout readiness, current-head checks, publication idempotency, tests, approvals, and future release checks. Vendor claims or benchmark scores are inputs to harness evolution, not runtime authority.

4. **Trigger.dev owns scheduling and durable execution.**
   Each ready task becomes a stateless, durable Trigger.dev run. Trigger.dev owns retries/backoff, delays, scheduled re-reviews, SLA timers, and per-tenant concurrency. Runs perform external side effects; the board decides what is ready to run next.

5. **Postgres owns durable state.**
   Task state, dependencies, events, review artifacts, findings, finding threads, publications, checkouts, tenant config, the transactional outbox, and dashboard read models live in Postgres.

6. **Agents and humans act through generic commands.**
   A small command set (`CreateTask`, `UpdateTask`, `TransitionTask`, `CommentTask`, `LinkTask`, `AssignTask`, `AttachArtifact`) replaces typed commands. The API validates every command against tenant policy, repository permissions, task state, capabilities, and budget.

7. **The readiness reducer + transactional outbox is the dispatch boundary.**
   A task becomes `queued` only when its required `depends_on` edges are satisfied. The transition and an outbox row are written in the same transaction. A relay drains the outbox and triggers the run. Runs and HTTP handlers never mark tasks complete out-of-band; they transition tasks, which re-runs the reducer.

8. **Stateless runs rehydrate from the board.**
   A run receives a `task_id`, loads its context from the task thread + linked tasks + PR/diff/policy, executes, writes results back as events/transitions, and may create child tasks. "Resume" is a fresh run reading the thread (restart-with-rehydration), not a held-open process.

   The default agent handoff is same-task resume: a run that needs more context creates a `context` task, links the current task as dependent on it, transitions itself to `blocked`, and exits. When the context task completes, the reducer requeues the original task and the next run rehydrates from the added context.

9. **Checkout credentials are brokered.**
   A checkout broker creates Daytona sandboxes, performs authenticated clone/fetch with scoped credentials, removes credentials from the sandbox, records the checkout lifecycle, and only then lets reviewer agents inspect the working tree.

10. **GitHub webhooks are thin and idempotent.**
   Webhook handlers verify signatures, dedupe deliveries, store the event, seed/advance the board, and write the outbox transactionally. Heavy review work and product-state transitions never run inline.

11. **Every external side effect is auditable.**
   GitHub writes, model calls, comments, checks, labels, and publications produce durable records. Future code execution and repository mutation must produce the same audit trail before being enabled.

12. **Untrusted code runs only in isolated sandboxes — distinct from Trigger.dev.**
    Trigger.dev durably runs trusted Jina code. The Daytona sandbox isolates adversarial PR code. The MVP does not execute PR code at all; future grounding/fix execution is sandboxed, egress-controlled, and policy-gated.

13. **Future powers are policy-gated.**
    Review-only is the default. Code execution, fixing, pushing, PR creation, and external research require explicit tenant policy, repository policy, and agent capability grants.

## Runtime Topology

```text
GitHub
  -> GitHub App Webhook
  -> API Server on GCP  (verify, dedupe, seed/advance board, write outbox in one tx)
  -> Postgres Board     (tasks, dependencies, events, runs, gates, outbox = source of truth)
  -> Outbox Relay       (drains outbox)
  -> Trigger.dev        (schedules + durably runs stateless per-task runs)
  -> Agent Runtimes     (run-review, run-publish, capability-gated run-research, future run-grounding/fix)
  -> Daytona Review Sandbox / GitHub API / AI Providers

Next.js Dashboard on Vercel
  -> API Server
  -> Postgres read models
```

The MVP runtime fleet runs the API server, the outbox relay, and the agent run code. Review work that needs repository files runs inside Daytona-backed sandboxes. Future grounding and fix runs reuse Daytona with additional, stricter permissions.

## Codebase Layout

Jina is split by runtime first, then by reusable domain packages.

```text
apps/
  api/
    src/server.ts
    src/routes/github-webhooks.ts
    src/routes/dashboard.ts
    src/routes/commands.ts
    src/auth/github-identity.ts

  dashboard/
    app/
    components/
    lib/api-client.ts

  workflows/
    src/relay/outbox-relay.ts
    src/tasks/run-review.ts
    src/tasks/run-research.ts
    src/tasks/run-publish.ts
    src/tasks/run-cleanup.ts

packages/
  board/
    src/commands.ts
    src/reducer.ts
    src/task-status.ts
    src/tasks.ts
    src/dependencies.ts
    src/gates.ts

  review/
    src/pr-review-pipeline.ts
    src/review-decision.ts
    src/review-profiles.ts
    src/findings.ts
    src/finding-dedupe.ts
    src/review-artifacts.ts

  context/
    src/context-handoff.ts
    src/context-items.ts
    src/source-policy.ts
    src/source-citations.ts

  publication/
    src/publication-plan.ts
    src/publication-keys.ts
    src/publication-results.ts

  policy/
    src/review-policy.ts
    src/capability-policy.ts
    src/budget-policy.ts

  db/
    src/schema/
    src/repositories/
    migrations/

  github/
    src/webhooks.ts
    src/publications.ts
    src/permissions.ts

  daytona/
    src/checkout-broker.ts
    src/credentials.ts

  ai/
    src/harnesses/
    src/models/
    src/tools/

  shared-kernel/
    src/ids.ts
    src/env.ts
    src/result.ts
    src/logger.ts
    src/time.ts
    src/errors.ts
```

Boundaries:

- `apps/api` owns HTTP, webhook verification, dashboard routes, identity resolution, and calling generic commands.
- `apps/dashboard` owns UI state and calls only API endpoints; it never imports database repositories.
- `apps/workflows` owns Trigger.dev task definitions and the outbox relay. It can call domain packages and adapters, but task implementations remain thin.
- Domain packages (`board`, `review`, `context`, `publication`, `policy`) are pure business logic. They do not import HTTP frameworks, Trigger.dev, GitHub, Daytona, model SDKs, or database clients.
- `packages/db` owns schema, migrations, repositories, and transactions.
- Adapter packages (`github`, `daytona`, `ai`) isolate provider SDKs and translate provider payloads into domain inputs/outputs.
- `packages/shared-kernel` is intentionally small: shared IDs, env parsing, result/error helpers, time helpers, and logging primitives. Domain behavior belongs in bounded domain packages, not in `shared-kernel`.

Import direction:

```text
apps/* -> packages/{board,review,context,publication,policy,db,github,daytona,ai}
packages/{github,daytona,ai,db} -> packages/shared-kernel
packages/{board,review,context,publication,policy} -> packages/shared-kernel
packages/shared-kernel -> no Jina package imports
```

Cross-domain calls should return intents rather than directly orchestrating other domains. For example, `review` can return `request_context`, and `apps/workflows` applies that through `board` commands.

Package rule:

- Start with the listed packages only; do not create a package just to hold a folder.
- Keep single-consumer code inside the owning app or domain package.
- Promote code into a package only when it has a stable public API, tests, and either multiple consumers or a boundary worth enforcing.
- Keep `policy` narrow: reusable capability, budget, and review-policy predicates. Domain-specific policy stays with its domain package.
- Keep `shared-kernel` smaller than every domain package. If a file needs domain nouns like task, review, finding, publication, or checkout, it does not belong in `shared-kernel`.

Workspace tooling:

- Use `pnpm` workspaces for `apps/*` and `packages/*`.
- Use Turborepo for cached `build`, `test`, `lint`, and `typecheck` pipelines.
- Use TypeScript project references for package-level type boundaries once the packages are real build units.
- Add boundary enforcement early, either with Nx's module-boundary ESLint rule or equivalent local ESLint restrictions. The important rule is that domain packages cannot import adapters, runtime apps, or database repositories.

### GCP Services

- **Cloud Run or GKE**: API server, outbox relay, and Trigger.dev run workers. Note: the relay and run workers should not scale to zero on the happy path (they must drain the outbox / hold Trigger.dev concurrency); use min-instances or `LISTEN/NOTIFY`-driven wake-ups.
- **Daytona**: Short-lived review sandboxes containing cloned repositories at PR base/head SHAs.
- **Cloud SQL Postgres**: Primary database and the board/outbox.
- **Secret Manager**: GitHub App private key, webhook secret, AI provider keys, Trigger.dev keys, database credentials, encryption keys.
- **Cloud Storage**: Large artifacts — diffs, context bundles, logs, reproduction artifacts, generated patches.
- **Cloud Logging / Error Reporting / Trace**: Structured operational telemetry.
- **Pub/Sub** (optional): webhook buffer, or the readiness-notify transport instead of `LISTEN/NOTIFY` if ingestion scales.

Trigger.dev may run on Trigger.dev Cloud or self-hosted infrastructure. Cloud is the preferred default unless there is a hard data-residency or operational requirement.

## Trigger Model

Jina is board-driven. A ready task is dispatched by the **transactional outbox + relay**, not by polling an execution-engine queue and not by agents polling the board on the happy path.

Dispatch shape:

```text
GitHub webhook or dashboard command
  -> API verifies identity/signature, stores the raw trigger idempotently
  -> API applies generic commands: upsert PR, plan pipeline tasks for the current epoch, append task_events
  -> readiness reducer flips newly-ready tasks to queued AND writes an outbox row (same tx)
  -> outbox relay triggers "run-<type>" on Trigger.dev (idempotencyKey = task_id:attempt)
  -> the stateless run executes, writes results back, transitions the task
  -> on terminal transition the reducer re-evaluates dependents + root completion
```

Supported MVP GitHub triggers:

```text
pull_request
issue_comment              # includes comments on PRs
pull_request_review
pull_request_review_comment
installation
installation_repositories
```

Future GitHub triggers: `issues`, `check_suite`, `check_run`, `push`, `workflow_run`.

The API routes events by GitHub subject onto board tasks:

```text
pull_request on PR #42             -> upsert PR, plan/advance pr_review tasks for current epoch
issue_comment on PR #42            -> parse comment command, create command/human_decision task or re-review pass
pull_request_review_comment        -> attach to finding thread / create review-comment task
installation event                 -> upsert installation, enable/suspend repositories
```

Comment-triggered commands are parsed conservatively and require tenant/repo policy:

```text
/jina review
/jina retry
/jina dismiss <finding-id>
/jina explain <finding-id>
```

The parser ignores Jina's own bot comments, resolves the GitHub actor to a durable identity, records a command invocation with the actor snapshot and authorization result, then applies board commands. It never mutates findings/tasks directly from the HTTP path.

## Core Domain Model

The full schema is in [DATA_MODELS.md](DATA_MODELS.md). The board-defining tables:

- **`tasks`** — the central work table (the board cards). Carries `type`, `status`, `root_task_id`/`parent_task_id`, `repo_id`, `github_pr_id`, `head_sha`, `epoch`, `pipeline_slug`/`pipeline_version` (on root tasks), `required_caps`, `dedupe_key`, `assigned_agent_id`, actor snapshot, `metadata`.
- **`task_dependencies`** — `depends_on` edges; the `required` flag drives readiness and completion.
- **`task_events`** — append-only timeline; powers audit and the dashboard, and carries agent-posted context (e.g. `context.collected`).
- **`task_runs`** — one row per Trigger.dev run attempt: `trigger_run_id`, `trigger_task_identifier`, `idempotency_key`, `attempt`, `head_sha`, `runtime_provider`, `runtime_instance_id`, `checkout_ref`, status, input/output, token/cost usage, error.
- **`outbox`** — transactional dispatch buffer drained by the relay.
- **`gate_results`** — explicit pass/fail/waived evidence attached to tasks: budget, policy, review, test, approval, publication.
- **`harness_versions`** — versioned prompts, tools, context rules, eval references, and model policies. Immutable per root task: a new prompt, tool config, model policy, or context rule creates a new row so outcomes can be compared over time.

Task types and kinds:

```text
MVP/core:         pr_review (aggregate), review_pass, context, publish (dispatchable), issue_triage (manual), human_decision (waitpoint)
Future/gated:     finding, grounding, fix, plan, build, test, docs, release, incident_triage
```

Every task type has a declared **kind** that fixes how the reducer treats it:

- **aggregate** — never executes; auto-completes when its required dependency edges are satisfied (`pr_review`).
- **dispatchable** — queued to Trigger.dev when ready; its dispatch topic is derived from its type.
- **manual** — remains in triage until a user acts; it has no outbox dispatch (`issue_triage`).
- **waitpoint** — the reducer may move it `triage -> blocked`, but only a user command completes it (`human_decision`).

`context` is a core handoff task type, but external fetching is enabled only when policy grants controlled egress. Findings are stored as `review_findings` + `finding_threads`. A `finding` task is created only when a finding needs independent workflow, approval, grounding, or fix work.

`dedupe_key` is unique per tenant + task type when present, and is **epoch-scoped**: one root `pr_review` per `(pr, epoch)`, one `review_pass` per `(pr, epoch, review_profile)`, one `publish` task per `(pr, epoch, publication_mode)`, one context task per `(target_task_id, normalized_source_set, question_hash)`. Head SHAs can recur across epochs (force-push away and back), so `head_sha` belongs in *publication* keys — where "never re-comment for the same SHA" is the desired semantics — not in task dedupe keys.

## Pipelines

A pipeline is a versioned planner: trigger in, tasks + dependencies + gates + harness version out.

```text
PR review (MVP)
  intake -> policy_snapshot -> checkout -> review_passes -> finding_grouping -> publish -> close
  optional loop: review_pass -> context -> same review_pass resumes

Context research (capability-gated)
  intake -> source_allowlist -> fetch -> extract -> cite -> attach_context -> close

Fix (future)
  intake -> plan -> branch_checkout -> edit -> test -> review_gate -> human_approval -> push_or_pr -> close

Release (future)
  intake -> changelog -> checks -> risk_summary -> approval -> release_artifacts -> close
```

Future pipelines are enabled only when their gates, permissions, sandboxing, and rollback story exist. Prefer small composable pipelines over one general-purpose autonomous agent.

## Execution Model

There is no coordinator/child workflow tree; there is a board, a reducer, an outbox, a relay, and stateless runs.

### Readiness reducer

Runs on every task transition, in the same transaction as the transition:

1. For the transitioning task, if it reached a terminal status, find dependents (`task_dependencies.depends_on_task_id = task.id`).
2. For each dependent whose required deps are all `done`: dispatchable tasks transition `triage|blocked -> queued` and insert an `outbox` row; aggregate tasks transition to `done`.
3. If a **required** dependency reached `failed` or `canceled`, the dependent transitions to `blocked` and a linked `human_decision` task is created — dependents never wait forever on a dead dependency.

The reducer is idempotent: a dependent already `queued`/terminal is skipped, and the outbox idempotency key prevents double-dispatch when two deps finish concurrently.

### Completion

Root completion is **purely edge-based**. The root `pr_review` task is an aggregate: it transitions to `done` when every required dependency edge pointing at it is satisfied. There is no descendant scan and no outbox-emptiness check.

The invariant that makes this safe: **every dynamically created child that must block completion gets an edge.** When `CreateTask` creates a child with `blocks_parent_completion = true`, the command layer materializes a required `root -> child` dependency edge in the same transaction. A context task, future finding task, or grounding task can therefore never be invisible to completion. Optional work is simply `required = false` on the edge and never blocks anything.

Epochs still guard currency: all tasks of a superseded epoch (including the root) transition to `superseded` together, so completion never mixes epochs.

### Transactional outbox + relay

```text
-- one transaction (command application or run completion):
UPDATE tasks SET status='queued' WHERE id=$1;
INSERT INTO outbox(task_id, attempt, trigger_task) VALUES ($1, $attempt, 'run-'||type);

-- relay loop (separate process, LISTEN/NOTIFY + slow safety poll):
for row in pending outbox:
  trigger(row.trigger_task, {taskId: row.task_id},
          { idempotencyKey: row.task_id||':'||row.attempt,
            concurrencyKey: tenant_id })
  mark row dispatched
```

Outbox rows are `pending | dispatched | dead_lettered`. The outbox makes "transition" and "trigger run" atomic. If the relay crashes after commit, the row is still there and is retried; the idempotency key makes the retry exactly-once. A trigger that keeps failing is dead-lettered for repair (see Failure Handling).

### Stateless per-task runs

One Trigger.dev task type per work type: `run-review` and `run-publish` first, capability-gated `run-research`, and future `run-grounding`, `run-fix`. Each run:

1. Loads the task and **validates currency**: the task is still `queued`/`in_progress`, and `task.epoch == pr.current_epoch`. If superseded, no-op exit.
2. Loads the pipeline stage definition, gates, and `harness_version`.
3. Transitions the task to `in_progress`, opens a `task_runs` row with the Trigger.dev run id.
4. Assembles a context bundle from the board (task thread, parent, linked tasks, PR metadata/diff, policy snapshot, prior findings). Large inputs are cached as Cloud Storage artifacts.
5. Executes agent logic (model + read-only tools; for review, via the Daytona checkout) under the run's token budget.
6. Writes results back via commands: `task_events`, findings, gate results, `AttachArtifact`, and child tasks (validated). If it needs more context, it can create a `context` task, link the current task as dependent on it, transition the current task to `blocked`, mark the current `task_run` as `deferred`, and exit.
7. For irreversible side effects (publish; future push/release), **re-checks currency** and uses an idempotency/publication key derived from `(task, head_sha)`.
8. Transitions the task to a terminal status or a waitpoint status such as `blocked`; the reducer re-evaluates dependents, gates, and root completion.
9. On failure: Trigger.dev retries per policy; on terminal failure, the run's failure hook marks the task `failed` and creates a linked `human_decision` task.

### Run responsibilities (review)

`run-review` runs one review profile against a PR SHA:

- Load tenant/repo policy; create a review policy snapshot.
- Ask the checkout broker for a short-lived Daytona sandbox with the PR base and head checked out (see Security Boundaries for the fetch mechanics).
- Fetch diff and nearby context from the checkout; run the review model and read-only tools.
- If required context is missing, create a `context` task, attach the requested sources/questions, link the current `review_pass` with `context_for`, and transition the review task to `blocked`.
- Create suspected findings; produce review artifacts and rejected-candidate findings.
- Store checkout lifecycle metadata; tear down the sandbox after artifacts persist (mark `leaked` + schedule cleanup if teardown fails).

Review sandboxes are read-only from Jina's perspective: no dependency installation, code execution, tests, pushes, or persisted credentials. Future `run-grounding`/`run-fix` reuse Daytona with stricter, separately-gated capabilities.

### Context handoff loop

Context handoff is a board-mediated waitpoint, not invisible agent-to-agent memory.

The same review task resumes by default. A follow-up review task is created only when work should branch, such as a separate review profile, a new scope, or a human-requested second opinion. The exact dependency row is defined in [DATA_MODELS.md](DATA_MODELS.md), and the runtime flow is shown in [SEQUENCE_DIAGRAM.md](SEQUENCE_DIAGRAM.md).

### Concurrency, fairness, and budget

- Per-tenant fairness/concurrency via Trigger.dev `concurrencyKey = tenant_id` and queue concurrency limits — no hand-rolled claim query.
- Budget is enforced at three points:
  - **Command time**: `CreateTask` is rejected when the budget is exhausted, bounding runaway spawn chains (e.g. context -> review -> context).
  - **Dispatch time**: the relay computes remaining budget before triggering a run and passes it in as a hard token cap, so a single runaway run is also bounded.
  - **Report time**: runs report token/cost into `task_runs`, which increments the PR's spend.
- Budget ceilings are layered: **per-epoch**, **per-PR cumulative** (never reset on epoch bump), and **per-repo per day**. The cumulative and per-repo ceilings are what bound a hostile or careless force-push loop; fork PRs get lower defaults.
- Review runs are rate-limited per PR: `synchronize` is debounced (new-epoch outbox rows get a short `next_attempt_at` delay, so another push supersedes them before they dispatch), and a hard cap of N review runs per PR per hour converts excess into a `human_decision`.

### Model gateway, harnesses, and billing

Full design in [BILLING.md](BILLING.md); the architectural commitments:

- **OpenRouter is the managed model gateway.** Managed runs call models through OpenRouter and persist the exact returned usage and cost per call (`model_usage` rows); billing derives from persisted cost, never catalog estimates. Tenants with their own connected key run own-harness: their AI cost bills to their provider, Jina charges infra credits only. Key resolution is fail-closed — a resolution error fails the attempt; it never falls back to the managed key.
- **Harnesses are pluggable.** A harness is the executable review strategy (model, prompts, orchestration). All harnesses return the same shape — summary, findings, ordered steps, usage records — so the board, billing, and observability are harness-agnostic. The registry lives in `packages/ai` (`openrouter-chat` and `codex-cli` first; multi-pass and other CLI-driven harnesses later). `harness_versions` records which harness type/version/model a run used so outcomes compare across harnesses.
- **Credits are the billing meter.** Autumn holds plans and the org-level credit balance; `tenant_billing_policy` holds the rate variables (subsidy, infra credits, overage rates) so per-tenant economics change without a deploy. The credit `check` runs as a command guard at dispatch (next to the budget guards), the rate mode is fixed at dispatch, and charging is outcome-gated on the root task's first `done` — failed and superseded epochs charge nothing and their usage rows are waived. The per-PR budget ceilings remain as a defense layer under the org-level meter.

### Scheduling and timers

All "ready later" needs map onto Trigger.dev primitives, not a Postgres `run_after` sweeper:

- retry/backoff -> Trigger.dev retry config
- recheck-in-N / scheduled re-review -> scheduled tasks / `wait.until`
- dead run recovery -> Trigger.dev run lifecycle (auto-retried)
- SLA on stuck tasks -> a scheduled sweep task scanning the board

### Supersession and fencing

On a `synchronize` (or new head SHA), `pull_requests.current_epoch` is incremented and `head_sha` updated. All non-terminal tasks of the prior epoch transition to `superseded`, and their active Trigger.dev runs are cancelled. Even if a cancel races, a run's **currency check** (step 1/7 above) makes it no-op before any side effect, and publication keys keyed on `(task, head_sha)` prevent stale comments. Fresh `review_pass` tasks are seeded for the new epoch.

## Generic Command Model

Agents and humans communicate intent through generic commands. Commands are validated and converted into board mutations and outbox rows.

```text
CreateTask        create a board card (type, parent, depends_on, required_caps)
UpdateTask        priority, assignee, metadata
TransitionTask    lifecycle move (validated by type, actor, capability, policy)
CommentTask       append a task_event (e.g. extracted context, finding notes)
LinkTask          depends_on | relates_to | context_for | verifies | fixes | publishes | supersedes
AssignTask        route to an agent type or a user
AttachArtifact    link a Cloud Storage artifact
```

Validation checks at command time:

- tenant scope and actor identity
- authorization result (membership / GitHub repo permission / policy)
- task status and transition legality (by task type)
- parent/child and dependency integrity
- agent capabilities (and feature-flag/policy for gated types)
- repository policy and GitHub installation permissions
- idempotency key
- budget ceilings

Command application is idempotent: the command is recorded before execution, repeated idempotency keys return the prior result, and each accepted/rejected command emits exactly one `task_event`. Commands for disabled capabilities (e.g. requesting grounding while it is off) are recorded as rejected with a policy error so the audit trail is complete. This prevents a reviewer from silently escalating into a fixer or publisher.

### Transition legality (MVP)

```text
pr_review (aggregate — never queues or executes):
  system/reducer: triage -> done | blocked
  system/github:  triage|blocked -> superseded
  user/system:    triage|blocked -> canceled

review_pass:
  reducer/run: queued -> in_progress -> done | blocked | failed
  reducer:     triage|blocked -> queued when context/human deps complete
  system:      queued|in_progress|blocked|failed -> superseded
  user/system: queued|in_progress|blocked|failed -> canceled

context:
  reducer:     triage|blocked -> queued when source policy/deps satisfied
  run-research: queued -> in_progress -> done | blocked | failed
  system:      queued|in_progress|blocked|failed -> superseded
  user/system: queued|in_progress|blocked|failed -> canceled

publish:
  reducer/run: queued -> in_progress -> done | failed
  user/system: queued|in_progress|failed -> canceled

issue_triage (manual — never queues automatically):
  user/system: triage -> in_progress | done | canceled
  user/system: in_progress -> done | canceled

human_decision (waitpoint — only a user completes it):
  system: triage -> blocked
  user:   blocked -> done | canceled
```

Future task types (`grounding`, `fix`, `finding`, and later build/test/docs/release tasks) need their own transition rules before their commands are enabled. All accepted transitions write one `task_events` row; invalid transitions return a conflict and write no partial state.

## Webhook Ingestion

Webhook handling steps:

1. Verify `X-Hub-Signature-256`.
2. Parse `X-GitHub-Event` and `X-GitHub-Delivery`.
3. Store the raw webhook event with a unique delivery ID.
4. Resolve tenant/installation/repository/subject; ignore Jina's own bot events.
5. Apply commands in one transaction: upsert the GitHub subject, create an issue triage card or plan/advance the PR pipeline tasks for the current epoch, append `task_events`, run the readiness reducer, and write any outbox rows.
6. Return quickly to GitHub.

Webhook processing must be idempotent; duplicate deliveries record only that they were seen. Downstream work uses delivery-aware idempotency keys, e.g. `github:{delivery_id}:upsert-pr`. Because the board mutation and the outbox row commit together, there is no separate "signal the engine" step that can be lost — the relay is the durable bridge. If the relay cannot reach Trigger.dev, the outbox row stays `pending` and is retried; persistent failures are dead-lettered (`outbox.status = dead_lettered`) for repair. The API returns a retryable 5xx only if it cannot durably store the webhook + board mutation.

## Dashboard Architecture

The Next.js dashboard is hosted on Vercel and talks only to the API server. It is the shared surface for agents and humans — humans act through the same commands.

Primary views:

- PR review board (task columns)
- task tree and dependency graph
- task detail timeline (`task_events`)
- gate results and waivers
- finding detail, evidence, and finding threads
- review run logs, artifacts, and context manifests
- checkout records and lifecycle
- repo configuration; tenant policy and GitHub installation status

The dashboard never queries Postgres directly; API responses are tenant-scoped and shaped for the UI (see read models in DATA_MODELS.md). Per-task timelines page by `(task_id, seq)`; the board-wide live feed pages by the global `task_events.id` cursor.

## Security Boundaries

- GitHub App installation tokens are generated just-in-time and not stored long term.
- Secrets live in GCP Secret Manager.
- Tenant data is scoped by `tenant_id`; RLS optional for defense in depth.
- Source-like artifacts are stored only when tenant policy allows; obey retention.
- The MVP clones PR code only inside Daytona review sandboxes, via a checkout broker with scoped installation tokens, credential purge before reviewer access, no default secret access, controlled egress, resource limits, ephemeral filesystems, artifact redaction, and reliable teardown.
- **Fork PRs are fetched as pull refs from the base repository** (`refs/pull/{n}/head`), which the installation token already covers — one credential path, no fork remote, no fork-token-scope question. `head_repo_*` fields are provenance only. For `merge_ref` checkout, GitHub computes mergeability asynchronously: check once with a short retry, fall back to `head_only`, and record the strategy actually used on the checkout row.
- The MVP does not execute PR code, install dependencies, or run tests.
- **Trigger.dev is not the sandbox.** Trigger.dev runs trusted Jina code; untrusted PR code runs only in Daytona. Future grounding/fix execution must run in isolated Daytona sandboxes with separate capabilities, per-run service accounts, immutable base images, controlled egress, and reliable teardown.
- **Researcher egress is an untrusted-input boundary, enforced three times.** The review agent reads untrusted PR content and then proposes context sources, so requested URLs are attacker-influenceable. (1) Command time, authoritative: `CreateTask(context)` normalizes each URL and matches it against the source allowlist from the **policy snapshot pinned on the review task** — not live policy, so a mid-flight policy edit cannot widen an in-progress review's scope. (2) Fetch time: `run-research` re-validates every URL against the same snapshot before fetching and re-checks the allowlist on every redirect hop. (3) Network layer: researcher egress goes through a proxy that only permits allowlisted hosts. Fetched docs are treated like PR content for prompt-injection defense, require source attribution, and are snapshotted only when policy allows.
- Irreversible side effects (publish; future push) re-check head-SHA currency and use idempotency/publication keys before acting.
- Commands are validated server-side before mutation; gated capabilities are disabled by default.

## Observability

**Every run must be reconstructible from the board.** A run's behavior — each model call, tool action, and decision — is appended to its task timeline as `run.step` events with ordinal and payload, and every model call has a `model_usage` row with exact tokens, cost, model, harness type, and key source. The dashboard's run view is these two sources joined: what the agent did, in order, and what each step cost. No agent behavior may exist only in provider-side logs.

Every log line should include relevant IDs:

```text
tenant_id, installation_id, repo_id, pr_id, epoch,
task_id, task_run_id, agent_id,
trigger_run_id, checkout_id, runtime_instance_id,
github_delivery_id, outbox_id
```

Metrics to track:

- webhook delivery latency; outbox dispatch latency; relay backlog depth
- Trigger.dev run queue latency and per-tenant concurrency saturation
- checkout create latency, clone failure rate, leak count
- pipeline duration by pipeline version and harness version
- gate pass/fail/waive rates
- harness version outcome deltas
- review run duration; findings per PR; findings published/dismissed per PR
- duplicate finding suppression; average inline comments per PR
- context handoff count, context task failure rate, source fetch failure rate
- publication failure rate; GitHub API rate usage
- AI token and cost usage; budget consumption and rejections per PR
- future: grounding success/refute rate, fix success rate

## Failure Handling

- Webhook duplicate: no-op by delivery ID.
- Board mutation committed but relay cannot reach Trigger.dev: the outbox row stays `pending` and retries; persistent failures move to `dead_lettered` and surface a repair task. Return 5xx only if the board mutation itself cannot be durably stored.
- Trigger.dev run failure: retried per policy; terminal failure marks the task `failed` and creates a linked `human_decision` task.
- Required dependency fails or is canceled: the reducer transitions dependents to `blocked` and creates a linked `human_decision` task.
- GitHub API failure inside a run: retry with backoff; surface a `task_event` if exhausted.
- Daytona sandbox create/clone failure: mark `review_checkouts` failed, mark the `review_pass` failed/blocked per retry policy, emit `review.checkout_failed`.
- Daytona teardown failure: mark `review_checkouts` leaked, emit metrics, schedule cleanup retry by `expires_at`.
- Model failure: retry by provider policy; fail the run if exhausted.
- Context source failure: keep the requesting review task `blocked` or fail the context task according to policy; surface source URLs, fetch errors, and retry controls on the task timeline.
- Publication failure: keep findings unpublished, expose retry (publication key makes retry a no-op/update).
- PR synchronized during review: bump epoch, supersede prior-epoch tasks, cancel their runs, seed fresh review passes; currency checks make any racing run a no-op.
- Budget exhausted: reject new `CreateTask` commands, emit a `task_event`, optionally create a `human_decision` task to raise the ceiling.

## Open Technical Decisions

- **Budget unit**: tokens, dollars, or task-count (or a combination) for the layered ceilings?
- **Readiness transport**: `LISTEN/NOTIFY` vs Pub/Sub for waking the relay; both need a slow safety poll for dead-letter recovery.
- **Context bundle size**: cap and caching strategy for stateless rehydration as a PR's task graph grows.
- **Pipeline versioning**: how much of a stage-graph change requires a new pipeline version versus a harness-only version bump?
- **Gate semantics**: which gates can be waived, who can waive them, and what audit evidence is required?

## Open Product Decisions

- Which publication mode is default: review comments, check runs, summary comments, or a combination?
- Should unverified findings be published as low-confidence advisory feedback?
- Should findings become visible child tasks in the MVP, or only when they require action?
- Which tenants can allow researcher agents to fetch external docs?
- Future: which tenants can allow grounding agents to execute code and fix agents to push commits?
- Future: which findings require grounding before publication?
- Future: should manual issue cards gain an automated triage pipeline, or should tests, fixes, release prep, or incident response come next?
