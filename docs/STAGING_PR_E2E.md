# Staging pull-request end-to-end acceptance

This runbook proves the externally visible GitHub review flow and every durable
workflow that a pull-request webhook is expected to create. It is staging-only.

## Safety boundary

Never create or update a fixture pull request until repository access has been
checked for both GitHub Apps.

- The fixture repository must be installed on `jina-staging-gcloud-omxyz`.
- The fixture repository must not be installed on `jina-review-bot`.
- The webhook, API, database, workers, artifact buckets, and logs must all belong
  to GCP project `jina-staging-20260802`.
- The dashboard link published by the bot must start with
  `https://app.staging.usejina.com/`.

At the time this runbook was added, the production app had access to every
`omxyz` repository and the private staging app could only be installed on its
owner organization. Consequently, an `omxyz` fixture is not isolated. Provision
a staging-only GitHub organization or change the app ownership/installation
design before using a new PR as an unattended acceptance trigger. Do not weaken,
suspend, or reconfigure the production installation to make a staging test pass.

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
has two consumers in the unified API.

When the fixture repository is selected for the relational review pipeline
(`JINA_REVIEW_BOARD_PIPELINE_MODE=v2`, or an `allowlist` selection), the review
workflow must create exactly one durable Board task:

1. `run-review`

The Board worker dispatches that task to the pinned Trigger.dev root task
`review` and records the returned Trigger run ID in its durable effect receipt.
The Trigger root owns the original `review-summary` and `review-runtime` child
runs, prompt, Daytona session, progress comments, publication, and product
completion calls. Those Trigger children are external execution evidence; they
must not appear as additional Board tasks. While Trigger is nonterminal, the
Board task is `waiting_external`; after Trigger reaches `COMPLETED`, it becomes
`succeeded` only after the worker acknowledges that terminal state to the Board.

The legacy v1 six-stage review graph is historical evidence only. It is not the
acceptance topology for a repository selected for v2.

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
8. Require `current_context_board_releases` to point at the same head SHA and
   require a PageIndex attachment plus at least one published document.
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

## 2026-08-04 legacy-v1 audit record

This record predates the relational v2 cutover and proves the former six-stage
Board topology only. It must not be used as evidence for the one-task v2 graph.

Historical fixture: `omxyz/jina-board-staging-e2e-20260804#1` at
`c99887aa3c852d61f95b7dcd300c8d6a8a8fb9a6`.

- Review run `9e45a37c-6e35-4746-af08-8bf666cb8849` completed and published four
  findings. Board workflow `82cc4a51-131d-5c29-9090-5c8c84d43b96` and all six
  review tasks succeeded on their first attempts; workflow trace ID
  `95172d7c724d7c5ffcbc19ae15c55546` was recorded.
- The same delivery admitted Context build
  `task_a6f2783eb75cdaea3133ad72b90ac419`. Snapshot, planning, and five page
  tasks completed, but publication rejected omission of the existing
  `staging-context-verification.md` page. This audit therefore did not pass at
  that point.
- Commit `c013f3e` fixes the publication policy by retaining the prior certified
  page when an attempted revision remains unsupported after repair. An
  unsupported new page may still be omitted.
- Cloud Build `f781dc93-c9a0-4329-9d36-3ee0a42fb30f` validated the repository
  and published the immutable API and worker tag `staging-c013f3e`. The
  coordinated staging deployment advanced the API, Context worker, review-task
  worker, and causal-graph worker to that tag.
- The failed publication task
  `task_436131c4abfef6ec1ddeb961990f676a` was explicitly retried through the
  staging API. Attempt 2 logged
  `context.page.unsupported_revision_retained_prior`, completed in 15.6 seconds,
  and exported trace `bcb2c4e2030d6dbe64675fd83ddffe63` with span
  `cda90962d1e88bad`.
- Context release `cr_c4b730946367e586379623cea16be0bc` is current for
  `pull/1/head` at the exact tested commit, contains five certified documents,
  and has an attached PageIndex. The unsupported
  `staging-context-verification.md` revision retained the prior certified body
  digest `372ea6ccb6db1872a9a801336e594101b3c415f5590e74787ce2686ea4c1ced0`.
- The signed-in staging dashboard rendered the completed review, four findings,
  exact head SHA, current Context release, all five pages, verified citations,
  and the Task Board. Vercel deployment `mhtNwh67HeaUjota39oZxwEonuE4` corrected
  the summary counter so durable Board `done` stages count as completed; the
  accepted PR now renders `8/8 stages` and `5/5 pages`.
- The dedicated staging endpoint separately admitted causal build
  `task_635bdcc9512fb7b919236f7fc9d8f9bf` for
  `omxyz/jina-context-graph-e2e@54d9f8aabe93870ed7f25a6fee0942da171dbee4`.
  Its aggregate, history snapshot, derivation, and publication tasks all
  completed; release `cir_9150a315f4cc6a0753aba26e12ef7eae` records complete
  26-commit history, one issue, and two causal links. The three worker attempts
  exported trace/span pairs and the dashboard renders `3/3 stages` plus the
  relationship map.

This record is an acceptance recheck of an existing fixture, not authorization
to create another `omxyz` pull request. A fresh staging-only PR admission remains
unsafe until the GitHub App installation topology satisfies the safety boundary
above.
