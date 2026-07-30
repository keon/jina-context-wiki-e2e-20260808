# Context trigger-admission acceptance

Use `scripts/context-trigger-admission-e2e.mjs` to retain the local incremental
trigger matrix before running expensive builds. The harness talks only to an
explicit loopback API. It snapshots public Board `build-context` roots before
and after every action and fails unless the exact expected root delta, normalized
repository/ref, commit, trigger, and monotonic ref sequence are observed.

The harness does not contact or mutate GitHub. It does not post an issue
comment: the comment is a signed JSON fixture submitted to the local
`POST /webhooks/github` endpoint. It does not claim worker work or invoke a
model.

This is a development-test acceptance client even though it exercises the real
signed webhook contract. The client refuses every non-loopback URL, so it cannot
be pointed at staging or production. No new unsigned or production webhook
endpoint is introduced; the existing unsigned `/dev/webhooks/github` fixture is
not used because it cannot express controlled delivery IDs or signed no-op
events.

## Safety and prerequisites

Run against an isolated, disposable API-only local state with the worker
stopped. Trigger admission intentionally creates queued Board roots; a worker
connected to the same state could claim those tasks independently of the
harness.

The matrix deliberately retains six simultaneous roots. Start the stock
development API for this isolated state with
`JINA_DEV_CONTEXT_MAX_ACTIVE_BUILDS=8`; the local-only override is rejected
unless `JINA_ENABLE_DEV_ENDPOINTS=true`, so it cannot weaken a production API.
Without the override, the normal four-active-build tenant quota correctly
rejects the fifth admission and the matrix cannot finish.

Provide:

- the local API's `INTERNAL_API_TOKEN` and `GITHUB_WEBHOOK_SECRET`;
- the repository's current branch and immutable 40-character head SHA;
- a real pull-request number and its current immutable head SHA;
- a genuinely new issue number that has never been admitted to this local Board
  state; and
- optional real repository/installation IDs when the local API uses shared
  tenancy.

The PR head must differ from the current branch SHA. The two revisions let the
harness represent PR opened, synchronize, and a later distinct stale-head
delivery without inventing another SHA. The harness never checks GitHub, so the
operator is responsible for proving the supplied metadata is current before
the run.

## Matrix

| Action                              | Expected new Context roots | Idempotency/ref proof                                 |
| ----------------------------------- | -------------------------: | ----------------------------------------------------- |
| Manual build                        |                          1 | normalized branch; explicit manual request key        |
| Manual request-key replay           |                          0 | original build ID and sequence returned               |
| Signed push                         |                          1 | `refs/heads/<branch>` normalizes to `<branch>`        |
| Same push delivery replay           |                          0 | delivery ID reports `duplicate=true`                  |
| Signed PR opened                    |                          1 | `pull/<number>/head` starts/advances its own frontier |
| Signed PR synchronize               |                          1 | same PR ref, new head, next sequence                  |
| Signed issue opened                 |                          1 | default branch frontier; issue request key            |
| Same issue, distinct delivery       |                          0 | provider request key reports `outcome=duplicate`      |
| Signed issue comment                |                          0 | delivery is accepted but is not a Context trigger     |
| Distinct stale PR-head delivery     |                          1 | admission receives the next PR sequence               |
| Delayed original PR delivery replay |                          0 | original delivery remains idempotent                  |

A distinct stale-head delivery is admitted because webhook admission cannot
prove the provider's current remote head. The later snapshot stage must fence
it against GitHub and reject it when the remote head has moved. The acceptance
gate verifies this boundary explicitly instead of pretending admission alone
can determine temporal truth.

## Run

Choose an explicit retained report path. Its parent directory is created
automatically and the JSON file is forced to mode `0600`.

```bash
pnpm evaluate:context-trigger-admission -- \
  --api-url http://127.0.0.1:3000 \
  --tenant "$JINA_TENANT_ID" \
  --internal-token "$INTERNAL_API_TOKEN" \
  --webhook-secret "$GITHUB_WEBHOOK_SECRET" \
  --repository owner/repository \
  --branch main \
  --current-sha 1111111111111111111111111111111111111111 \
  --pr-number 123 \
  --pr-head-sha 2222222222222222222222222222222222222222 \
  --issue-number 456 \
  --run-id local-incremental-20260729 \
  --report /absolute/path/to/retained/context-trigger-admission.json
```

For shared tenancy, also pass the real `--repository-id` and
`--installation-id`. Run
`pnpm evaluate:context-trigger-admission -- --help` for all environment-variable
alternatives.

The retained report contains only public Board root summaries, expected request
keys, delivery IDs, bounded response metadata, and violations. It never contains
the internal token, webhook secret, HMAC signature, or raw webhook payload. A
contract violation exits nonzero. Partial action evidence is still retained so
the failure can be diagnosed without replaying successful steps blindly.

## Test without an API stack

```bash
pnpm test:context-trigger-admission
```

The fake-server suite verifies the full matrix, HMAC use, relative ref
frontiers, repository/branch normalization, exact deltas, request-key and
delivery idempotency, comment fail-closed behavior, non-loopback refusal, and a
secret-free mode-`0600` failure report. It does not start the current API or
worker.
