# Context chaos acceptance

Status: compatibility harness. Its manifest still includes proofs for the retired
multi-topic Context graph. It is useful while that reducer code remains in the tree, but
it is not sufficient acceptance for the active page-oriented queue contract. Use the
page-oriented workflow tests, production preflight, and surface acceptance in addition.

`scripts/context-chaos-acceptance.mjs` is the retained, fail-closed report
generator for the Context failure matrix. It does not replace focused tests or
claim that a fake service is production. It gives every documented failure case
one stable ID, reuses the existing named proofs, and runs bounded isolated and
disposable-database scenarios where that adds process evidence.

The runner never contacts or mutates GCP, Daytona, GitHub, Cloud SQL, or a
production service. Run it only from a candidate checkout with compiled
packages. `TEST_DATABASE_URL`, when provided, must identify a disposable
PostgreSQL database because the integration suite recreates Context schemas.

## Run

```sh
TEST_DATABASE_URL=postgresql://... \
pnpm evaluate:context-chaos -- \
  --report /absolute/path/to/retained/context-chaos.json
```

The report is written with mode `0600`. It includes the candidate Git SHA and
dirty-state digest, commands and output digests for reused proof groups,
isolated-scenario evidence, one result for each of the twenty failure cases, and
an explicit remaining gap for every unsupported case. It never stores command
output, credentials, artifact bodies, model prompts, or worker fences.

Exit status is:

- `0` only when every case is proven;
- `1` when a proof or scenario fails; and
- `2` when no proof failed but at least one case remains unsupported.

A missing `TEST_DATABASE_URL` is not treated as a PostgreSQL pass. The
PostgreSQL proof group becomes unsupported, and the overall command exits `2`.
When the variable is present, any skipped PostgreSQL test fails that proof
group.

Inspect the manifest without running proofs or scenarios:

```sh
pnpm evaluate:context-chaos -- \
  --proof-mode manifest-only \
  --report /absolute/path/to/retained/context-chaos-manifest.json
```

Manifest-only mode is inventory, not acceptance, and therefore exits `2`.

Run the harness tests:

```sh
pnpm test:context-chaos
```

## Reused deterministic proof

The manifest runs existing compiled Board, API, worker, Context engine, Daytona
contract, quality, GCS-adapter, and PostgreSQL integration tests. Some entries below
exercise compatibility code rather than claimable production topics. Together those
tests prove:

- exact completion replay and one-time model accounting;
- lease/fence rejection and bounded retry;
- stale ref-sequence rejection;
- repair exhaustion and descendant cancellation;
- material source-challenge expansion;
- critic gap-schema rejection;
- certification and citation-digest binding;
- prepared-release invisibility and atomic PageIndex attachment;
- malformed, incomplete, timed-out, or version-mismatched PageIndex failure;
- immutable artifact collision rejection;
- immediate token revocation and cross-tenant denial; and
- the in-memory canonical-frontier erasure check;
- durable worker restart, quota, artifact, and graph-expansion recovery; and
- prepared-publication erasure fencing.

The report retains only the proof command, exit code, duration, skip count, and
stdout/stderr SHA-256 values. The authoritative detail remains the named test
source and CI log.

## Isolated scenarios

Five bounded scenarios use the real compiled Board or artifact adapter with
child worker processes and local fake services:

1. hard-kill a worker after claim but before any artifact, advance the
   deterministic lease clock, reclaim the delivery, and reject the old fence;
2. hard-kill after a create-only filesystem artifact, reclaim the delivery,
   reuse identical bytes, reject changed bytes, and reject the old fence;
3. race two worker processes for one delivery and require exactly one claim;
4. fail GCS-adapter write and read operations with service-unavailable errors,
   restore the fake service, and verify exact recovery; and
5. hard-kill one fake timed-out page worker while a sibling completes, then
   retry only the timed-out task with a fresh attempt.

These scenarios are stronger than pure reducer assertions but deliberately
remain labeled `isolated_process` or `fake_service`. They are not evidence that
Cloud Run, Cloud SQL, real GCS, or Daytona survived the same fault.

## Disposable durable-stack scenarios

The five former live-boundary gaps are now covered without touching production:

- a claimed model task survives an API/worker interruption in PostgreSQL, is
  reclaimed after lease expiry, rejects the stale fence, and clears its durable
  model quota when released;
- an API-created object written through the production GCS adapter survives an
  API restart alongside PostgreSQL state and quota accounting, replays exact
  bytes, rejects changed bytes, and rejects the stale fence;
- an injected response loss immediately after the authoritative
  `jina_runtime.api_state` graph-expansion commit is followed by an API restart
  and exact completion replay, with one expanded task, one outbox message, one
  worker receipt, and one artifact charge;
- a deliberately delayed HTTP retrieval revokes its exact issued bearer before
  completion and the result is denied with `401`; and
- PostgreSQL evidence erasure between Board publication prepare and PageIndex
  attachment invalidates the prepared generation and prevents public-pointer
  advancement.

The PostgreSQL suites recreate both Context schemas and use an in-memory
GCS-compatible service behind the production adapter. They therefore require a
disposable `TEST_DATABASE_URL`. They do not claim Cloud Run, Cloud SQL, real
GCS, or Daytona fault injection, and the runner never changes production IAM.

## Promotion rule

Do not remove an `unsupported` declaration merely because a unit test exists.
A case may be promoted only when its new scenario:

1. runs against the boundary named in the remaining gap;
2. asserts the expected task, lease, quota, artifact, and release state;
3. proves no partial or stale release became public;
4. has deterministic cleanup;
5. is covered by a failing negative fixture; and
6. is represented in the retained `context-chaos-acceptance-v1` report.

The production rollout may cite this report only alongside the ordinary
quality, retrieval, surface, security/load, Daytona, reset, deployment, and
canary reports. Chaos acceptance does not replace any of them.
