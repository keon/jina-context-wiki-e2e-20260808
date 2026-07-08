# Sequence Diagrams

These diagrams describe the main Jina flows in the board / Trigger.dev model. They use Mermaid syntax. MVP diagrams are review-only; context handoff is capability-gated and non-mutating; grounding, fixing, and broader pipelines are future extension points.

Orchestration is the board, not a coordinator workflow. A task becomes ready via the readiness reducer, is dispatched by a transactional outbox + relay, and is executed by a stateless Trigger.dev run that writes results back through generic verbs. Runs and HTTP handlers never mark tasks complete out-of-band; they transition tasks, which re-runs the reducer.

Participants:

- **API** — API server (verify webhooks, apply generic verbs, run the readiness reducer).
- **Board** — Postgres source of truth: tasks, dependencies, events, runs, gates, outbox.
- **Relay** — outbox relay that triggers runs.
- **Trigger** — Trigger.dev (scheduler + durable execution).
- **Run** — a stateless per-task run (run-review, run-publish, ...).
- **Daytona** — review sandbox checkout.

## GitHub Trigger Routing (MVP)

```mermaid
sequenceDiagram
    autonumber
    participant GitHub
    participant API
    participant Board as Postgres Board
    participant Relay as Outbox Relay
    participant Trigger as Trigger.dev
    GitHub->>API: webhook event
    API->>API: Verify signature
    API->>Board: Insert raw webhook by delivery_id (dedupe)
    API->>API: Resolve tenant, repo, subject. Ignore self bot events
    rect rgb(235,245,255)
    note right of API: apply verbs + reducer + outbox, one tx
    alt Pull request event
        API->>Board: Upsert PR, plan pr_review pipeline tasks for current epoch
    else Comment on PR
        API->>Board: Parse command verb, create command or human_decision task
    else Installation event
        API->>Board: Upsert installation, enable or suspend repositories
    end
    API->>Board: Append task_events, reducer queues ready tasks, insert outbox rows
    end
    API-->>GitHub: 200 OK
    Relay->>Board: Drain pending outbox
    Relay->>Trigger: trigger run-type with taskId, idempotencyKey, concurrencyKey=tenant
```

## PR Opened Or Updated (MVP)

```mermaid
sequenceDiagram
    autonumber
    participant GitHub
    participant API
    participant Board as Postgres Board
    participant Relay as Outbox Relay
    participant Trigger as Trigger.dev
    participant Run as run-review
    GitHub->>API: pull_request webhook
    API->>Board: Insert raw webhook by delivery_id (dedupe)
    rect rgb(235,245,255)
    note right of API: one transaction
    API->>Board: Upsert repo and PR, set current_epoch
    API->>Board: Upsert root pr_review task by dedupe_key for epoch
    API->>Board: Create review_pass tasks per enabled profile
    API->>Board: Create publish task depending on required review_pass tasks
    API->>Board: Append github.pr_opened and task.created events
    API->>Board: Reducer queues ready review_pass tasks, insert outbox rows
    end
    API-->>GitHub: 200 OK
    Relay->>Board: Drain pending outbox
    Relay->>Trigger: trigger run-review with taskId and idempotencyKey
    Trigger->>Run: Start durable run
    Run->>Board: Validate currency by epoch, set in_progress, open task_run
```

## Review Pass With Brokered Daytona Checkout (MVP)

```mermaid
sequenceDiagram
    autonumber
    participant Trigger as Trigger.dev
    participant Run as run-review
    participant API as Verb API
    participant Board as Postgres Board
    participant Broker as Checkout Broker
    participant Daytona
    participant Reviewer as Reviewer Agent
    Trigger->>Run: Start run-review with taskId
    Run->>Board: Validate currency, load harness version, set in_progress
    Run->>Board: Snapshot policy, open task_run
    Run->>Broker: Request checkout for base and head SHAs
    Broker->>Daytona: Create sandbox
    Broker->>Daytona: Clone base repo with scoped installation token
    Broker->>Daytona: Fetch refs/pull/n/head, checkout head SHA or merge ref
    Broker->>Daytona: Purge clone credentials
    Broker->>Board: Mark review_checkouts ready, set credentials_purged_at
    Daytona-->>Run: Read-only working tree
    Run->>Reviewer: Run read-only review over the checkout
    Reviewer-->>Run: Review outcome
    alt More context needed
        Run->>API: CreateTask context C, LinkTask R context_for C, TransitionTask R blocked
        API->>Board: Validate budget, source policy against pinned snapshot, capabilities
        API->>Board: Create C, add dependency rows (R -> C, root -> C), mark task_run deferred
        API->>Board: Transition R to blocked, queue C, insert outbox
        Run->>Broker: Tear down sandbox
        Broker->>Daytona: Destroy, or mark leaked and schedule cleanup on failure
    else Review completed
        Run->>Board: Store review_run, finding_threads, findings, finding_locations, artifacts
        Run->>Board: Record gate_results for checkout and review completion
        Run->>Broker: Tear down sandbox
        Broker->>Daytona: Destroy, or mark leaked and schedule cleanup on failure
        rect rgb(235,245,255)
        note right of Run: terminal transition + reducer, one tx
        Run->>Board: Transition review_pass to done
        Run->>Board: Reducer queues dependents like publish, insert outbox
        end
    end
```

## Publishing Review Feedback (MVP)

```mermaid
sequenceDiagram
    autonumber
    participant Board as Postgres Board
    participant Relay as Outbox Relay
    participant Trigger as Trigger.dev
    participant Run as run-publish
    participant GitHub
    note over Board: publish task depends_on all required review_pass tasks
    Board->>Board: Last required review_pass done, reducer queues publish, outbox
    Relay->>Trigger: trigger run-publish with taskId
    Trigger->>Run: Start run-publish
    Run->>Board: Validate currency by epoch, load publishable finding_threads and summary
    Run->>Board: Load prior publications by publication_key, dedupe and group findings
    alt PR review comments
        Run->>GitHub: Create PR review with inline comments from finding_locations
    end
    alt Check run
        Run->>GitHub: Create or update check run and annotations
    end
    alt Summary comment
        Run->>GitHub: Create or update PR summary comment
    end
    Run->>Board: Store GitHub object IDs in review_publications keyed on pr and head_sha
    Run->>Board: Mark finding_threads published, transition publish to done
    Board->>Board: Reducer sees root pr_review edges satisfied, mark done
```

## PR Synchronized While Work Is Running (supersession + fencing)

```mermaid
sequenceDiagram
    autonumber
    participant GitHub
    participant API
    participant Board as Postgres Board
    participant Trigger as Trigger.dev
    participant Run as in-flight run
    participant Daytona
    GitHub->>API: pull_request synchronize webhook
    API->>Board: Dedupe delivery
    rect rgb(255,240,240)
    note right of API: one transaction
    API->>Board: Bump current_epoch, update head_sha
    API->>Board: Transition prior-epoch non-terminal tasks to superseded
    API->>Board: Mark stale review_checkouts destroying
    API->>Board: Seed fresh review_pass tasks for new epoch, outbox with debounce delay
    API->>Board: Append review.superseded events
    end
    API-->>GitHub: 200 OK
    API->>Trigger: Cancel in-flight runs for superseded tasks
    API->>Daytona: Destroy stale sandboxes
    alt Cancel races with an active run
        Run->>Board: Currency check finds task.epoch does not equal current_epoch
        Run->>Board: No-op exit, publication_key on pr and head_sha blocks stale writes
    end
```

## Multi-Agent Review With Grounding (Future)

```mermaid
sequenceDiagram
    autonumber
    participant Run as run-review
    participant API as Verb API
    participant Board as Postgres Board
    participant Relay as Outbox Relay
    participant Trigger as Trigger.dev
    participant Ground as run-grounding
    participant Daytona
    Run->>API: CreateTask grounding with can_execute_code, LinkTask verifies finding
    API->>Board: Validate capability and policy, create grounding task, reducer queues outbox
    Relay->>Trigger: trigger run-grounding with taskId
    Trigger->>Ground: Execute grounding run
    Ground->>Daytona: Create isolated sandbox, checkout PR head SHA
    Ground->>Daytona: Install dependencies, run reproduction, egress controlled
    Daytona-->>Ground: Logs, exit codes, artifacts
    Ground->>API: AttachArtifact evidence, CommentTask grounding verified or refuted
    alt Finding verified
        Ground->>Board: Mark finding verified, transition grounding to done
    else Finding refuted
        Ground->>Board: Mark finding refuted, transition grounding to done
    else Grounding blocked
        Ground->>Board: Transition grounding to blocked, creates human_decision
    end
    Board->>Board: Reducer advances dependents like publish or fix
```

## Verified Finding To Fix Task (Future)

```mermaid
sequenceDiagram
    autonumber
    participant Board as Postgres Board
    participant API as Verb API
    participant Relay as Outbox Relay
    participant Trigger as Trigger.dev
    participant Fixer as run-fix
    participant Daytona
    participant GitHub
    Board->>Board: Verified finding and fix policy allows, create fix task with can_push_commits
    Board->>Board: Reducer queues fix, outbox
    Relay->>Trigger: trigger run-fix with taskId
    Trigger->>Fixer: Execute fix run
    Fixer->>Board: Validate currency, repo fix policy, installation perms
    Fixer->>Daytona: Create sandbox, checkout branch, modify code, run checks
    Daytona-->>Fixer: Test results
    Fixer->>GitHub: Push commit or branch with idempotency key on task and head_sha
    Fixer->>API: AttachArtifact patch, CommentTask fix pushed
    Fixer->>Board: Mark finding fixed, transition fix to done
```

## Context Handoff, Same-Task Resume (capability-gated)

```mermaid
sequenceDiagram
    autonumber
    participant R as run-review R
    participant API as Verb API
    participant Board as Postgres Board
    participant Relay as Outbox Relay
    participant Trigger as Trigger.dev
    participant Research as run-research C
    participant Rp as run-review R resume
    R->>API: Needs external/dependency context to proceed
    rect rgb(235,245,255)
    note right of API: one tx, validated verbs
    API->>Board: Validate can_request_context, budget, source allowlist from pinned snapshot
    API->>Board: CreateTask context C with source questions and required_caps
    API->>Board: LinkTask R context_for C, plus root blocks C (required edges)
    API->>Board: AssignTask C to researcher
    API->>Board: TransitionTask R to blocked, append review.context_requested
    API->>Board: Reducer queues C, insert outbox
    end
    Relay->>Trigger: trigger run-research with C
    Trigger->>Research: Execute research run, egress/source allowlist enforced
    Research->>API: AttachArtifact source snapshots
    Research->>API: CommentTask C context.collected with extracted facts and citations
    API->>Board: Store context_items, task_events, artifacts
    Research->>API: TransitionTask C to done
    API->>Board: Reducer sees R deps satisfied, queues same review_pass R
    Relay->>Trigger: trigger run-review with R
    Trigger->>Rp: Execute resumed review attempt
    Rp->>Board: Append review.resumed, rehydrate R thread, linked C, context_items, artifacts
    Rp->>Board: Continue review, write findings, transition R to done
    opt Deliberate branch instead of resume
        Rp->>API: CreateTask review_pass R-prime depends_on C
        API->>Board: Create follow-up task only when review scope should branch
    end
```

## Dashboard Live View (humans are board actors)

```mermaid
sequenceDiagram
    autonumber
    participant UI as Next.js Dashboard
    participant API
    participant Board as Postgres Board
    participant Run as Runs
    UI->>API: GET tasks filtered by repo_id and status
    API->>Board: Query tenant-scoped task_board_items
    API-->>UI: Current board columns
    UI->>API: GET task events with cursor
    API->>Board: Query task_events
    API-->>UI: Timeline events
    Run->>Board: Append task_events during live work
    UI->>API: Poll or subscribe after cursor
    API->>Board: Query new events after global id cursor
    API-->>UI: New events, move cards, update timelines
    note over UI,API: Human actions use the same generic verbs
    UI->>API: TransitionTask human_decision to done, CommentTask, dismiss finding
    API->>Board: Validate verb, apply, reducer advances board and outbox
```
