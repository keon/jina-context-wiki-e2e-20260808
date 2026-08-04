# Review Board and Trigger.dev Removal Plan

Status: repository-audited implementation plan (2026-08-04)

Scope: relational Board persistence, pull-based review workflows, OpenTelemetry, staging migration, and complete Trigger.dev removal

Production constraint: no production mutation or cutover is authorized by this plan; implementation and acceptance happen in staging first

## Audit verdict

The architecture is viable on the current shared PostgreSQL/Cloud Run stack, but the first draft was not implementation-ready. The repository audit found eight prerequisites that must land before review traffic can safely move:

1. **Create one transaction boundary.** `apps/api/src/product/store.ts` opens its own product transactions through `apps/api/src/product/db.ts`, while the generic Board store owns a different pool. `createReviewRun()` cannot currently commit with a Board workflow. Product store methods must accept an injected `PoolClient`, and admission must run through one coordinator and one physical database connection.
2. **Make one route the review admission owner.** `/webhooks/github` currently owns product review admission and relays the same signed delivery to `/context/webhooks/github`, while `/dev/webhooks/github` and `apps/api/src/github-intake.ts` can create the older `pr_review`/`run-review` graph. The product webhook must remain the only review owner; the Context relay must remain Context-only; dev/manual harnesses must call the same admission service.
3. **Preserve the whole Board domain, not just review tasks.** `jina_runtime.api_state` contains the dynamic Board graph/events, tracked-PR state, and development delivery sequence. Adjacent `jina_runtime.github_deliveries` and release-control tables provide dedupe and deployment fencing. The relational adapter/importer must account for every snapshot field, preserve those adjacent authorities, and preserve reducer semantics before `api_state` can stop receiving writes.
4. **Port the real agent runtime into the worker image.** The existing `apps/worker/src/server.ts` `run-review` handler is a single PR-diff model call and is not review-agent parity. Trigger currently packages Daytona worker sources, `busboy`, GitHub App credentials, model routing, timeouts, checkpoints, progress publication, usage, and billing behavior. The Cloud Run worker image and service manifest need all of those capabilities.
5. **Change deployment machinery before adding an OTel sidecar.** `scripts/cloud-build-deploy.sh` explicitly rejects revisions with other than one container and deploys with `gcloud run deploy --image`. Sidecars require a multi-container service manifest plus updated candidate, drain, isolation, health, image-verification, and acceptance logic.
6. **Define scheduler authentication.** The API currently protects internal routes with bearer tokens. Cloud Scheduler cannot simply inherit that secret. Add Cloud Run OIDC verification and a scheduler service-account allowlist (or choose a Cloud Run Job); create the IAM/job configuration in the repository's shell-based deploy flow.
7. **Treat product tables as the billing/review authority.** `review_llm_usage`, `review_run_billing`, `review_findings`, and product events already contain idempotency and late-usage rules. Board effect receipts coordinate attempts; they must reference, not replace, those product/provider identities.
8. **Refactor Context's direct JSON bridges.** `packages/db/src/context/board-publication-repository.ts`, `board-pageindex-attachment-repository.ts`, and `issue-graph-repository.ts` lock and modify `api_state` directly while committing Context data. They must use client-aware relational Board mutations in the same transaction. The separate `jina_context.outbox` is a Context projection-delivery outbox and remains; it is not the generic Board queue being replaced.

These are phase-zero and phase-one exit requirements below. Skipping any one of them can produce an acknowledged review without a workflow, duplicate review admission, lost Context work, an unusable runtime worker, or a deployment that the existing release controller cannot verify.

## 1. Outcome

Jina will run reviews as durable, pull-based workflows in the existing v2 PostgreSQL database. The API admits work transactionally, `jina-task-worker` instances claim ready tasks, and PostgreSQL remains the scheduling authority. Trigger.dev will no longer dispatch reviews, run review stages, schedule scans, retry billing, or backfill GitHub installations.

The implementation must provide:

- no acknowledged webhook without a durable workflow;
- no duplicate workflow for the same idempotency key;
- no stale worker completion after lease loss, deployment, or PR supersession;
- no duplicate GitHub publication, usage record, or Autumn charge;
- bounded retries with durable backoff;
- resumable expensive review work;
- an append-only audit record of every workflow, task, attempt, transition, and external effect;
- an OpenTelemetry trace for every admitted workflow, correlated with structured logs and durable Board events;
- indexed current-state projections for the dashboard and operator tooling; and
- a reversible staged cutover that never lets Trigger.dev and the Board own side effects for the same review.

This is not a full event-sourcing system and does not add Kafka, Redis, or Pub/Sub. The MVP uses six relational tables, GCS for large immutable artifacts, and Cloud Scheduler only to admit scheduled workflows.

## 2. Current state and migration boundary

The current production review topology is split across the product API and `services/review-trigger`:

- GitHub and manual-review handlers call Trigger.dev through `apps/api/src/product/trigger.ts`.
- Trigger's parent `review` task prepares the authoritative `review_runs` row, creates progress output, performs supersession checks, fans out `review-summary` and `review-runtime`, aggregates results, publishes findings, records usage fallbacks, and completes the run.
- `review-summary` and `review-runtime` each have Trigger-managed retry and timeout policies.
- `scheduled-review-scan` runs every 30 minutes.
- `billing-retry` runs every 15 minutes.
- `github-installation-backfill` is a separately retried Trigger task.
- Trigger deploy configuration, acceptance scripts, environment variables, secrets, documentation, and a separate package lock remain in the repository.

The existing generic Board has useful domain behavior—dependencies, supersession, retries, leases, write fences, operator retry, release fencing, and durable events—but its PostgreSQL persistence is a single `jina_runtime.api_state` JSONB snapshot guarded by one global advisory lock. The current `run-review` worker is also only a single PR-diff model call. It is not equivalent to the Trigger review agent.

`apps/api/src/server.ts` defines that snapshot as exactly `ApiSnapshot { intakeState, devDeliverySequence }`; `intakeState` contains the Board state and tracked pull requests. Delivery dedupe and release control are already separate relational runtime tables. This is the authoritative importer inventory starting point, not a guess based on dashboard fields.

There are also two materially different GitHub intake paths today:

- `apps/api/src/product/app.ts` handles `/webhooks/github`, starts product reviews through Trigger, and relays the signed payload to `/context/webhooks/github` for Context-only admission; and
- `apps/api/src/server.ts` handles the older generic/dev intake through `acceptParsedWebhook()` and `apps/api/src/github-intake.ts`, which plans `run-review` work through `packages/review/src/pr-review-pipeline.ts`.

That split is intentional for Context relay safety but unsafe as a migration ambiguity. The target keeps the product webhook as the sole automatic review owner and routes every manual/dev admission through the same product admission service. `/context/webhooks/github` remains Context-only. The old basic `run-review` planner/handler is removed once its fixtures have been replaced; it must never run in parallel with the full review pipeline.

The database is physically shareable in the current `JINA_PRODUCT_DATABASE_MODE=shared` staging configuration, but product and Board code do not share transactions. The product store creates its own pool and `withTransaction()` boundary. Atomic admission therefore requires a deliberate refactor to client-aware product store methods and a shared transaction coordinator; being in the same Cloud SQL database is not sufficient.

Context already has a separate relational `jina_context.outbox` for projection/event delivery. It remains in scope as Context infrastructure, not as a seventh generic Board table. Several Context repositories currently modify that outbox/domain data and the JSON Board snapshot atomically. Their replacement must accept the same transaction client and mutate the relational Board task/attempt plus Context rows together; splitting those writes would acknowledge a Board completion without its Context publication.

The migration therefore has two distinct pieces:

1. replace whole-Board JSONB persistence with a relational Board repository while preserving existing Context and causal-graph worker HTTP contracts; and
2. port the complete Trigger review behavior into generic Board workflows and workers.

Existing product records remain authoritative:

- `review_runs` is the customer-facing review summary;
- `review_run_events` and `review_findings` retain review product history;
- `review_llm_usage` and `review_run_billing` retain usage and billing authority; and
- Board records describe orchestration and execution, not a second billing or review product model.

Historical Trigger reviews remain visible through those product tables. They do not need fabricated Board workflows. Every review admitted after Board cutover must have a `board_workflow_id`.

The runtime migration system and the product migration system are also separate. `packages/db/src/migrate.ts` installs `jina_runtime`/Context objects and runtime grants; `apps/api/src/product/migrate.ts` applies the ordered product SQL migrations; `apps/api/src/product/migrate-all.ts` runs runtime migrations first. Keep that ordering so the product migration may reference `jina_runtime.board_workflows`, and update `packages/db/src/context/runtime-role.ts` with exact Board table and sequence grants. Introduce a versioned `jina_runtime.schema_migrations` ledger before importer or destructive runtime migrations; the current idempotent schema constant is insufficient for audited data transforms.

## 3. Design principles

1. **PostgreSQL is authoritative.** A notification mechanism may be added later, but it may only wake workers. It never owns task state.
2. **Current state is mutable; history is append-only.** Workflows, tasks, and effect receipts are current projections. Attempts and events preserve every execution/transition; normal runtime code never rewrites or deletes that history.
3. **One transaction owns each transition.** State validation, state mutation, newly ready tasks, and the corresponding Board event commit together.
4. **No external call occurs inside a Board database transaction.** External effects use claim/perform/record semantics and provider idempotency where available.
5. **At-least-once execution is explicit.** Exactly-once external effects are approximated with durable effect receipts and reconciliation.
6. **Database time is authoritative.** Claims, expiry, backoff, and retention use `clock_timestamp()`/`now()` in PostgreSQL rather than worker clocks.
7. **Large content is not queue state.** Prompts, transcripts, repository snapshots, logs, runtime results, and debug bundles are immutable GCS artifacts referenced by digest.
8. **Trace telemetry is not the audit database.** OpenTelemetry is best-effort operational telemetry. Board events and product records remain durable even when an exporter is unavailable.
9. **No high-cardinality metrics.** Workflow, task, tenant, repository, PR, sandbox, and trace IDs belong on spans and logs, never metric labels.
10. **An orchestrator owns a review for life.** A review admitted to Trigger drains on Trigger. A review admitted to the Board drains on the Board. In-flight work is never transferred between engines.

## 4. Target architecture

```text
GitHub webhook / manual request / Cloud Scheduler
                         |
                         v
                    Jina API
                         |
       one shared PoolClient admission transaction
       +-----------------+------------------+
       |                                    |
       v                                    v
 product review state                relational Board
 review_runs                         workflows
 review_run_events                   tasks + dependencies
 review_findings                     attempts + events
 review_llm_usage                    effect receipts
 review_run_billing                         |
                                               pull/claim
                                                  v
                                           jina-task-worker
                                      +-----------+-----------+
                                      |           |           |
                                   OpenAI      Daytona      GitHub
                                      |           |           |
                                      +------ GCS artifacts ---+
                                                  |
                                  Autumn via product billing service

API + workers -> OTLP -> Google-built OTel Collector sidecar
                            |-> Cloud Trace
                            |-> Managed Service for Prometheus
Structured stdout logs ----------------------------> Cloud Logging
```

The dashboard runs on Vercel, not in the Cloud Run services shown above. Its server-side telemetry needs a Vercel-compatible exporter path and must not be coupled to a localhost sidecar. Workflow operational telemetry is emitted by the API and workers; dashboard request telemetry is a separate deployment concern.

The existing internal worker endpoints remain stable:

- `POST /internal/worker/claim`
- `POST /internal/worker/renew`
- `POST /internal/worker/release`
- `POST /internal/worker/complete`

Their implementation changes from whole-snapshot reduction to focused relational transactions. Preserving these contracts lets Context, causal-graph, and review workers migrate independently from the database implementation.

## 5. Relational Board MVP

Create the tables under `jina_runtime` through versioned runtime migrations. Preserve the existing Board's branded string task/outbox identities by using `text` workflow/task keys; new review workflows may use UUID-form strings without requiring a lossy remap of active Context IDs. Use application-generated UUIDs for attempt/lease identities, `text` task/workflow types, ordinary timestamp columns, and bounded JSONB only for versioned type-specific metadata. Generic Board `tenant_id` is `text`, matching the existing Context schema; a product tenant UUID is stored in canonical lowercase UUID text. Do not add a foreign key from generic `tenant_id` to `public.tenants`, because Context tenants are not all product tenant rows. The explicit `review_runs.board_workflow_id` binding plus the admission transaction is the product-review integrity boundary.

### 5.1 `board_workflows`

One row per review, Context build, causal-graph build, scheduled scan, billing reconciliation, or installation backfill.

Required columns:

```text
id                    text primary key
tenant_id             text
workflow_type         text
pipeline_version      text
subject_type          text
subject_id            text
dedupe_key            text
concurrency_key       text
status                text
epoch                 bigint
trigger_type          text
trace_id              char(32)
admission_traceparent text
created_at            timestamptz
started_at            timestamptz
completed_at          timestamptz
updated_at            timestamptz
metadata              jsonb default '{}'
```

Constraints and indexes:

- unique `(tenant_id, dedupe_key)`;
- index `(tenant_id, status, updated_at desc, id desc)` for the dashboard;
- index `(workflow_type, status, created_at)` for operations;
- index `(subject_type, subject_id, epoch desc)` for supersession; and
- a bounded `metadata` size enforced in the repository.

Add nullable `board_workflow_id` to `review_runs`, unique when present, referencing `jina_runtime.board_workflows(id)`. This product migration runs only after the runtime Board migration. Keep `trigger_run_id` for historical rows during the compatibility period, but stop writing it for Board-owned reviews. Add `orchestrator` with `trigger` or `board` so mixed historical data is unambiguous. Add a check that a Board-owned run has a Board workflow and a Trigger-owned run has its historical Trigger identity where applicable.

### 5.2 `board_tasks`

This table is both task state and the MVP pull queue. A separate outbox is intentionally deferred.

Required columns:

```text
id                    uuid primary key
tenant_id             text
workflow_id           text references board_workflows
parent_task_id        text nullable
task_type             text
topic                 text nullable
status                text
priority              integer
available_at          timestamptz nullable
attempt_count         integer
max_attempts          integer
current_attempt_id    uuid nullable
delivery_id           text nullable
delivery_idempotency_key text nullable
required              boolean
cleanup_task          boolean
pipeline_version      text
enqueue_traceparent   text nullable
completion_traceparent text nullable
created_at            timestamptz
started_at            timestamptz nullable
completed_at          timestamptz nullable
updated_at            timestamptz
result_artifact       jsonb nullable  -- typed immutable reference only
result_digest         char(64) nullable
usage_digest          char(64) nullable
metadata              jsonb default '{}'
```

Add database checks for legal status values, nonnegative attempts, `max_attempts > 0`, and the relationship between `status`, `current_attempt_id`, and terminal timestamps. Add the `current_attempt_id` foreign key only after `board_attempts` exists, as `DEFERRABLE` with `ON DELETE RESTRICT`, to avoid a circular table-creation dependency. Normal operation never deletes attempts.

Use a constrained text state machine rather than a PostgreSQL enum so new states do not require an enum migration. Initial states:

```text
blocked -> queued -> leased -> succeeded
                  |       |-> retry_wait -> queued
                  |       |-> failed
                  |       |-> canceled
                  |       |-> superseded
```

Indexes:

- partial ready-work index on `(topic, priority desc, available_at, created_at, id)` where `status in ('queued','retry_wait')`;
- `(workflow_id, created_at, id)`;
- `(tenant_id, status, updated_at)`; and
- `(parent_task_id)`.

During migration, the relational repository exposes the existing Board outbox contract as a compatibility projection over queued tasks and current attempts. A pending outbox message maps to a queued task; a leased message maps to its active attempt; dispatched/retry history maps to terminal attempts and Board events. Import every live JSON Board outbox message according to this mapping. Retire the reducer's stored `outbox` array only after Context/API contract tests pass against the projection. The independent `jina_context.outbox` is not part of this mapping.

### 5.3 `board_dependencies`

```text
task_id               text references board_tasks
workflow_id           text references board_workflows
depends_on_task_id    text references board_tasks
condition             text  -- success | terminal
required              boolean
relationship          text
created_at            timestamptz
primary key (task_id, depends_on_task_id)
```

Add unique `(workflow_id,id)` on tasks and composite foreign keys so the task, dependency, parent, attempt, event, and effect rows named by one workflow cannot point across workflow boundaries. Repository guards alone are insufficient for tenant/workflow isolation.

The completing transaction finds direct dependents and queues those whose dependency condition is now satisfied. Review graphs are small, so the MVP should use indexed `NOT EXISTS` checks rather than a denormalized dependency counter. A counter can be introduced later without changing the public task model.

### 5.4 `board_attempts`

One row per claim. It owns the lease and write fence.

```text
id                    uuid primary key
tenant_id             text
workflow_id           text
task_id               text references board_tasks
delivery_id           text
delivery_idempotency_key text
attempt_number        integer
claim_number          integer
worker_id             text
worker_service        text
worker_release        text
worker_revision       text
lease_id              uuid
fence_token_hash      bytea
lease_expires_at      timestamptz
status                text
trace_id              char(32)
span_id               char(16)
started_at            timestamptz
last_renewed_at       timestamptz
finished_at           timestamptz nullable
failure_category      text nullable
diagnostic            text nullable
usage                 jsonb nullable
unique (task_id, claim_number)
```

Initial attempt states are `leased`, `released`, `succeeded`, `failed`, `expired`, and `fenced`. Add a partial unique index on `task_id` where `status='leased'`, plus an expiry index on `(lease_expires_at, task_id)` for leased attempts. `board_tasks.current_attempt_id` is the fast current projection; the attempt rows retain every claim.

Store only a hash of the bearer write-fence token. Never log or expose the token. Renew, release, retry, and completion require task ID, attempt number, lease ID, unexpired lease, and matching fence hash.

### 5.5 `board_events`

Append-only workflow history:

```text
id                    bigint generated always as identity primary key
tenant_id             text
workflow_id           text
task_id               text nullable
attempt_id            uuid nullable
event_type            text
source_event_id       text nullable
source_event_seq      integer nullable
actor_type            text
actor_id               text
trace_id              char(32)
span_id               char(16) nullable
occurred_at            timestamptz
payload                jsonb default '{}'
```

Indexes:

- `(workflow_id, id)` for an exact timeline;
- `(task_id, id)`;
- `(tenant_id, occurred_at desc, id desc)`; and
- `(event_type, occurred_at)` for bounded operator queries.

Event payloads are schema-versioned, bounded, sanitized, and contain references/digests rather than source bodies or credentials. Normal runtime code has insert permission but no update/delete permission on this table.

### 5.6 `board_effect_receipts`

This table makes external effects replay-safe.

```text
idempotency_key       text primary key
tenant_id             text
workflow_id           text
task_id               text
attempt_id            uuid nullable
effect_type           text
effect_version        integer
provider              text
status                text
request_digest        text
provider_id           text nullable
authority_record_id   text nullable
result_digest         text nullable
started_at            timestamptz
completed_at          timestamptz nullable
updated_at            timestamptz
last_error_category   text nullable
last_error            text nullable
metadata              jsonb default '{}'
```

Initial effect keys:

```text
github-progress:<review-run-id>
github-review:<review-run-id>:<head-sha>
review-findings:<review-run-id>:<result-digest>
review-usage:<review-run-id>:<stage>:<usage-dedupe-key>
autumn-ai:<review-run-id>:<usage-row-id>
autumn-infra:<review-run-id>
review-terminal:<review-run-id>
installation-backfill:<delivery-id>
```

Effect receipts do not replace provider-supported idempotency keys. Use both.

For product effects, the receipt is an orchestration record that points to the authoritative product/provider identity. `review_llm_usage` remains authoritative for usage dedupe, `review_run_billing` remains authoritative for charge claim state, and GitHub provider IDs remain authoritative for publication reconciliation. A receipt in `started` is not proof the provider did nothing; retries must query the corresponding product/provider state before another mutation.

Normal runtime roles receive no `UPDATE` or `DELETE` on `board_events`. Grant `USAGE` on its identity sequence explicitly. Runtime users receive only the table/sequence operations required by repository methods; migration ownership remains separate. An archival role may copy old partitions later, but the MVP does not delete workflow history.

## 6. Board repository and transaction contracts

Add a relational repository in `packages/db` and expose domain-oriented operations rather than raw SQL throughout the API. The repository interface is the future-proofing boundary.

Do not replace `packages/board` with SQL-coded business rules in the first migration. Add a workflow-scoped adapter that:

1. locks one `board_workflows` row;
2. loads that workflow's tasks, dependencies, attempts, and required release-control inputs;
3. builds the existing reducer aggregate;
4. applies the existing Board command/reducer; and
5. persists only the resulting row changes and new events in the same transaction.

This preserves Context's dynamic reducer behavior, phase checkpoints, supersession, and release fencing while removing the global `api_state` lock. Different workflows can mutate concurrently; commands within one workflow remain serialized for a short transaction. The fixed lock order is workflow row, task row, attempt/effect rows. Claim may discover candidate IDs through the ready index without locking, but it then locks the candidate's workflow and task in that order and revalidates eligibility; a raced candidate causes a bounded retry. Never lock a task and then its workflow. Deadlock/serialization failures are classified as short transient retries.

Required methods:

```text
admitWorkflow
addTasksAndDependencies
claimTask
renewAttempt
releaseAttempt
completeAttempt
retryAttempt
failAttempt
supersedeWorkflow
cancelWorkflow
recordEffectStart
recordEffectCompletion
recordEffectFailure
retryFailedTask
listWorkflows
getWorkflowDetail
listEvents
queueHealth
```

### 6.1 Admission

First refactor `apps/api/src/product/store.ts` so `createReviewRun` and the associated tenant/install/repository/PR/event operations have `...WithClient(client, input)` forms. Public wrappers may continue to call `withTransaction()` for existing callers, but the Board admission coordinator must supply one shared `PoolClient`. Do not implement admission as an API call followed by a Board call or as two nested independent transactions.

One database transaction must:

1. validate the tenant, repository, installation, and review trigger policy;
2. insert or select the authoritative `review_runs` row by its existing idempotency key;
3. insert or select the Board workflow by `(tenant_id, dedupe_key)`;
4. bind `review_runs.board_workflow_id` and `review_runs.orchestrator='board'`;
5. insert the initial tasks and dependencies;
6. queue dependency-free tasks;
7. append `workflow.admitted`, `task.created`, `task.dependency_added`, and `task.queued` events;
8. store the workflow trace ID and task creation context; and
9. commit before returning `202`.

A replay returns the original workflow/review IDs and appends at most a bounded `workflow.admission_replayed` event. It never creates duplicate tasks.

The same review transaction records the product signed-delivery/event idempotency key. Product `/webhooks/github` is the only review admission owner. Its relay to `/context/webhooks/github` remains Context-only and cannot create review work; that endpoint continues to commit its own `jina_runtime.github_deliveries` ledger entry with Context admission. `acceptParsedWebhook()` and all dev/CLI/manual harnesses either delegate to the product review coordinator or are explicitly scoped to Context; no second planner may emit the old `run-review` task.

### 6.2 Claim

Use the partial ready index for candidate discovery, lock the workflow `FOR UPDATE`, then lock the task `FOR UPDATE SKIP LOCKED` in a second statement and revalidate policy, readiness, and release eligibility. The claim transaction:

1. selects one eligible queued task for the worker's allowed topics and tenant/repository constraints;
2. verifies release-control admission;
3. enforces tenant and workflow concurrency limits;
4. increments `attempt_count`;
5. inserts a leased attempt with a random lease and fence;
6. updates the task to `leased` and binds `current_attempt_id`;
7. appends `task.claimed` and `attempt.started`; and
8. returns the plaintext fence token once.

An empty poll is read-only and does not emit a span or event by default.

### 6.3 Renew

Renewal updates one attempt row and appends no event for every normal heartbeat. Emit a metric on every renewal outcome and append an event only for a material renewal anomaly or a coarsened checkpoint. This prevents event and WAL amplification while preserving lease history through attempt timestamps.

### 6.4 Completion

The completion transaction verifies the active fence and then:

1. records bounded result metadata and immutable artifact references;
2. marks the attempt and task terminal;
3. appends completion and usage events;
4. evaluates direct dependents and queues newly ready tasks;
5. reconciles workflow status when no required work remains; and
6. stores the completion span context for downstream span links.

Completion is replay-safe. A repeated completion from the same lease returns the original receipt if its result digest and usage digest match; a conflicting replay returns `409`.

Context can create additional tasks and dependencies from a task result. That dynamic expansion occurs inside this same completion transaction before dependent readiness and workflow terminality are evaluated. Contract tests must cover every existing Context reducer command against both JSON and relational adapters before the JSON adapter is retired.

### 6.5 Retry and backoff

Classify failures before retrying:

- transient: network failures, provider 408/425/429/5xx, rate limits, Daytona transport, API transport, and repairable model transport;
- deterministic: invalid credentials, insufficient credits, unknown/unavailable configured model, validation failure after bounded repair, authorization, supersession, and bad task input;
- ambiguous external effect: reconcile through an effect receipt/provider lookup before retrying.

Persist `available_at` with exponential backoff and full jitter. Match current behavior initially:

- summary/runtime: maximum 3 attempts;
- installation backfill: maximum 5 attempts;
- publication and settlement: separately bounded retries plus scheduled reconciliation;
- operator retry: separately bounded and audited.

Do not retry an entire expensive runtime stage merely because usage or completion reporting failed. Persist stage artifacts and usage fallback first, then retry only the failed reporting/effect task.

### 6.6 Lease expiry and worker loss

The next claim may reclaim an expired attempt transactionally. It must first mark the old attempt `expired`, append `attempt.lease_expired`, and create a new attempt. A delayed old worker then fails its fence check.

Graceful shutdown stops new claims, aborts active work, and releases the lease once. Deployment drain retains the existing release-control model: pause claims, wait, fence remaining attempts, deploy the accepted release, and resume.

### 6.7 Supersession

A new PR head allocates a higher subject epoch. In one transaction:

- mark older nonterminal workflows `superseding`;
- supersede ordinary queued/leased tasks and invalidate their fences;
- retain already completed artifacts and usage;
- queue required cleanup/settlement tasks; and
- eventually close the workflow as `superseded` after cleanup.

Manual review commands retain their comment-based idempotency and ordering semantics. A delayed redelivery of one comment cannot become a second review after a new head.

## 7. Review workflow topology

Use pipeline slug `pr_review` with an explicit version stored on the workflow and every task. The initial Board pipeline is:

```text
prepare-review
      +--------------------+
      |                    |
      v                    v
summary-review       runtime-review
      |                    |
      +---------+----------+
                v     (after both are terminal)
          finalize-review
                |
          publish-review
                |
           settle-review
                |
        workflow reconciliation
```

`apps/api/src/product/internal.ts` already implements prepare, events, completion, late/fallback usage, billing settlement, and installation backfill semantics. Extract those handlers into client-aware domain services first. Board task handlers call the services directly when co-located in the API transaction boundary, or call the compatibility internal endpoints only where process separation requires it. The HTTP handlers remain thin compatibility adapters until Trigger has drained. Do not reimplement product idempotency or billing state machines inside `apps/worker`.

Task responsibilities:

### `prepare-review`

- validate the current PR and expected head;
- mint the GitHub installation token through the existing GitHub package;
- run the authoritative billing prepare gate;
- resolve and pin tenant model settings and key-source policy;
- create/update the idempotent progress comment;
- record the prepared product event; and
- emit the immutable prepared-input artifact needed by both child stages.

A billing denial is a deterministic business terminal state, not a worker failure. It posts the visible progress result, cancels ordinary descendants, queues cleanup/settlement if required, and records `blocked_insufficient_credits`.

### `summary-review`

- port the existing Trigger summary stage without Trigger SDK imports;
- consume the prepared immutable input;
- emit a versioned summary artifact and exact model usage;
- avoid publishing to GitHub directly; and
- retain current retry/timeout behavior.

### `runtime-review`

- port the complete Daytona runtime agent and its current model routing;
- checkpoint expensive phases and usage incrementally;
- preserve sandbox identity and all current normalized output contracts;
- emit immutable result, findings, usage, and bounded diagnostic artifacts; and
- separate Jina execution success from GitHub publication status.

The stage must resume from valid checkpoints after lease or process loss. A completed model phase is never repeated solely because the worker failed to report completion.

Add a review-specific artifact port; the existing `GcsContextArtifactStore` enforces Context-only key scopes and cannot be reused by pretending review artifacts are Context artifacts. Implement `GcsReviewArtifactStore` with immutable, digest-verified objects under:

```text
review-v1/tenants/<tenant>/workflows/<workflow>/tasks/<task>/<input-digest>/<artifact-name>
```

Use a separate `JINA_REVIEW_GCS_BUCKET` in staging so review prompts, transcripts, and debug artifacts have review-specific IAM and lifecycle policy. Grant write/read only to the API/task-worker identities that need it. Board rows store the bucket, key, generation, digest, media type, and size reference, never large content. Lifecycle rules may tier objects later, but must not silently delete artifacts still referenced by retained workflow history.

### `finalize-review`

- run after summary and runtime are terminal, not only successful;
- normalize partial/failed stage results exactly as the current parent task does;
- persist findings through existing unique `(review_run_id, fingerprint)` protection;
- construct the final product result and dashboard projection;
- decide the terminal review outcome; and
- create publication and settlement inputs by digest.

### `publish-review`

- verify the PR is still current before mutation;
- create/update the progress comment;
- publish the GitHub review and inline/file comments;
- use `github-review:<run>:<head>` effect identity;
- record provider IDs/URLs before returning success; and
- reconcile an ambiguous response before issuing another mutation.

### `settle-review`

- persist any usage fallback not already present;
- reconcile the pinned billing key source;
- charge or waive AI/infra usage according to the terminal outcome;
- use existing Autumn event identities and claim states;
- record effect receipts; and
- complete even when publication failed or the review was superseded.

This is a cleanup task. Supersession/cancellation does not discard it when usage or billing reconciliation remains necessary.

## 8. Removing all other Trigger.dev responsibilities

Complete Trigger removal requires replacements beyond the review graph.

Create a dedicated staging Scheduler service account and grant only Cloud Run invocation for the staging API. The API validates the Google-signed OIDC token's issuer, audience, and allowed service-account subject before admitting a schedule tick. Keep existing bearer-token internal endpoints for compatibility, but do not place a long-lived internal token in a Scheduler job. Because deployment is currently shell/Cloud Build driven, add idempotent `gcloud scheduler jobs update http`/IAM reconciliation and readiness assertions to `scripts/deploy-staging.sh` and the production deploy only in its later authorized phase.

### Scheduled review scan

- Cloud Scheduler calls an authenticated `POST /internal/schedules/review-scan` every 30 minutes.
- The endpoint admits a deduplicated `scheduled_review_scan` workflow keyed by the scheduled UTC slot.
- A worker task invokes the existing scan domain service.
- Missed slots can be reconciled from the last completed slot without duplicating review admissions.

Use the scheduler-supplied UTC schedule time, normalized to the 30-minute slot, as part of the dedupe key; never use request receipt time.

### Billing retry

- Cloud Scheduler calls `POST /internal/schedules/billing-reconciliation` every 15 minutes.
- The endpoint admits a deduplicated `billing_reconciliation` workflow.
- Its task drains pending/stale usage and infra billing through the existing billing service.
- Failures use Board retry and the next schedule slot remains an independent reconciliation pass.

### GitHub installation backfill

- Installation webhooks admit a `github_installation_backfill` workflow in the same delivery transaction.
- Preserve the current concurrency limit, five-attempt retry envelope, repository add/remove behavior, and sender membership grant behavior.
- Use the delivery ID as dedupe/effect identity.

### Installation maintenance/backfill commands

Replace any direct call to Trigger's backfill task with a Board admission method and return the Board workflow ID. Keep authorization and current response behavior stable.

## 9. Worker implementation

### Code movement

Separate pure review logic from Trigger adapters before changing behavior:

- move reusable review workflow types and normalization into `packages/review`;
- move Trigger-independent summary/runtime/GitHub progress helpers out of `services/review-trigger`;
- keep Daytona runner code in a reusable package or `apps/worker/src/review` with injected logger, tracer, clock, API client, and credential resolver;
- implement one handler per Board topic in `apps/worker`;
- remove imports of `@trigger.dev/sdk` from all reusable code; and
- update eval names from Trigger-specific method names without changing golden-result meaning.

The audited Trigger dependency surface is broader than `src/trigger`: direct SDK/runtime coupling exists in `services/review-trigger/src/daytona/review-session.ts`, `review/progress-comment.ts`, `review/runtime-stage.ts`, `review/summary-stage.ts`, `review/workflow.ts`, `shared/api.ts`, every `src/trigger/*` task, and `trigger.config.ts`. `review/workflow.ts` uses Trigger run listing for newest-manual-command/supersession decisions; replace that lookup with an indexed Board/product query that preserves comment ordering and head semantics.

`services/review-trigger` is also an independent npm project with its own lockfile and TypeScript/dependency graph, not a root pnpm workspace package. Port code into root workspace packages, reconcile dependency versions, and make the root build/typecheck/test own it before deleting the independent package. Avoid temporarily compiling two divergent copies of review logic.

The Trigger extension bundles Daytona source files and `busboy` that the current `apps/worker/Dockerfile` does not include. Update the worker image and an image-level probe to prove it contains every source consumed by `DAYTONA_WORKER_SOURCE_FILES`, runtime GitHub helpers, required binaries, and runtime dependencies. The staging worker manifest must supply the full audited review environment: Daytona key/snapshot/image/resources/timeouts, GitHub App ID/private key, product internal identity, model provider keys/routes, CodeGraph/Codex settings, review/dashboard URL, artifact bucket, and billing integration. Grant the task-worker service account the exact Secret Manager, GCS, GitHub, and telemetry permissions; the present `run-review` service configuration is not sufficient.

The legacy `run-review` is excluded from `isBoardTopic()` retry/release behavior and from `MODEL_BOARD_TOPICS` exact-usage enforcement, and its claimed-work parser does not carry the full GitHub installation context needed by the real agent. Every new review topic must use the full Board lease/fence/retry path, pin the installation and expected head in prepared input, and require exact model usage where the provider returns it. Delete the special legacy branches after the new topic acceptance passes; do not extend them into a second orchestration model.

Initial review topics:

```text
prepare-review
summary-review
runtime-review
finalize-review
publish-review
settle-review
scheduled-review-scan
billing-reconciliation
github-installation-backfill
```

### Capacity

The MVP uses a fixed warm `jina-task-worker` pool because a PostgreSQL backlog cannot scale a Cloud Run service from zero. Configure at least enough instances that long runtime tasks cannot consume every slot needed for prepare/publication/settlement. Enforce per-tenant and global concurrency during claim.

Today staging deploys `jina-task-worker-staging` at one instance with `WORKER_TOPICS=run-review`; production defaults the task worker to one warm instance, up to five, at request concurrency one. A database queue does not generate Cloud Run request autoscaling signals. For staging parity, split long `runtime-review` capacity from short orchestration/effect topics into distinct worker services or reserve claim capacity by topic, and keep more than one warm claimant during the soak. Otherwise one Daytona task creates head-of-line blocking for preparation, publication, and billing.

Match today's Trigger envelopes before tuning: the parent review queue is globally serialized, summary/runtime allow three attempts with long task budgets, installation backfill allows five attempts at concurrency five, scheduled scan runs every 30 minutes, and billing retry runs every 15 minutes. Any deliberate concurrency increase needs provider/GitHub/Daytona/database load evidence and per-tenant fairness, not an accidental change caused by adding Cloud Run instances.

Measure queue depth and age before selecting the staging pool size. A later activator or Pub/Sub notification may change desired instance count, but it must not change claim authority.

### Timeouts and checkpoints

- Task time budgets live in task metadata/policy and are enforced by worker abort signals.
- Lease duration is shorter than the task budget and renewed periodically.
- Runtime review retains its current maximum duration envelope.
- Checkpoints are content-addressed and scoped to workflow, task, attempt-independent input digest, pipeline version, and phase.
- A retry may reuse only an artifact whose scope and digest validate exactly.

## 10. OpenTelemetry design

The current custom trace parsing and in-process metrics are not sufficient. Add a real OTel SDK pipeline while preserving structured Cloud Logging.

Official implementation references:

- <https://opentelemetry.io/docs/languages/js/>
- <https://opentelemetry.io/docs/languages/js/exporters/>
- <https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/>
- <https://docs.cloud.google.com/stackdriver/docs/instrumentation/opentelemetry-collector-cloud-run>

### 10.1 SDK bootstrap

Extend `packages/observability` with a Node SDK bootstrap loaded before application modules in API, worker, and Cloud Run admin processes. Add a separate Vercel-compatible server bootstrap for the dashboard only after its exporter/runtime behavior is verified; it does not use the Cloud Run localhost collector.

Use:

- `@opentelemetry/sdk-node`;
- OTLP trace and metric exporters;
- Node HTTP/fetch auto-instrumentation with request/response header capture disabled;
- manual Board repository spans initially, rather than PostgreSQL auto-instrumentation that may emit SQL statements or bound customer data;
- W3C Trace Context and Baggage propagation;
- a batch span processor;
- a periodic metric reader; and
- explicit shutdown/flush on `SIGTERM` within the Cloud Run termination budget.

Pin one compatible OTel release family in the workspace lockfile. Do not mix arbitrary API/SDK/instrumentation majors.

Required resource attributes:

```text
service.namespace=jina
service.name
service.version=<release id or image sha>
service.instance.id=<process-unique worker/api id>
deployment.environment.name=staging|production
cloud.provider=gcp
cloud.platform=gcp_cloud_run
cloud.account.id=<project id>
cloud.region
```

### 10.2 Collector and Google Cloud export

Run the pinned Google-built OpenTelemetry Collector as a Cloud Run sidecar for API and worker services:

- applications export OTLP to localhost;
- collector processors include memory limiting, batching, resource normalization, and sensitive-attribute deletion;
- traces export to the Google Telemetry API/Cloud Trace;
- metrics export to Managed Service for Prometheus;
- collector health participates in deployment acceptance but telemetry export failure never blocks review state transitions; and
- service accounts receive only trace/metric writer permissions required by the collector.

Keep logs as structured JSON on stdout initially. Include active OTel `trace_id`, `span_id`, and Google Cloud trace correlation fields in every log record. OTel JavaScript logs remain outside the MVP until their stability and Google Cloud path are acceptable.

This sidecar is a deployment project, not only an application dependency. Before enabling it, replace single-image deployment for the affected services with versioned multi-container Cloud Run service YAML and update all code that assumes `spec.containers[0]` or exactly one container, especially candidate discovery, release isolation, image verification, drain routing, health checks, preflight, and their tests in `scripts/cloud-build-deploy.sh`, `scripts/deploy-staging.sh`, and related acceptance scripts. Identify containers by name, verify both immutable image digests, and make only the application container serve ingress. Land and exercise this deployment change in staging before relying on collector acceptance.

The current observability package is a structured logger plus an in-process metrics registry, and worker stage logging creates fresh trace contexts. OTel bootstrap must replace that broken correlation path by propagating the admitted task context into the active attempt. Preserve the current logger interface as an adapter during migration so business code does not depend directly on SDK globals.

### 10.3 Durable asynchronous trace model

Do not hold one process-local span open for the lifetime of a workflow.

At admission:

1. extract the inbound HTTP/GitHub trace context;
2. start an always-recorded `jina.workflow.admit` root span linked to the inbound request span;
3. persist its trace ID and traceparent on the workflow;
4. create a producer span for each initially queued task; and
5. persist each task's creation traceparent.

At claim:

- create `board receive <topic>` only for a successful pull;
- create `board process <topic>` with `CONSUMER` kind for the task attempt;
- use/link the persisted creation context according to OTel messaging conventions;
- record the attempt span context in `board_attempts`; and
- make provider, Daytona, GitHub, GCS, and internal API spans children of the attempt span.

At fan-out, each queued child receives a producer context. At join, the finalizer span links to the completion contexts of summary and runtime. A retry links to the failed prior attempt and the original task creation context. A duplicate admission links the replaying request to the existing workflow rather than creating a second trace.

Every Board workflow is represented in OTel, but the durable event log remains complete even if an attempt process crashes before exporting its span.

### 10.4 Span names and attributes

Stable custom span names:

```text
jina.workflow.admit
jina.workflow.reconcile
board send <topic>
board receive <topic>
board process <topic>
board settle <topic>
jina.effect <effect-type>
jina.review.prepare
jina.review.summary
jina.review.runtime
jina.review.finalize
jina.review.publish
jina.review.settle
```

Trace/log attributes may include:

```text
jina.workflow.id
jina.workflow.type
jina.workflow.pipeline_version
jina.workflow.trigger
jina.task.id
jina.task.type
jina.task.topic
jina.task.attempt
jina.task.outcome
jina.failure.category
jina.tenant.id
jina.repository.id
jina.repository.full_name
jina.pull_request.number
jina.pull_request.head_sha
jina.review_run.id
jina.worker.release
jina.worker.revision
jina.sandbox.id
jina.effect.type
jina.effect.status
jina.model.provider
jina.model.name
jina.model.key_source
jina.usage.input_tokens
jina.usage.cached_input_tokens
jina.usage.output_tokens
```

Never record credentials, write-fence tokens, raw prompts, source bodies, review instructions, provider responses, or customer secrets as attributes/events.

### 10.5 Metrics

Emit OTel counters, histograms, and observable gauges:

```text
jina.board.workflow.admitted
jina.board.workflow.completed
jina.board.workflow.duration
jina.board.task.queued
jina.board.task.claimed
jina.board.task.completed
jina.board.task.queue_latency
jina.board.task.run_duration
jina.board.task.retry
jina.board.task.operator_retry
jina.board.lease.lost
jina.board.lease.renewal_failure
jina.board.queue.depth
jina.board.queue.oldest_age
jina.board.attempt.active
jina.review.findings
jina.review.publication
jina.review.usage.tokens
jina.review.billing.pending_age
jina.review.billing.reconciliation
```

Allowed metric dimensions are bounded values such as workflow type, task type, topic, outcome, failure category, trigger class, effect type, and deployment environment. Never use workflow/task/tenant/repository/PR/sandbox/trace IDs or arbitrary model names as metric labels.

### 10.6 Sampling and retention

- Record the custom workflow/admission/task-attempt/effect spans for every workflow initially.
- Sample low-value auto-instrumented HTTP/database detail separately if volume requires it.
- Always retain errors, retries, lease loss, slow attempts, and publication/billing failures.
- Keep the complete lifecycle in PostgreSQL regardless of OTel sampling or Cloud Trace retention.
- Review telemetry volume and cost before production; if child-span sampling is introduced, retain at least admission, every attempt outcome, every effect outcome, and terminal workflow spans for every workflow.

### 10.7 Dashboards and alerts

Cloud Monitoring dashboards must show:

- workflows admitted/completed by type and outcome;
- active workflows and age by phase;
- queue depth and oldest ready task by topic;
- queue latency and execution duration p50/p95/p99;
- retries and terminal failures by stable category;
- active attempts, lease loss, and renewal failures;
- worker capacity, release, revision, and last successful claim;
- GitHub publication success/failure/ambiguity;
- usage rows pending outcome/billing and oldest pending age;
- scheduled scan and billing reconciliation freshness;
- PostgreSQL pool wait, transaction latency, deadlocks, and claim latency; and
- OTel collector export failures/dropped telemetry.

Proposed paging conditions:

- ready-work age exceeds the review-start SLO;
- a workflow remains nonterminal beyond its configured deadline plus cleanup allowance;
- lease loss or renewal failure changes materially;
- duplicate/conflicting effect receipt is detected;
- GitHub publication or billing reconciliation repeatedly fails;
- scheduled scan/billing reconciliation has no successful workflow for two expected intervals;
- no accepted worker release is claiming while ready work exists; or
- terminal product state and Board workflow state diverge.

## 11. Dashboard and operator experience

### Customer dashboard

Continue using `review_runs` and its bounded dashboard projection for review lists. Add:

- Board workflow status and current phase;
- queue/start/run duration;
- summary/runtime/publication/settlement stage state;
- safe failure category and retry state;
- created/started/finished timestamps; and
- a detailed timeline from authorized Board events on the review detail page.

Use cursor pagination by `(created_at, id)`. Do not replay events to render the list.

### Admin dashboard

Add an operator workflow page with:

- filters for environment, tenant, workflow type, status, topic, release, date, and failure category;
- DAG/task state and dependency display;
- all attempts with lease timing, worker release, duration, and diagnostics;
- effect receipts and reconciliation status;
- immutable artifact links subject to authorization;
- direct Cloud Trace link from stored trace ID;
- operator retry/cancel/supersede controls with request idempotency; and
- queue health, oldest work, and stuck-work views.

Operator actions append events containing actor, reason, request key, and affected tasks. They never rewrite history.

## 12. Security and privacy

- Keep tenant ID on every Board row and apply the same tenant authorization/RLS strategy as the rest of v2.
- Worker claim credentials are topic- and service-scoped through release control.
- Store only fence hashes; return plaintext fences once.
- Sanitize every event, span, metric, and log field through a central allowlist.
- Keep GitHub tokens, model keys, Autumn credentials, and repository credentials out of Board metadata and artifacts.
- Encrypt sensitive product integrations through the existing secrets envelope.
- Restrict GCS artifacts by tenant/workflow prefix and immutable digest.
- Support customer erasure by deleting/cryptographically erasing customer content while retaining non-identifying operational and financial records required by policy.
- Treat repository name, PR number, author, and model route as trace/log data with controlled access, not metric labels.

## 13. Implementation phases

Each phase is independently deployable to staging and has an explicit exit gate.

### Phase 0 — baseline, flags, and contracts

Deliverables:

- capture current Trigger success rate, duration, retry, publication, usage, billing, and failure baseline;
- document current review event/result contracts with golden fixtures;
- inventory and classify every field currently serialized in `jina_runtime.api_state` (Board graph/events, Context roots/checkpoints, outbox/attempt state, tracked-PR state, and development delivery sequence) as migrate, derive, or retire, while preserving the adjacent `github_deliveries` and release-control tables;
- designate product `/webhooks/github` as the review admission owner, keep `/context/webhooks/github` Context-only, and add a regression proving one signed delivery cannot create both the basic and full review graphs;
- add client-aware product store/service methods and a shared `PoolClient` transaction coordinator for review admission;
- introduce `REVIEW_ORCHESTRATOR=trigger|board_shadow|board`;
- introduce per-tenant/repository Board canary policy and a global Board claim/publish kill switch;
- add `review_runs.orchestrator` and reserve `board_workflow_id`;
- define the old `run-review`, `apps/api/src/github-intake.ts`, `packages/review/src/pr-review-pipeline.ts`, `apps/workflows` simulation/CLI replacement or deletion map;
- define the six table/state/event schemas and API response compatibility; and
- define proposed SLOs and telemetry cardinality budgets.

Exit gate: existing behavior is unchanged in `trigger` mode, all golden fixtures pass, duplicate-admission tests prove one review owner, and an integration test commits/rolls back `review_runs` plus a placeholder Board workflow in one physical transaction.

### Phase 1 — relational Board repository

Deliverables:

- create migrations, least-privilege grants, indexes, and repository types;
- introduce versioned `jina_runtime.schema_migrations`, keep runtime-before-product migration order, and update `runtime-role.ts` table/sequence privileges;
- implement atomic admission, claim, renew, release, complete, retry, supersede, effects, and reads;
- implement the workflow-scoped `packages/board` reducer adapter with fixed lock ordering instead of duplicating reducer rules in SQL;
- refactor Context publication/PageIndex/issue-graph repositories to commit relational Board completion and `jina_context` rows/outbox on the same injected client;
- preserve worker release gating and internal endpoint contracts;
- implement workflow/task/event pagination and queue-health queries;
- add a staging importer for every phase-zero snapshot field classified as migrate, including dynamic Context graphs, active attempts/outbox deliveries, and tracked PRs; preserve and reconcile the existing delivery ledger and release-control rows without treating them as snapshot fields;
- add `JINA_BOARD_STORE=json|relational` only as a temporary migration flag; and
- run both repository contract suites against the same domain scenarios.

For staging, take a backup and use a short maintenance window to import/reset rebuildable Board state. Preserve the existing deployment-lock advisory key as a protocol constant through this transition, even after `api_state` stops being the data store. For a later production migration, import active workflows transactionally under that lock and verify per-workflow counts/digests before enabling claims. Production execution is outside this plan's current authorization.

Exit gate: Context and causal-graph acceptance pass on the relational repository, with no `api_state` mutation in relational mode.

### Phase 2 — OTel foundation

Deliverables:

- add SDK bootstrap and trace-aware logger integration;
- replace single-container deploy assumptions with named multi-container Cloud Run service manifests and update release/drain/preflight tests;
- deploy the Collector sidecar and required IAM in staging only after those deploy tests pass;
- add workflow/task/effect custom instrumentation and OTel metrics;
- persist workflow/task attempt trace contexts;
- add Cloud Trace links to admin workflow detail;
- create staging dashboards and alerts; and
- test service behavior with the collector stopped or rejecting exports.

Exit gate: a synthetic workflow is visible end-to-end in Board events, Cloud Trace, Cloud Logging, and metrics with matching workflow/trace IDs; telemetry outage does not affect task completion.

### Phase 3 — review code extraction

Deliverables:

- remove Trigger SDK dependencies from pure review, summary, runtime, Daytona, progress, and publication logic;
- move the independent `services/review-trigger` npm dependency graph into root pnpm workspace ownership and preserve compatibility adapters for the draining Trigger tasks;
- inject logging/tracing/clock/API dependencies;
- preserve normalized results and golden evals;
- implement immutable prepared, summary, runtime, and final artifacts; and
- add `GcsReviewArtifactStore`, staging bucket/IAM/lifecycle configuration, and phase checkpoints for expensive runtime work;
- update `apps/worker/Dockerfile` and its image probe with all Daytona-uploaded sources, GitHub/runtime helpers, binaries, and dependencies; and
- add a checked staging worker env/secret/IAM manifest covering every audited Trigger runtime variable.

Exit gate: extracted summary/runtime stages produce equivalent golden outputs without a Trigger runtime, and the built Cloud Run worker image passes a no-network startup/probe that resolves every packaged runtime asset.

### Phase 4 — Board review workflow

Deliverables:

- implement the versioned review planner and six review tasks;
- bind admission atomically to `review_runs`;
- route product webhook, manual command, dev harness, and CLI admission through that one coordinator while retaining Context-only relay behavior;
- implement dependencies, terminal-policy reconciliation, cleanup tasks, and supersession;
- add review-specific retries/backoff/timeouts/concurrency;
- implement product event/finding/result compatibility; and
- extend task-worker release/topic allowlists; and
- remove claimability of the old basic `run-review` topic once its tests/fixtures target the new graph.

Exit gate: local/Postgres integration E2E completes automatic and manual reviews with the same product records as Trigger fixtures.

### Phase 5 — effects, usage, and billing

Deliverables:

- implement GitHub progress/review effect receipts and reconciliation;
- preserve unique finding and usage dedupe contracts;
- make usage fallback a durable artifact consumed by settlement;
- implement Autumn effect receipts around existing billing claim states;
- extract and reuse `apps/api/src/product/internal.ts` domain services, including terminal guards and late/fallback usage behavior, instead of recreating them in worker handlers;
- ensure failed/superseded reviews charge or waive exactly as today; and
- implement publication/billing operator replay.

Exit gate: crash injection at every external-effect boundary produces one GitHub publication and one correct billing result.

### Phase 6 — schedules and installation workflows

Deliverables:

- add API OIDC issuer/audience/subject verification and a least-privilege staging Scheduler service account;
- create idempotently managed OIDC-authenticated Cloud Scheduler jobs through the existing shell/Cloud Build deployment flow;
- implement scheduled scan and billing reconciliation workflows;
- implement installation backfill workflows;
- preserve schedule slot and delivery idempotency; and
- add freshness metrics and alerts.

Exit gate: two full schedule intervals pass in staging, replayed ticks are deduped, and backfill acceptance passes without Trigger credentials.

### Phase 7 — dashboard and operations

Deliverables:

- expose current workflow phase on review pages;
- add admin workflow list/detail/timeline;
- add retry/cancel controls and authorization;
- add queue/worker/effect/billing health pages; and
- document runbooks for stuck workflows, provider outage, lease loss, deployment drain, and billing reconciliation.

Exit gate: an operator can diagnose and safely retry each injected failure using Board/admin data without Trigger's dashboard.

### Phase 8 — staging shadow and canary

`board_shadow` creates and traces an admission graph but does not make its tasks claimable and never performs model, GitHub, usage, or billing effects. It validates admission/dedupe/topology only.

Then move selected staging repositories to `board` ownership. Trigger must not receive those reviews. Increase canary scope only after comparing:

- terminal outcomes and event topology;
- findings/result compatibility;
- model usage and cost;
- GitHub progress/publication behavior;
- queue and end-to-end duration;
- retry/failure categories; and
- billing settlement.

Exit gate: the acceptance matrix and agreed soak period pass with no lost workflows, duplicate effects, stale commits, or unresolved billing rows.

### Phase 9 — Trigger cutover and removal

1. Stop new Trigger admissions by routing all eligible staging reviews to Board.
2. Leave Trigger deployed until its existing runs and schedules are drained/disabled.
3. Verify no active Trigger review/backfill run remains.
4. Verify scheduled workflows are healthy on Cloud Scheduler/Board.
5. Remove Trigger credentials from runtime service configuration.
6. Delete the Trigger client/config from the API.
7. Delete `services/review-trigger`, its package lock/config, and deploy workflow.
8. Remove Trigger environment variables, secret mounts, readiness checks, deploy steps, and acceptance parameters.
9. Rename Trigger-specific eval/script/docs terminology where it describes the old engine.
10. Run `rg`/dead-code/package audit gates proving no `@trigger.dev`, `trigger.dev`, `TRIGGER_*`, or `services/review-trigger` runtime dependency remains.
11. Retain the last known-good deployment artifact and unmounted secret for a defined rollback window, then delete/disable the Trigger project and secret.

Exit gate: a clean install, full test suite, deployment, real staging review, scheduled scan, billing reconciliation, and installation backfill succeed with Trigger unavailable.

### Repository-grounded change map

This is the minimum audited code surface. Discovery during implementation may add files, but none of these areas can be skipped.

| Concern                            | Current repository seam                                                                                                                                                    | Required change                                                                                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product review admission           | `apps/api/src/product/app.ts`, `github.ts`, `trigger.ts`, `store.ts`, `db.ts`                                                                                              | Make the product webhook/manual service the sole owner, add `PoolClient`-aware store functions, and commit product plus Board admission atomically.                     |
| Product review/usage/billing rules | `apps/api/src/product/internal.ts`, `billing.ts`, `store.ts`                                                                                                               | Extract domain services with existing terminal, usage-dedupe, fallback, claim, and settlement behavior; keep internal HTTP adapters while Trigger drains.               |
| Context webhook relay              | `apps/api/src/product/app.ts`, `apps/api/src/server.ts` `acceptParsedContextWebhook`                                                                                       | Preserve exact signed relay and Context-only admission; add a no-duplicate-review regression.                                                                           |
| Legacy basic review path           | `apps/api/src/github-intake.ts`, `packages/review/src/pr-review-pipeline.ts`, `packages/board/src/tasks.ts`, `apps/workflows/**`, `apps/worker/src/server.ts` `runReview`  | Replace fixtures/CLI callers with the full planner, then delete or retire the old planner/topic/handler so it cannot be claimed.                                        |
| Board domain                       | `packages/board/**`, `apps/api/src/server.ts`                                                                                                                              | Preserve reducer, dynamic Context expansion, leases, fences, supersession, release control, and HTTP worker contracts behind a workflow-scoped relational adapter.      |
| Current persistence                | `packages/db/src/postgres-json-state-store.ts`                                                                                                                             | Inventory/import all snapshot fields, add relational repository, then stop writes under a temporary store flag; retain rollback-read capability until acceptance.       |
| Context atomic Board bridges       | `packages/db/src/context/board-publication-repository.ts`, `board-pageindex-attachment-repository.ts`, `issue-graph-repository.ts`, and `jina_context.outbox` repositories | Replace direct `api_state` access with injected-client relational Board completion; retain the distinct Context outbox and commit both sides together.                  |
| Runtime schema and privileges      | `packages/db/src/migrate.ts`, `schema.ts`, `context/runtime-role.ts`, `apps/api/src/product/migrate-all.ts`, `apps/api/product-migrations/**`                              | Add versioned runtime migrations, six tables/indexes/checks/grants, run runtime before the product FK migration, and preserve deployment-lock protocol.                 |
| Trigger review agent               | `services/review-trigger/src/review/**`, `daytona/**`, `shared/**`, `src/trigger/**`, `trigger.config.ts`                                                                  | Port complete behavior/assets, replace `runs.list` supersession lookup, and leave thin Trigger adapters only for drain compatibility.                                   |
| Package/build ownership            | `services/review-trigger/package.json`, `package-lock.json`, root `pnpm-workspace.yaml`, `pnpm-lock.yaml`                                                                  | Move reusable runtime under the root workspace, reconcile versions, and make root CI own build/typecheck/test.                                                          |
| Pull worker                        | `apps/worker/src/server.ts`, `worker-topics.ts`, `Dockerfile`                                                                                                              | Add one handler per full review topic, include runtime assets/dependencies, propagate installation/trace context, retry full Board topics, and meter exact model usage. |
| Review artifacts                   | Context GCS artifact implementation under `packages/db`/`packages/context`                                                                                                 | Add a review-specific immutable store, bucket, IAM, lifecycle, digest/generation checks, and typed references.                                                          |
| Observability                      | `packages/observability/**`, API/worker entrypoints                                                                                                                        | Add pre-import OTel SDK init, trace-aware logger adapter, manual Board SQL spans, bounded metrics, shutdown flush, and propagation tests.                               |
| Cloud Run release                  | `scripts/cloud-build-deploy.sh`, `scripts/deploy-staging.sh`, preflight/readiness/deploy tests                                                                             | Replace one-container assumptions with named multi-container manifests before collector sidecars; add review worker env/secrets/IAM and fixed warm pools.               |
| Schedules                          | Trigger scheduled tasks plus staging/production deploy scripts                                                                                                             | Add OIDC verifier, service account/IAM, idempotent Scheduler reconciliation, slot-dedupe tests, and freshness alerts.                                                   |
| Trigger removal                    | `.github/workflows/deploy-review-trigger.yml`, `.github/workflows/validate-platform.yml`, staging Trigger env/secrets/readiness checks                                     | Remove only after drain and Board E2E; repository-wide search must show no runtime Trigger dependency or configuration.                                                 |

Known compatibility details to preserve during cutover include existing GitHub progress/review markers, including recognition of historical `jina-simulation:*` markers; comment-based manual-review ordering; `review_runs.idempotency_key`; unique finding fingerprints and usage dedupe keys; release gates; and the Trigger convention of returning a failed stage result in cases where throwing would repeat expensive model work.

## 14. Testing and acceptance matrix

### Unit tests

- legal/illegal state transitions;
- dependency conditions and join behavior;
- idempotent admission and completion replay;
- retry classification, maximum attempts, jitter bounds, and deterministic failures;
- supersession/manual-command ordering;
- event sanitization and metadata size bounds;
- effect key generation and conflicting digest rejection;
- OTel attribute allowlists and metric-cardinality guard; and
- traceparent persistence/extraction/link creation.

### PostgreSQL integration tests

- product `review_runs` plus Board workflow/tasks/events commit and roll back on the same `PoolClient`;
- many concurrent claimers receive distinct tasks via `SKIP LOCKED`;
- concurrent commands for different workflows do not contend on a global lock, while same-workflow commands serialize without deadlock;
- one task cannot have two active attempts;
- stale/expired/fenced completion is rejected;
- completion and dependent queueing are atomic;
- a lost HTTP completion response can replay safely;
- duplicate webhooks return the original workflow;
- the product webhook plus Context relay create exactly one review workflow and the expected Context work, never a legacy basic review;
- dynamic Context completion creates child tasks/dependencies atomically and matches the JSON reducer contract;
- Context publication/PageIndex/issue-graph fault injection proves Board completion and `jina_context` state/outbox always commit or roll back together;
- importer count/digest fixtures cover all classified `api_state` fields rather than only active task rows;
- event rows are append-only;
- operator retries are request-idempotent;
- dashboard pagination is stable during concurrent inserts;
- no query depends on scanning event payload JSON; and
- queue queries use intended indexes under `EXPLAIN` fixtures.

### Build and deployment tests

- the worker image resolves every Daytona-uploaded source, binary, helper, and runtime dependency as the non-root runtime user;
- staging service manifests contain the exact review secrets/env and least-privilege artifact/telemetry IAM bindings;
- deploy/preflight logic addresses containers by name, verifies both application and collector image digests, and rejects an unrecognized sidecar;
- candidate isolation, paused-claim drain, health, rollback, and old-revision cleanup work on multi-container revisions;
- the API accepts only the intended Scheduler OIDC issuer/audience/service-account subject; and
- dashboard deployment remains Vercel-only and does not require a localhost collector.

### Failure/chaos tests

Inject failure:

- after admission commit but before the HTTP response;
- after claim but before execution;
- during model/Daytona execution;
- after an artifact upload but before task completion;
- after GitHub accepts publication but before receipt completion;
- after usage insertion but before stage completion;
- after Autumn accepts an event but before response/receipt completion;
- during lease renewal;
- during API/worker deployment drain;
- after PR head supersession while an old worker runs;
- during PostgreSQL restart/failover;
- between product-row insertion and Board-row insertion inside admission, proving full rollback;
- with the OTel collector unavailable; and
- with a missed/replayed Cloud Scheduler tick.

Required outcomes: no lost accepted workflow, no stale commit, no duplicate external effect, deterministic terminal or recoverable state, and a complete durable incident timeline.

### Load tests

Use a staging dataset at several times expected peak:

- webhook burst admission;
- concurrent summary/runtime fan-out;
- lease renewals for long runtime stages;
- mixed review, Context, and causal-graph work;
- dashboard list/detail reads during claims/completions; and
- retry storms under provider 429/5xx.

Measure database CPU, connections, lock/claim latency, ready-work age, transaction p95/p99, WAL, table/index growth, worker utilization, and telemetry volume. More workers must increase completed-task throughput until an identified external/provider limit; they must not recreate a global database lock.

### Real staging E2E

Using the staging GitHub App and controlled fixture repositories, verify:

- automatic PR review;
- manual `@usejina` review and custom instructions;
- repeated webhook delivery;
- product webhook plus signed Context relay admission cardinality;
- new-head supersession;
- summary and runtime fan-out/join;
- Daytona runtime and checkpoints;
- Context and causal graph remain functional;
- findings and GitHub inline/file comments;
- progress comment updates;
- user/managed/harness model routing;
- usage capture and Autumn staging settlement;
- dashboard and admin workflow views;
- Cloud Trace/log/metric correlation from webhook through every task/effect, with an intentional collector outage proving workflow continuity;
- scheduled review scan;
- billing reconciliation; and
- installation/repository backfill.

## 15. Proposed SLOs and release gates

Finalize numerical targets from the Trigger baseline, but the release gates are non-negotiable:

- 100% of acknowledged admissions have a durable workflow and review run;
- zero duplicate GitHub publications in replay/chaos acceptance;
- zero duplicate usage or Autumn charges in replay/chaos acceptance;
- zero accepted stale completions after lease loss or supersession;
- every nonterminal workflow has ready, leased, retry-wait, or explicitly blocking work;
- every terminal review has a terminal Board workflow or visible reconciliation state;
- queue-start and end-to-end review latency do not regress materially from the baseline at expected peak;
- scheduled scan and billing reconciliation freshness remain within two intervals;
- no unresolved effect receipt ambiguity remains after reconciliation; and
- every accepted workflow has a trace ID, admission event, task/attempt timeline, and terminal/reconciliation event.

Suggested initial operational objectives:

- p95 ready-to-claim latency below 30 seconds while capacity is healthy;
- terminal reconciliation within 15 minutes after the last review stage/effect outcome;
- no ready task older than its task-specific start SLO without an alert; and
- 99.9% successful lease renewals excluding deliberate fencing/deployment drains.

## 16. Rollback

Before Trigger deletion:

- set new admissions back to `trigger` for unaffected repositories if Board admission/worker health fails;
- pause Board claims and publications;
- allow existing Board-owned workflows to drain or explicitly cancel them through audited controls; and
- never re-dispatch an existing Board review to Trigger.

After Trigger deletion:

- rollback uses the retained prior immutable API/Trigger deployment artifacts during the defined window;
- restore Trigger credentials only to the old isolated revision, never the Board revision;
- route only new admissions to the old engine; and
- preserve Board-owned workflow identity and side-effect receipts.

Database migrations are additive through cutover. Do not drop `api_state`, Trigger compatibility columns, or old deploy metadata until the rollback window and production acceptance are complete. Dropping them is a later reviewed migration.

## 17. Definition of done

The migration is complete when:

- product and Board admission share one proven database transaction and one review owner;
- all review, schedule, billing-retry, and installation-backfill admissions use relational Board workflows;
- the six-table Board is the only active Board persistence implementation;
- Context and causal graph pass their existing acceptance on it;
- every classified `api_state` field has been migrated, derived, or explicitly retired, and the old basic `run-review` path is no longer claimable;
- the Cloud Run worker image contains and has exercised the full Daytona review agent with staging-only secrets, artifact IAM, and GitHub App identity;
- every new workflow is fully represented in append-only Board events and OTel;
- customer and admin dashboards expose current and historical workflow detail;
- real staging reviews pass the functional, failure, billing, and observability matrix;
- deployment drain, retry, cancel, supersession, and rollback runbooks have been exercised;
- Trigger has no active runs or schedules;
- Trigger runtime credentials are unmounted;
- Trigger source, SDK dependencies, package lock, configuration, deployment workflow, scripts, and current documentation are removed; and
- repository-wide tests, typecheck, lint, dead-code, package audit, staging deploy, and acceptance all pass with Trigger.dev unreachable.
