# Staging pull-request end-to-end acceptance

This runbook proves the externally visible GitHub review flow and every durable
workflow that a pull-request webhook is expected to create. It is staging-only.

## Safety boundary

Never create or update a fixture pull request until repository access has been
checked for both GitHub Apps.

- The fixture repository must be installed on `jina-staging`.
- The fixture repository must not be installed on `jina-review-bot`.
- The webhook, API, database, workers, artifact buckets, and logs must all belong
  to GCP project `jina-staging-20260802`.
- The dashboard link published by the bot must start with
  `https://app.staging.usejina.com/`.

The public staging App must still be installed on an isolated fixture repository
that is not covered by the production App. Do not weaken, suspend, or reconfigure
the production installation to make a staging test pass.

## Staging surfaces

Check the public surfaces before admission:

```sh
curl --fail --silent --show-error https://api.staging.usejina.com/health
curl --fail --silent --show-error https://mcp.staging.usejina.com/health
curl --fail --silent --show-error --location https://app.staging.usejina.com/reviews >/dev/null
```

Run `scripts/check-staging-readiness.sh` before a deployment-backed acceptance
run. It additionally validates the staging project, Cloud SQL, secrets, workers,
domain mappings, Vercel projects, GitHub App variables, and OTel sidecars.

## Expected PR workflow graph

A non-draft `pull_request.opened`, `pull_request.reopened`,
`pull_request.ready_for_review`, or allowed `pull_request.synchronize` delivery
is captured by the product inbox and admitted to the relational Board.

The review workflow creates exactly one durable Board task:

1. `run-review`

The Board worker dispatches that task to the pinned Trigger.dev root task
`review` and records the returned Trigger run ID in its durable effect receipt.
The Trigger root owns the original `review-summary` and `review-runtime` child
runs, prompt, Daytona session, progress comments, publication, and product
completion calls. Those Trigger children are external execution evidence; they
must not appear as additional Board tasks. While Trigger is nonterminal, the
Board task is `waiting_external`; after Trigger reaches `COMPLETED`, it becomes
`succeeded` only after the worker acknowledges that terminal state to the Board.

The Context workflow must create:

1. `build-context`
2. `context-build-graph`
3. `snapshot-context-input`
4. `plan-context-pages`
5. one or more `build-context-page` tasks
6. `publish-context-release`

The causal graph is intentionally not a PR-webhook child. It is admitted
separately through `POST /causal-graph/build` and must create
`build-causal-graph`, `snapshot-causal-graph-history`, `derive-causal-graph`,
and `publish-causal-graph`.

## Acceptance procedure

1. Create a harmless PR in the staging-only fixture. Give the change enough
   executable behavior for the runtime reviewer to exercise; deterministic
   authorization or validation defects are useful acceptance inputs.
2. Confirm the staging GitHub App records one successful delivery and that its
   response is non-error.
3. Confirm the PR receives a staging progress comment, a completed review, and
   inline findings where the fixture is designed to produce them.
4. Open the published dashboard URL and confirm the review details and findings
   render after authentication.
5. Query the staging Board and require a `pr_review` workflow with pipeline
   version `pr_review.board.v2` and exactly one `run-review` task. Require the
   task to be `succeeded`, its `trigger.review.dispatch` effect receipt to be
   `succeeded` with provider `trigger.dev`, and the receipt to contain the
   Trigger root run ID. Require the task and workflow to have a 32-character
   trace ID and every worker attempt to have trace/span IDs.
6. In Trigger.dev, require that same root run ID to identify task `review` and
   reach `COMPLETED`. Require its `review-summary` and `review-runtime` children
   to reach terminal success, and confirm the root used the expected deployment
   environment and preview branch. The product review row's `trigger_run_id`
   must match the Board effect receipt.
7. Query the Context Board for the same delivery and exact head SHA. Require the
   aggregate, graph, snapshot, planner, every page, and publication task to reach
   `done`.
8. Require the highest-sequence attached `context_releases` row to match
   the head SHA and contain a PageIndex attachment plus at least one catalog document.
9. If causal graph is in scope, trigger its dedicated staging endpoint and
   independently verify its four-task graph and immutable current release.

Do not count a review-only success as end-to-end success. Do not count a prior
Context release whose commit differs from the tested PR head. A failed optional
new Wiki page may be explicitly omitted; a failed revision of an existing
page must retain the last certified page rather than delete it.

## Evidence to record

Add one dated record for each release acceptance containing:

- source commit and immutable image tag;
- fixture repository, PR number, delivery ID, and exact head SHA;
- product review run ID, Board workflow/task IDs, workflow trace ID, Trigger
  root run ID, and Trigger summary/runtime child run IDs;
- Context build ID, release ID, document count, and PageIndex attachment time;
- causal build/release IDs when separately exercised;
- links to the PR and staging dashboard; and
- any retries, failure categories, and the corrective commit.

Keep identifiers and timestamps. Never paste bearer tokens, webhook secrets,
private keys, database passwords, or full private payloads into the repository.
