# Data Models

This document defines the core Postgres data model for Jina. It is the schema-oriented companion to [ARCHITECTURE.md](ARCHITECTURE.md).

Jina is board-driven: **tasks** are the board cards executed by agents and humans, a versioned **pipeline** (code, not a table) plans which tasks a trigger creates, and Trigger.dev schedules one stateless run per ready task with a transactional **outbox** as the dispatch bridge. Postgres is the source of truth. Agent handoff is durable board state: dependencies, task events, context records, artifacts, and assignments.

Deliberately deferred tables — introduced only when a second concrete use exists:

- `work_orders` (normalized intake) — when a non-PR intake type (issues, incidents, manual requests) actually ships. Until then `pull_requests` is the intake record.
- a pipeline/stage-template table — when tenants can configure pipelines. Until then the PR review pipeline is versioned code, and root tasks record `pipeline_slug`/`pipeline_version`.

## Conventions

- Every tenant-owned table includes `tenant_id`.
- External GitHub IDs are stored separately from internal IDs.
- JSON fields hold provider payloads, policy blobs, model usage, and extensibility points — not primary relational links.
- Side effects are idempotent through unique keys: GitHub delivery IDs, task dedupe keys, outbox idempotency keys, verb idempotency keys, checkout keys, publication keys.
- Review repository checkouts happen inside Daytona sandboxes. GCP runtimes persist checkout metadata but do not host PR working trees.
- Agents never receive clone credentials. A checkout broker performs authenticated clone/fetch, removes credentials from the sandbox, then hands a read-only working tree to the reviewer.
- External docs and dependency docs are untrusted input. Store source attribution and snapshots as `context_items` and artifacts when policy allows.

## Tenancy

```text
tenants
- id
- name
- plan
- created_at

tenant_memberships
- tenant_id
- user_id
- role
- created_at

users
- id
- primary_email nullable
- display_name nullable
- avatar_url nullable
- created_at
- updated_at

github_identities
- id
- user_id nullable
- github_user_id
- github_node_id nullable
- login
- account_type
- site_admin
- created_at
- updated_at
```

All application queries must be scoped by `tenant_id`. Postgres row-level security can be added later for defense in depth, but application-level scoping is still required.

Suggested constraints:

```text
unique(github_identities.github_user_id)
unique(github_identities.github_node_id) where github_node_id is not null
unique(tenant_memberships.tenant_id, tenant_memberships.user_id)
```

Human-triggered verbs must resolve the GitHub actor to a `github_identities` row, then authorize through tenant membership, GitHub repository permissions, or explicit tenant policy. Store the actor snapshot on the verb invocation and event so audit history survives later role changes.

## GitHub Installation And Repositories

```text
github_installations
- id
- tenant_id
- installation_id
- account_login
- account_type
- repository_selection
- permissions jsonb
- suspended_at nullable
- created_at
- updated_at

repositories
- id
- tenant_id
- github_repo_id
- installation_id
- owner
- name
- full_name
- default_branch
- enabled
- config jsonb
- created_at
- updated_at
```

Suggested constraints:

```text
unique(github_installations.installation_id)
unique(repositories.tenant_id, repositories.github_repo_id)
unique(repositories.tenant_id, repositories.full_name)
```

## Review Policy

```text
review_policies
- id
- tenant_id
- repo_id nullable
- name
- enabled
- publish_mode
- advisory_only
- require_human_approval
- max_files
- max_diff_lines
- clone_depth
- checkout_strategy
- max_findings
- max_inline_comments
- min_publish_severity
- min_publish_confidence
- budget_unit                 # tokens | usd | task_count
- budget_limits jsonb         # { per_epoch, per_pr_total, per_repo_per_day }
- review_rate_limit jsonb     # { max_review_runs_per_pr_per_hour, synchronize_debounce_seconds }
- context_egress_enabled
- context_source_allowlist jsonb
- context_fetch_limits jsonb  # max_sources, max_bytes_per_source, timeout_ms, max_redirects
- context_retention_days nullable
- require_context_citations
- prompt_injection_policy jsonb
- instructions jsonb
- created_at
- updated_at
```

`repo_id = null` is a tenant-level default policy; repository policies override it.

`checkout_strategy` examples: `head_only`, `base_and_head`, `merge_ref`.

`budget_limits` defines layered ceilings enforced at verb time and dispatch time: per epoch, per PR cumulative (never reset by a force push), and per repo per day. The cumulative and per-repo ceilings bound hostile force-push loops; fork PRs get lower defaults. Context egress fields define whether `run-research` can fetch external sources, where it can fetch from, how much it can fetch, how long source snapshots can be retained, and whether citations are required.

## Review Policy Snapshots

```text
review_policy_snapshots
- id
- tenant_id
- repo_id nullable
- review_policy_id nullable
- effective_policy jsonb
- instruction_sources jsonb
- instruction_hash
- prompt_version
- model_policy jsonb
- created_at
```

Review runs link to the snapshot they used, making reviews reproducible after tenant settings, repo instructions, prompts, or model policy change. The snapshot is also the authority for source-allowlist checks on context requests made by that review — a mid-flight policy edit cannot widen an in-progress review's scope.

## Pull Requests And GitHub Subjects

```text
pull_requests
- id
- tenant_id
- repo_id
- github_pr_id
- number
- title
- author_login
- author_association nullable
- state
- base_repo_id
- base_repo_full_name
- base_ref
- base_sha
- head_repo_id nullable
- head_repo_full_name        # provenance only; checkouts fetch refs/pull/{n}/head from the base repo
- head_is_fork
- head_ref
- head_sha
- current_epoch              # bumped on each head SHA change; drives supersession
- merge_ref nullable
- merge_sha nullable
- draft
- merged
- budget_spent jsonb         # cumulative for the PR lifetime, plus per-epoch breakdown
- metadata jsonb
- created_at
- updated_at

github_subjects
- id
- tenant_id
- repo_id
- subject_type
- github_id nullable
- github_node_id nullable
- number nullable
- title nullable
- state nullable
- url nullable
- last_event_at
- metadata jsonb
- created_at
- updated_at
```

Suggested constraints:

```text
unique(pull_requests.tenant_id, pull_requests.repo_id, pull_requests.number)
unique(github_subjects.tenant_id, github_subjects.repo_id, github_subjects.subject_type, github_subjects.number) where number is not null
unique(github_subjects.tenant_id, github_subjects.github_id) where github_id is not null
unique(github_subjects.tenant_id, github_subjects.github_node_id) where github_node_id is not null
```

Subject types: `pull_request`, `issue`, `review`, `review_comment`, `check_run`, `workflow_run`.

`pull_requests` is the canonical PR table and the MVP intake record; `github_subjects` is the routing abstraction for webhooks and comments. `repo_id` is the base repository.

## Webhook Events

```text
github_webhook_events
- id
- tenant_id nullable
- delivery_id
- event_type
- action
- installation_id nullable
- repo_full_name nullable
- received_at
- processed_at nullable
- status                     # received | processing | processed | ignored | failed
- payload jsonb
- error jsonb
```

Suggested constraints:

```text
unique(github_webhook_events.delivery_id)
```

Downstream mutations use delivery-aware idempotency keys, e.g. `github:{delivery_id}:upsert-pr`.

## Tasks

`tasks` is the central work table — the board cards.

```text
tasks
- id
- tenant_id
- root_task_id nullable
- parent_task_id nullable
- repo_id nullable
- github_pr_id nullable
- github_subject_type nullable
- github_subject_number nullable
- type
- status
- head_sha nullable
- epoch nullable             # the PR epoch this task belongs to
- pipeline_slug nullable     # set on root tasks: which pipeline planned this graph
- pipeline_version nullable
- harness_version_id nullable
- required_caps jsonb        # capabilities a runtime must hold to execute this task
- dedupe_key nullable
- title
- description
- priority
- assigned_agent_id nullable
- assigned_user_id nullable
- created_by_actor_type
- created_by_actor_id
- metadata jsonb
- created_at
- updated_at
```

Task types and kinds:

```text
MVP/core:     pr_review (aggregate), review_pass, context, publish (dispatchable), human_decision (waitpoint)
Future/gated: finding, grounding, fix, plan, build, test, docs, release, incident_triage, github_issue_triage
```

Every type has a declared kind — `aggregate` (auto-completes from edges, never executes), `dispatchable` (queued to Trigger.dev; dispatch topic derived from type), or `waitpoint` (only a user verb completes it).

Task statuses:

```text
triage, blocked, queued, in_progress, in_review, done, canceled, failed, superseded
```

Suggested constraints:

```text
unique(tasks.tenant_id, tasks.type, tasks.dedupe_key) where dedupe_key is not null
index(tasks.tenant_id, tasks.status)
index(tasks.tenant_id, tasks.root_task_id)
index(tasks.tenant_id, tasks.github_pr_id, tasks.epoch)
```

The root `pr_review` task owns the PR review for an epoch. Review passes, context tasks, publication tasks, human decisions, and future grounding/fix tasks are child tasks.

`dedupe_key` gives idempotent creation and is **epoch-scoped**: one root `pr_review` per `(pr, epoch)`; one `review_pass` per `(pr, epoch, review_profile)`; one `publish` task per `(pr, epoch, publication_mode)`; one context task per `(target_task_id, normalized_source_set, question_hash)`. Head SHAs can recur across epochs (force-push away and back), so `head_sha` belongs in publication keys, not task dedupe keys.

## Task Dependencies

Parent/child structure is not enough to decide execution order or completion. Dependency edges drive the readiness reducer and root completion.

```text
task_dependencies
- id
- tenant_id
- task_id
- depends_on_task_id
- relationship              # blocks | relates_to | context_for | verifies | fixes | publishes | supersedes
- required
- created_at
```

`relationship` describes why `task_id` depends on `depends_on_task_id`: it is blocked by it, gets context from it, is verified by it, is published by it.

Suggested constraints:

```text
unique(task_dependencies.tenant_id, task_id, depends_on_task_id, relationship)
index(task_dependencies.tenant_id, depends_on_task_id)
```

A task becomes `queued` only when every `required` dependency is `done`. Root completion is purely edge-based: the aggregate root completes when all its required edges are satisfied. To keep dynamically created children visible to completion, `CreateTask` with `blocks_parent_completion = true` materializes a required `root -> child` edge in the same transaction — the flag is an instruction to the verb layer, not a column the reducer reads. If a required dependency reaches `failed` or `canceled`, the reducer transitions the dependent to `blocked` and creates a linked `human_decision` task.

Exact context handoff dependency rows:

```text
task_id = review_pass_id, depends_on_task_id = context_task_id, relationship = context_for, required = true
task_id = root_task_id,   depends_on_task_id = context_task_id, relationship = blocks,      required = true   # materialized by the verb layer
```

## Task Events

```text
task_events
- id                         # bigserial; the board-wide live-feed cursor
- tenant_id
- task_id
- seq                        # per-task counter; orders one task's timeline
- actor_type
- actor_id
- event_type
- body
- payload jsonb
- created_at
```

MVP event types:

```text
github.pr_opened
github.pr_synchronized
github.pr_closed
task.created
task.assigned
task.status_changed
verb.submitted
verb.accepted
verb.rejected
review.checkout_started
review.checkout_ready
review.checkout_failed
review.checkout_destroyed
review.checkout_leaked
review.started
review.context_requested
review.resumed
review.completed
review.superseded
context.requested
context.source_fetched
context.collected
context.failed
finding.created
finding.dismissed
publish.started
publish.completed
publish.failed
run.failed
outbox.dead_lettered
```

Future event types: `grounding.requested`, `grounding.verified`, `grounding.refuted`, `fix.requested`, `fix.pushed`.

`seq` is per-task, assigned in the same transaction that locks the task row for its transition. Per-task timelines page by `(task_id, seq)`; the board-wide feed pages by the global `id` cursor (`where tenant_id = ? and id > ? order by id`, indexed on `(tenant_id, id)` — strictly increasing, gaps are fine). Agent-posted context (e.g. extracted dependency docs) is a `context.collected` event whose payload references `context_items` and artifacts. The board thread is the agent's shared memory.

## Context Items

`context_items` stores extracted context that one task contributes to another. It keeps context handoff queryable instead of hiding it inside a long comment body.

```text
context_items
- id
- tenant_id
- task_id                    # the context task that produced this item
- target_task_id nullable    # the review/task expected to consume it
- source_type                # external_doc | dependency_doc | repo_file | issue_comment | human_note | tool_output
- source_uri nullable
- source_title nullable
- source_version nullable    # doc version, package version, commit SHA, etag, or retrieved revision
- source_retrieved_at nullable
- trust_level                # untrusted | tenant_allowed | repo_internal | human_provided
- excerpt_artifact_id nullable
- summary
- extracted_facts jsonb
- citations jsonb
- prompt_injection_flags jsonb
- retention_expires_at nullable
- created_at
```

Suggested constraints:

```text
index(context_items.tenant_id, context_items.task_id)
index(context_items.tenant_id, context_items.target_task_id)
```

Large source snapshots live in `review_artifacts`. `context_items.citations` should point to stable source locations when available. A resumed review task assembles its context bundle from its own `task_events`, linked `context_for` tasks, `context_items`, and artifacts.

## Outbox

The transactional dispatch bridge between the board and Trigger.dev.

```text
outbox
- id
- tenant_id
- task_id
- attempt
- trigger_task              # e.g. run-review
- concurrency_key           # tenant_id (per-tenant fairness)
- payload jsonb
- status                    # pending | dispatched | dead_lettered
- attempts
- next_attempt_at           # also used to debounce synchronize-seeded work
- dispatched_at nullable
- last_error jsonb
- created_at
```

Suggested constraints:

```text
unique(outbox.tenant_id, outbox.task_id, outbox.attempt)
index(outbox.status, outbox.next_attempt_at)
```

An outbox row is inserted in the **same transaction** as the transition that made a task `queued` (by the readiness reducer or a webhook verb). The relay drains `pending` rows and calls `trigger(trigger_task, {taskId}, {idempotencyKey: task_id:attempt, concurrencyKey})`. The idempotency key makes the relay safe to retry; persistent failures move to `dead_lettered` for repair.

## Gates And Harness Versions

```text
gate_results
- id
- tenant_id
- task_id
- gate_slug
- gate_type                 # policy | budget | review | test | approval | publication | security
- status                    # pending | passed | failed | waived
- evidence_artifact_id nullable
- decided_by_actor_type nullable
- decided_by_actor_id nullable
- payload jsonb
- created_at

harness_versions
- id
- tenant_id
- name
- version
- prompt_version nullable
- tool_config jsonb
- context_rules jsonb
- eval_suite_ref nullable
- model_policy jsonb
- created_at
```

Suggested constraints:

```text
unique(harness_versions.tenant_id, harness_versions.name, harness_versions.version)
index(gate_results.tenant_id, gate_results.task_id)
```

Gate results attach to tasks — there is no separate stage table; a stage *is* a task. Harness versions are immutable per root task: a new prompt, tool config, model policy, or context rule creates a new row so run outcomes can be compared over time.

## Agents And Review Profiles

```text
agents
- id
- tenant_id
- name
- type
- capabilities jsonb
- runtime_config jsonb
- enabled
- created_at
- updated_at

review_profiles
- id
- tenant_id
- name
- slug
- description
- agent_id
- enabled
- required
- config jsonb
- created_at
- updated_at
```

Agent types: `reviewer`, `publisher`, `researcher`, and future `planner`, `builder`, `tester`, `documenter`, `release`, `operator`, `grounding`, `fixer`. (There is no `coordinator` agent — orchestration is the board reducer, not an agent.)

MVP-enabled capabilities:

```text
can_read_repo
can_read_pr_diff
can_clone_repo
can_create_tasks
can_request_context
can_attach_context
can_update_findings
can_publish_review
```

Capability-gated read-only capabilities: `can_fetch_external_docs`.

Future capabilities, disabled by default: `can_plan_work`, `can_edit_code`, `can_run_tests`, `can_write_docs`, `can_prepare_release`, `can_triage_incident`, `can_execute_code`, `can_push_commits`, `can_open_pr`, `can_update_pr`.

`review_profiles` define what kind of review an agent performs (e.g. `security`, `correctness`, `test-quality`, `maintainability`, `repo-custom`). One `review_pass` task is created per enabled profile. Required profiles block publishing and root completion; optional profiles can fail without failing the root PR review if policy allows.

## Task Runs

One row per Trigger.dev run attempt for a task.

```text
task_runs
- id
- tenant_id
- task_id
- agent_id nullable
- trigger_run_id
- trigger_task_identifier
- idempotency_key
- attempt
- head_sha
- runtime_provider          # daytona for review runs
- runtime_instance_id nullable
- checkout_ref nullable
- status                    # queued | running | succeeded | deferred | failed | canceled | superseded
- input jsonb
- output jsonb
- token_usage jsonb
- cost jsonb
- started_at nullable
- completed_at nullable
- error jsonb
```

Suggested constraints:

```text
unique(task_runs.tenant_id, task_runs.idempotency_key)
index(task_runs.tenant_id, task_runs.task_id)
```

A task describes work; a task run describes a concrete execution attempt. For MVP review runs, `runtime_provider = daytona`, `runtime_instance_id` is the sandbox/session, and `checkout_ref` is the reviewed head SHA. `deferred` means the attempt reached a valid waitpoint, such as requesting context and blocking the task, rather than completing the review. Runs report `token_usage`/`cost`, which increment `pull_requests.budget_spent`.

## Review Checkouts

`review_checkouts` records repository clone and sandbox lifecycle separately from the run attempt — an auditable answer to where code was cloned for review.

```text
review_checkouts
- id
- tenant_id
- repo_id
- pr_id
- task_id
- task_run_id nullable
- checkout_key
- runtime_provider
- runtime_instance_id
- checkout_path nullable
- base_repo_full_name
- head_repo_full_name       # provenance only
- base_sha
- head_sha
- checkout_ref
- checkout_sha
- merge_sha nullable
- clone_depth
- checkout_strategy         # strategy actually used (merge_ref may fall back to head_only)
- credential_mode           # github_app_installation_token | none_public_repo
- credentials_purged_at nullable
- status                    # creating | cloning | ready | destroying | destroyed | failed | expired | leaked
- created_at
- requested_destroy_at nullable
- ready_at nullable
- destroyed_at nullable
- expires_at
- error jsonb
```

Suggested constraints:

```text
unique(review_checkouts.tenant_id, review_checkouts.checkout_key)
unique(review_checkouts.tenant_id, review_checkouts.runtime_provider, review_checkouts.runtime_instance_id)
index(review_checkouts.tenant_id, review_checkouts.pr_id, review_checkouts.head_sha)
index(review_checkouts.status, review_checkouts.expires_at)
```

Checkouts use scoped GitHub App installation tokens against the **base repository only**; fork heads are fetched as `refs/pull/{n}/head`. Tokens must not be stored in this table. The broker clones/fetches, removes credentials, records `credentials_purged_at`, and only then allows the reviewer to inspect files.

## Verb Invocations

Every generic-verb invocation (from agents, GitHub comments, the dashboard, or the system) is recorded for audit and idempotency. This is the board's command-audit log.

```text
verb_invocations
- id
- tenant_id
- task_id nullable
- agent_id nullable
- task_run_id nullable
- source                    # agent | github_comment | dashboard | system
- source_external_id nullable
- requested_by_actor_type
- requested_by_actor_id nullable
- github_actor_login nullable
- github_comment_id nullable
- verb                      # CreateTask | UpdateTask | TransitionTask | CommentTask | LinkTask | AssignTask | AttachArtifact
- idempotency_key
- status                    # submitted | accepted | rejected | applied | failed
- authorization_result      # allowed | denied | policy_disabled | permission_unknown
- input jsonb
- output jsonb
- error jsonb
- created_at
- processed_at nullable
```

Suggested constraints:

```text
unique(verb_invocations.tenant_id, verb_invocations.source, verb_invocations.idempotency_key)
unique(verb_invocations.tenant_id, verb_invocations.source, verb_invocations.source_external_id) where source_external_id is not null
```

Each accepted/rejected verb emits exactly one `task_event`. Verbs targeting disabled capabilities (e.g. requesting grounding while it is off) are stored with `status = rejected` and `authorization_result = policy_disabled`, keeping the audit trail complete.

## Review Runs And Findings

```text
review_runs
- id
- tenant_id
- task_id
- pr_id
- task_run_id
- checkout_id nullable
- review_profile_id
- policy_snapshot_id
- harness_version_id nullable
- trigger
- status
- base_sha
- head_sha
- model_name
- prompt_version
- started_at
- completed_at nullable
- token_usage jsonb
- error jsonb

finding_threads
- id
- tenant_id
- pr_id
- fingerprint
- verification_status
- publication_status
- resolution_status
- first_seen_head_sha
- last_seen_head_sha
- current_finding_id nullable
- superseded_by_thread_id nullable
- created_at
- updated_at

review_findings
- id
- tenant_id
- finding_thread_id
- review_run_id
- task_id nullable
- verification_status
- publication_status
- resolution_status
- severity
- category
- title
- body
- file_path
- line_start
- line_end
- fingerprint
- evidence jsonb
- confidence
- suggestion jsonb
- created_at
- updated_at

finding_locations
- id
- tenant_id
- review_finding_id
- file_path
- commit_sha
- base_sha
- head_sha
- side
- start_side nullable
- line_start nullable
- line_end nullable
- original_line_start nullable
- original_line_end nullable
- diff_hunk nullable
- github_position nullable
- created_at
```

Status vocabularies:

```text
verification: suspected | needs_grounding | verified | refuted
publication:  unpublished | publish_pending | published | publish_failed | suppressed
resolution:   open | dismissed | superseded | fix_requested | fixed
```

`review_runs` is the review-specific view of a `review_pass` task's run (`task_run_id` links them). `review_findings` are per-run observations; `finding_threads` are the durable cross-run identity for dashboards, dedupe, and publication (thread merging uses `finding_threads.superseded_by_thread_id`). The `fingerprint` dedupes repeated findings across PR updates (repository, file path, normalized line/hunk context, rule/profile, normalized content). Findings are grouped before publication, and GitHub inline comments are generated from `finding_locations`, not only `line_start`/`line_end`.

Suggested constraints:

```text
unique(finding_threads.tenant_id, finding_threads.pr_id, finding_threads.fingerprint)
index(review_findings.tenant_id, review_findings.review_run_id)
index(review_findings.tenant_id, review_findings.finding_thread_id)
index(finding_locations.tenant_id, finding_locations.review_finding_id)
```

## Publications

```text
review_publications
- id
- tenant_id
- pr_id
- publication_key
- review_run_id nullable
- task_id nullable
- finding_thread_id nullable
- github_object_type
- publication_target
- github_object_id nullable
- github_review_id nullable
- github_check_run_id nullable
- github_comment_id nullable
- head_sha
- file_path nullable
- line_start nullable
- line_end nullable
- status                    # pending | published | updated | failed | superseded
- payload jsonb
- published_at nullable
- error jsonb
```

Publication modes: `pr_review_comment`, `issue_comment`, `check_run`, `check_annotation`, `label`, `status`.
Publication targets: `finding_inline`, `review_summary`, `check_run`, `check_annotation`, `label`, `commit_status`.

Suggested constraints:

```text
unique(review_publications.tenant_id, review_publications.publication_key)
index(review_publications.tenant_id, review_publications.pr_id, review_publications.head_sha)
```

`publication_key` is deterministic per target, e.g. `pr:{pr_id}:summary:{head_sha}`, `pr:{pr_id}:check:{name}:{head_sha}`, `finding:{finding_thread_id}:inline:{head_sha}`. Publish retries update or no-op existing rows instead of duplicating GitHub comments. The `head_sha` in the key is the fencing token: a superseded epoch's publish cannot clobber the current one.

## Review Artifacts

```text
review_artifacts
- id
- tenant_id
- review_run_id nullable
- task_run_id nullable
- task_id nullable
- artifact_type
- storage_url nullable
- inline_payload jsonb nullable
- redaction_status
- retention_expires_at nullable
- deleted_at nullable
- created_at
```

Artifact types:

```text
summary
prompt_snapshot
context_manifest
context_bundle           # the rehydrated context a stateless run loaded
context_source_snapshot
context_extraction
checkout_manifest
tool_trace
candidate_findings
publication_preview
future_grounding_logs
future_fix_patch
```

Source-like artifacts obey tenant retention policy and may be disabled for sensitive repositories.

## Dashboard Read Models

The dashboard queries API-shaped read models, not raw internals. These can start as SQL views and later become materialized tables. Each remains tenant-scoped.

```text
task_board_items
task_timeline_items
task_dependency_edges
context_item_summaries
gate_summaries
pr_review_summaries
finding_list_items
task_run_summaries
publication_summaries
checkout_summaries
```
