# Production Context trigger acceptance

`scripts/context-production-trigger-e2e.mjs` is the post-deployment acceptance for
real GitHub-triggered Context work. It complements two existing gates:

- `jina-acceptance` proves one complete manual initialization against candidate
  services before traffic cutover.
- `context-trigger-admission-e2e.mjs` proves the signed admission matrix and
  collision rules against an isolated local API using synthetic deliveries.

Neither existing gate changes a real provider record, observes GitHub App delivery,
or proves that completed provider-only and source-changing builds advance production
releases. The production trigger harness closes that gap against the controlled
`omxyz/jina-context-graph-e2e` fixture. It is intentionally a separate post-deploy
operator gate: candidate URLs are not the GitHub App webhook target, and the deploy
service account does not receive a repository write credential. A dedicated
`jina-context-production-trigger-acceptance` Cloud Run job is installed only after a
successful cutover and verified control-artifact cleanup. Deployment does not execute it.
The job is an auxiliary operator tool rather than part of release acceptance. If its
post-cutover reconciliation fails, the coordinated release remains successful and the
job can be repaired independently without repeating migration or traffic cutover.

## Contract

One run uses a unique `run-id` and performs this sequence:

1. Preflight the exact repository ID, default branch, installation, production API,
   and exclusive fixture state. An existing `e2e/context-trigger-acceptance-*`
   branch or open acceptance issue blocks the run.
2. Create a unique branch at the immutable default-branch head. The branch-creation
   event must create no Context build.
3. Request a manual Context build on that fresh ref, wait for publication and
   PageIndex completion, and verify the resulting available release. Replay the
   same request key and require the exact original build ID with no second root.
   Because the unique ref had no release, this is the full-initialization proof.
4. Open a uniquely marked issue. Require one issue-triggered build on the default
   branch, the exact installation and next ref sequence, and a newly published
   release at the unchanged default-branch SHA. Redeliver the exact GitHub App
   webhook and require zero additional roots.
5. Add a uniquely marked issue comment. Audit the exact `issue_comment.created`
   delivery through the GitHub App delivery API, require a successful production
   webhook response, and require zero new Context roots during the quiet window.
6. Add one marker file on the unique branch. Require one push-triggered build at
   the exact commit, the next branch ref sequence, a release distinct from the
   initialization release, and a successful webhook redelivery with zero new roots.
7. Open an unmerged PR from the unique branch. Require one PR-triggered build at
   `pull/<number>/head`, the exact head SHA, a completed release, and a successful
   webhook redelivery with zero new roots.
8. Update the existing marker on the still-open PR head. From that one new commit,
   require both the next branch push frontier and the next
   `pull_request.synchronize` preview frontier at the exact new SHA. Require distinct
   completed incremental releases relative to the prior branch and PR releases.
   Redeliver each exact webhook and require zero additional roots.
9. Close the PR, delete the comment, close the issue, and delete only the exact
   unique branch. Every cleanup is attempted even after an acceptance failure.

The harness never writes or force-pushes the default branch and never merges. Closing
events and the deleted-branch push are intentionally non-triggers. Published Context
releases and Board history remain immutable audit evidence; GitHub resources are the
only temporary objects removed.

## GitHub prerequisites

The operational Context App must be installed on the controlled repository and
subscribe to:

- Push
- Pull request
- Issues
- Issue comments

The last subscription matters. Without it, “a comment created no build” would prove
only that GitHub sent nothing. The harness uses an App JWT to find the exact comment
delivery and its production HTTP result.

By default, the harness uses the fixture-mutation App JWT to request a short-lived
installation token from
`POST /app/installations/{fixture_installation_id}/access_tokens`. Every mint is
explicitly limited to the single `omxyz/jina-context-graph-e2e` repository and requests
only:

- Contents: read and write, for the unique branch and marker commit
- Issues: read and write, for the temporary issue and comment
- Pull requests: read and write, for the temporary unmerged PR
- Metadata: read

The harness validates the repository list and exact returned permission map before
making any repository request. It fails closed if the App installation cannot grant
them. Because installation tokens expire after one hour, the harness remints with
the same restrictions when less than five minutes remain. Tokens are held only in
process memory and are never included in the retained report or logs.

A separate fixture-mutation App needs those write permissions. It must have webhooks
disabled and be installed only on the controlled fixture, never on ordinary Context
repositories. The current fixture identity is App ID `4434994`, installation
`150069172`. `GITHUB_FIXTURE_APP_ID` and `GITHUB_FIXTURE_APP_PRIVATE_KEY` mint only
the repository-scoped mutation token.

The operational App remains read-only. Its `GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY`, and installation `140435029` are used for webhook delivery
inventory, bounded redelivery, and Context build metadata. The harness rejects equal
operational/fixture App IDs or installation IDs before making a request. Snapshot
workers receive only the operational App credentials and independently downscope their
tokens to the exact build repository and read-only `contents`, `issues`,
`pull_requests`, and `metadata`.

For isolated local tests only, `--use-github-token-override` allows a fixture-only
`GITHUB_TOKEN` in place of the mint. The variable is ignored unless that flag is
present. Do not use the override for the production acceptance.

## Run

Do not run concurrently and do not run until the coordinated production deployment
has completed. Secrets are environment-only so they do not appear in the process
argument list.

```bash
export INTERNAL_API_TOKEN='<production internal token>'
export GITHUB_APP_ID='<operational App id>'
export GITHUB_APP_PRIVATE_KEY='<operational App PEM private key>'
export GITHUB_FIXTURE_APP_ID='<fixture-mutation App id>'
export GITHUB_FIXTURE_APP_PRIVATE_KEY='<fixture-mutation App PEM private key>'

pnpm evaluate:context-production-triggers -- \
  --api-url https://<stable-production-api-host> \
  --tenant omlabs \
  --principal tenant:omlabs \
  --repository omxyz/jina-context-graph-e2e \
  --installation-id '140435029' \
  --fixture-installation-id '150069172' \
  --confirm-repository omxyz/jina-context-graph-e2e \
  --run-id "prod-$(date -u +%Y%m%d-%H%M%S)" \
  --report /absolute/path/to/context-production-trigger-acceptance.json
```

The coordinated deploy configures the same command as a dedicated, post-cutover job.
It is intentionally not run by Cloud Build. An authorized operator starts it only when
production-trigger evidence is required:

```bash
gcloud run jobs execute jina-context-production-trigger-acceptance \
  --project=jina-v2 \
  --region=us-east1 \
  --wait
```

The job writes a mode-`0600` report under its ephemeral `/tmp` and emits the identical
JSON to stdout. Retain the Cloud Run execution identity and Cloud Logging output as the
durable production record.

The default per-build timeout is four hours. Initialization, issue, first push, and
PR-open builds are completed sequentially to avoid superseding the frontier being
tested. The final marker update admits the branch-push and PR-synchronize builds
together because they have independent refs. The deployed job allows up to 24 hours;
it is intentionally a long operator-run acceptance, not a release gate. The report is
written with mode `0600` and contains only public build/release identities, GitHub
object numbers, delivery metadata, cleanup results, and violations. It never contains
the internal token, installation token, optional GitHub token, App private key, JWT,
webhook signature, or provider payload body.

A failed cleanup leaves the report in `failed` state and identifies the exact resource.
Remove only resources whose marker and number match that report. Never delete an
unrelated branch, issue, PR, or comment.

## Local contract test

```bash
pnpm test:context-production-triggers
```

The fake production/GitHub suite exercises full initialization, manual replay,
provider-only issue advancement, real-delivery comment no-op behavior, incremental
commit and PR-open frontiers, the combined branch-push and PR-synchronize frontier,
GitHub App redelivery idempotency, allowlist confirmation, and cleanup after both
success and failure. It performs no network or cloud mutation.
