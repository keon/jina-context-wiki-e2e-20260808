# Context v2 continuation runbook

Status: production-path implementation is complete and locally validated, but
retained and deployed acceptance are not complete. Terminal-root reconciliation,
incremental prior-release accounting, atomic PageIndex/public visibility,
operator retry, the three-hour runtime envelope, Daytona preflight, and
deployment bootstrap checks are implemented. A clean Jina Board run is still
in progress and is not success evidence. This is the authoritative handoff for
remaining acceptance and rollout work as of 2026-07-30.

The objective is not merely to make the code compile. The finished system must
generate citation-grounded repository engineering documentation whose
maintenance usefulness is objectively comparable to DeepWiki and Code Wiki,
then prove that claim end to end on Jina and representative repositories.

Read these documents before changing behavior:

1. [`CONTEXT_V2_IMPLEMENTATION_PLAN.md`](CONTEXT_V2_IMPLEMENTATION_PLAN.md) for
   product and architecture decisions.
2. [`CONTEXT_QUALITY_BENCHMARK.md`](CONTEXT_QUALITY_BENCHMARK.md) for the
   non-negotiable quality gates.
3. [`REPRESENTATIVE_REPOSITORY_E2E.md`](REPRESENTATIVE_REPOSITORY_E2E.md) for
   retained-run and repository-fixture mechanics.
4. This file for current implementation truth and remaining work.

Keep two claims separate throughout this document:

1. **implementation complete** means the Board-native source path exists and its
   focused tests pass; and
2. **acceptance proven** means a retained real-repository or deployed run produced
   the required artifacts and machine-readable report.

Implementation evidence is not a substitute for retained acceptance evidence.

## Non-negotiable product decisions

- The public product name is **Context**, not wiki.
- Public output is repository-specific engineering documentation in Markdown.
- Only derived, citation-valid context is queryable. Raw source and provider
  evidence are build inputs, not retrieval results.
- The task board is the only production scheduler and checkpoint authority.
- GCS holds immutable large artifacts. Board state holds only bounded control
  metadata, digests, leases, dependencies, attempts, and artifact references.
- A fresh sandbox/Codex invocation executes one bounded agent board task. The
  local runner disables nested multi-agent orchestration because production
  fan-out and durability belong to the board.
- Full publication is atomic. Valid pages from an incomplete build are resumable
  checkpoints, not a queryable release.
- Direct human editing of generated files is not supported. Owners inspect,
  invalidate, rebuild, diff, or erase.
- Build triggers are new branch commits, new PRs or PR head updates, and newly
  opened issues. Issue comments do not trigger builds.
- The default branch is canonical. Branch pushes retain their branch ref, PRs
  use `pull/<number>/head`, and issues build the default branch.
- Production uses GCS. The filesystem artifact store is a local adapter with the
  same object-key contract.
- No rebuildable Context data requires backward compatibility. Preserve tenant,
  installation, repository, ACL, token, erasure, and audit identity; reset old
  evidence, derivation, release, projection, checkpoint, and retrieval data.
- PageIndex is self-hosted from the open-source repository pinned to
  `982514ab40fe42a169ea087c13819cf87c87724f`. Do not send private context to
  PageIndex Cloud.
- `search_context` uses deterministic bounded lexical scoring over the published
  PageIndex tree. It returns selected context and citations, never a generated
  answer. `list_context`, `read_context`, and `diff_context` are deterministic.
- MCP exposes exactly `search_context`, `list_context`, `read_context`, and
  `diff_context`.
- API and MCP credentials are tenant/principal scoped and repository ACLs are
  rechecked on every request.
- Local model defaults are current Codex session authentication,
  `gpt-5.6-terra`, low reasoning effort.

## Worktree and current evidence

At the time of this handoff:

```text
workspace: /Users/keon/.codex/worktrees/6b3f/jina
branch:    codex/context-v2-agentic-pageindex
base HEAD: 476c3b09e1b102d1e1c5ec3480a4d753d92ebf2e
```

The worktree is intentionally very dirty and contains the full Context reset.
Do not reset, discard, or overwrite unrelated changes. Inspect `git status
--short` before every broad edit. Accidental generated `.js`, `.d.ts`, and
`.DS_Store` files found during implementation were removed; repeat the
classification before review rather than assuming the worktree is clean.

Focused validation rerun on 2026-07-30:

| Scope                       | Evidence                                  | Status                                    |
| --------------------------- | ----------------------------------------- | ----------------------------------------- |
| Context engine              | `pnpm --filter @jina/context-engine test` | 129 passing                               |
| API                         | `pnpm --filter @jina/api test`            | 78 passing                                |
| Daytona/local stage package | `pnpm --filter @jina/daytona test`        | 54 passing                                |
| Worker                      | `pnpm --filter @jina/worker test`         | 42 passing                                |
| Board                       | `pnpm --filter @jina/board test`          | 8 passing                                 |
| Workspace and harness tests | `pnpm test`                               | 24/24 package tasks and 70 root harnesses |
| PostgreSQL package          | `pnpm --filter @jina/db test`             | 18 passing, 4 environment-gated skipped   |
| Type checking               | `pnpm typecheck`                          | 17/17 package tasks                       |
| ESLint and formatting       | `pnpm lint`                               | 17/17 package tasks; knip/Prettier green  |
| Build                       | `pnpm build`                              | 17/17 package tasks                       |
| Formatting                  | `pnpm format:check`                       | green                                     |

The four database skips require an explicit disposable `TEST_DATABASE_URL`; they
were not rerun during this documentation audit and are not represented as current
evidence. The full workspace checks above completed at the rebased SHA with the
working-tree implementation. Re-run formatting after any later documentation
edit.

These suites are necessary but do not prove board-native E2E publication,
PageIndex, incremental behavior, production isolation, or DeepWiki/Code Wiki
parity.

## Current board-native implementation

The canonical board contract is
[`packages/context-engine/src/workflow/board.ts`](../packages/context-engine/src/workflow/board.ts).
It currently defines:

```text
build-context
├─ context-build-graph
├─ snapshot-context-input
├─ plan-context-research
├─ research-context-subject × dynamic N
├─ plan-context-publication
├─ context-page × dynamic N
│  ├─ write-context-page
│  ├─ audit-context-page
│  └─ repair-context-page + audit-context-page × bounded passes
├─ challenge-context-sources
├─ evaluate-context-tasks
├─ repair-context-gaps × bounded passes
├─ certify-context-release
├─ publish-context-release
└─ index-context-release
```

Implemented and focused-test-covered:

- deterministic build/snapshot root creation and idempotent request keys;
- monotonic per-tenant/repository/ref board sequence derivation;
- dynamic research and publication fan-out from validated artifact-backed
  results;
- one aggregate per planned page;
- page write, independent source-aware citation audit, and bounded page repair;
- parallel source challenge and context-only task evaluation;
- global repair graph creation followed by fresh challenge/evaluation tasks;
- certification dependencies extended to the newest repair pass;
- root-blocking edges for all dynamically created work;
- scoped result-envelope validation;
- lease/fence-scoped immutable artifact upload and reads;
- recursive dependency result references on worker claims;
- latest-pass metadata included with dependency results;
- fenced, idempotent PostgreSQL publication and PageIndex attachment;
- direct natural GitHub URLs for captured commit records;
- exact successful model-token aggregation and tenant quota accounting;
- strict development authentication independent from the unsigned webhook
  fixture;
- bounded transient task retry with fresh attempts/fences and preserved sibling
  checkpoints;
- generic terminal-aggregate reconciliation that cancels unfinished descendants,
  retires pending or leased outbox deliveries, and releases reconciled model
  reservations;
- atomic single/batch operator retry with dry-run eligibility, stable replay
  receipts, stale-sequence protection, and preserved completed siblings;
- terminal page-audit and global-gate exhaustion ordering that records the
  completing worker and receipt before failing the parent/build;
- admission-bound prior-release seeds, exact prior-release artifact reads,
  retain/revise/add/retire plan validation, stable logical IDs, and
  publication-time incremental enforcement;
- prepared immutable publication followed by atomic PageIndex attachment and
  public-current pointer advancement, so an unindexed prepared release is not
  query-visible; and
- a real board snapshot worker integration test using a local bare Git remote
  and mock GitHub/API services.

The API graph-expansion adapter is
[`apps/api/src/context-board-runtime.ts`](../apps/api/src/context-board-runtime.ts).
It expands snapshot, research-plan, publication-plan, unsupported page-audit,
and repair-required global gate results before ordinary task completion. A
typed deferred finalizer handles bounded terminal exhaustion only after the
current task is durably `done`, within the same API state mutation. This keeps
the completion receipt replayable while generic Board reconciliation cancels
only the remaining work.

The portable Board stage runner is
[`packages/daytona/src/board-agent-stage-runner.ts`](../packages/daytona/src/board-agent-stage-runner.ts),
with the worker adapter in
[`apps/worker/src/board-agent-stage-adapter.ts`](../apps/worker/src/board-agent-stage-adapter.ts).
Local and Daytona execution consume the same bounded repository archive,
declared inputs, output-file manifest, attempt identity, cancellation signal,
and result envelope. Production explicitly requires Daytona and refuses to
infer local execution.

The worker implementation is in
[`apps/worker/src/server.ts`](../apps/worker/src/server.ts). It compiles and has
implementations for snapshot, research planning, research, publication
planning, page write, page audit, page repair, source challenge, context-only
task evaluation, global gap repair, and deterministic certification.

### Important remaining production evidence

- `run-context-publication` now prepares authoritative immutable PostgreSQL
  release rows without changing the public pointer. `run-context-pageindex`
  builds the pinned local tree and atomically attaches it while advancing the
  public pointer under the live Board lease. Their focused adapter tests pass;
  the environment-gated PostgreSQL paths must be rerun with a disposable
  `TEST_DATABASE_URL`, and a retained real-repository Board run still has to
  prove both tasks together.
- A new Board build is seeded with the exact current release for its
  tenant/repository/ref. Agent packets receive that bounded release and the host
  rejects silent drops, incorrect retains, unstable logical identities, or
  undeclared retirement. The new-commit, PR, and issue retained matrix still
  has to prove useful incremental behavior rather than merely contract validity.
- Global repair has a fake-Codex integration, complete citation-audit binding,
  bounded pass exhaustion, and newest-gate certification. The retained Jina
  cold/resume/incremental scenarios remain the authoritative quality proof.
- The portable Daytona runner is implemented and production is configured
  fail-closed for it. The production preflight resolves exactly one immutable
  Daytona snapshot or digest-pinned image, verifies the organization model
  Secret by executing Codex inside that sandbox, and fails before Cloud SQL or
  serving mutation. A retained Daytona run is still required.
- The production worker image now embeds and probes the pinned PageIndex
  runtime. The coordinated deploy validates externally bootstrapped bucket,
  service-account, IAM, Cloud SQL, secret, image, and Daytona contracts before
  mutation and gives `jina-acceptance` a three-hour derivation/poll window. A
  coordinated image build and live `jina-acceptance` execution remain required.
- Terminal failed-root reconciliation and retry eligibility are implemented and
  focused-test-covered. The clean retained Jina run must still demonstrate no
  orphaned lease or quota reservation under real process interruption and
  repair exhaustion.
- Commit-only history now resolves to natural GitHub commit URLs and is bound to
  the captured commit bytes by the Board citation audit. Retained real-output
  inspection still has to prove agents use those links appropriately.

## Retained Jina acceptance status

The last completed observation is a failed Board-native cold-build attempt. It
is valuable checkpoint and failure evidence, but it is not current success
evidence:

```text
repository:
omxyz/jina

ref:
main

commit:
23841553ebff18c272b7006ced98e733d88c375c

build:
task_c356587edb51ef19de1def54b0fa30ff

artifact root:
/tmp/jina-dev/artifacts/context-v2/tenants/11111111-1111-4111-8111-111111111111/repositories/omxyz/jina/builds/task_c356587edb51ef19de1def54b0fa30ff
```

Historical recovery checkpoint observed at 2026-07-30T05:02:47Z:

```text
build status at observation: active
earlier publication failure: recovered
snapshot:                    done
research plan:               done
subject research:            done
publication plan:            done
page write/audit/repair:     progressing with valid private checkpoints
certification at observation: pending
published release at observation: none
PageIndex at observation:    none
```

The earlier publication-plan failure was recovered through the atomic operator batch
retry. The retained snapshot, research plan, subject research, publication plan, and
completed page work were reused; no task was failed at the observation timestamp.
Attempt-six page-repair artifacts and citation audits prove that recovery continued from
those checkpoints. This is resume evidence, but it was not completion evidence:
certification, atomic publication, PageIndex attachment, retrieval, and surface
acceptance had not yet occurred at that timestamp.

Terminal observation at 2026-07-30T05:34:17Z:

```text
build status:                 failed
completed Board tasks:        180
failed Board tasks:           16 (8 page aggregates and 8 failed audit/repair leaves)
canceled Board tasks:         12
in-progress Board tasks:      1 stale repair lease
triage Board tasks:           2
private page checkpoints:     15
valid checkpoints:            6
invalid checkpoints:          8
pending checkpoints:          1
published release:            none
PageIndex attachment:         none
```

The immediate failure in that historical run was external model execution: the desktop-compatible
Codex CLI reached the current session's usage limit and reported a reset at
August 5, 2026 03:24. The earlier CLI/model-cache incompatibility has already
been fixed by using the app-bundled CLI with a stack-owned runtime home that
links only the current session authentication. Do not switch models or
credentials to bypass the requested `gpt-5.6-terra`, low-effort, current-session
contract.

All completed research, plans, audits, and page checkpoints remain immutable.
That snapshot predates the implemented generic terminal-root reconciliation,
reconciled quota settlement, batch retry eligibility, and completion-ordering
fixes. It therefore must not be used to describe the behavior of the rebased
source.

A clean Board-native Jina run against the rebased implementation is currently
running. At this documentation checkpoint it has not produced a terminal Board
state, certified release, PageIndex attachment, quality report, or retrieval
report. Record its exact build ID, commit, artifact root, timings, and retained
reports only after observing them from the live stack. Do not infer success
from process health, queued work, private checkpoints, or focused tests.

Inspect the historical failed Board run only when comparing reconciliation or
checkpoint behavior:

```sh
source /tmp/jina-dev.env
scripts/context-build.sh --watch task_c356587edb51ef19de1def54b0fa30ff
```

The earlier filesystem run under
`/var/folders/1c/qzwxqbl54px62pvhdbflm8s40000gn/T/jina-local-derive-g0evs1`
is historical filesystem-harness evidence only. It is not current and must not
be used as proof of Board publication, resume, PageIndex, retrieval, or
production readiness.

## Remaining execution order

The Board cutover and known production-path correctness changes are
implemented. The sequence below now governs acceptance: finish and retain the
clean local Jina run, execute the local incremental/interruption and
representative-repository matrices, prove the identical envelope on Daytona,
perform the reviewed data reset and platform preflight, and only then deploy a
candidate and run production acceptance. Source or focused-test evidence does
not replace retained execution evidence.

### Implemented blockers closed since the failed Jina attempt

1. **Terminal-root reconciliation:** generic Board reduction now cancels
   unfinished descendants and retires pending/leased outbox messages for a
   failed aggregate. The API settles reservations for reconciled model leases,
   and eligibility/retry normalizes older retained snapshots.
2. **Atomic terminal completion:** a terminal automatic-pass unsupported page audit or
   repair-required global gate is recorded `done`, with its durable completion
   receipt, before the terminal policy fails the page/build. Remaining work is
   canceled without rewriting the completing task.
3. **Cross-build incremental Context:** admission binds the exact current
   release for the same tenant/repository/ref; workers may read only that
   immutable seed; planning and publication enforce explicit
   retain/revise/add/retire accounting and stable page identity.
4. **Publication/PageIndex visibility:** publication prepares immutable release
   state without changing the public pointer. PageIndex attachment materializes
   the hierarchy and advances the public current pointer in one fenced
   transaction.
5. **Retry operations:** tenant-admin single and batch retry, stable replay,
   retry eligibility, watcher-driven recovery, stale-sequence checks, and
   completed-sibling preservation are implemented and focused-test-covered.
   Public dashboard proxies remain read-only by design; they do not expose
   generated-file mutation.
6. **Runtime budgets:** API admission, the local watcher, Cloud Build, and
   `jina-acceptance` support a 10,800-second derivation/poll window, with a
   11,700-second job envelope. The final measured cold and incremental
   durations remain acceptance evidence, not an implementation gap.
7. **Daytona and deployment bootstrap:** production is Daytona-only and
   preflights the immutable sandbox, organization model Secret, Codex
   execution, externally bootstrapped GCP resources, database, bucket, IAM,
   secrets, and images before cloud mutation or traffic cutover.

### Remaining evidence and rollout work

1. Complete the clean Jina cold run and retain certification, atomic
   release/PageIndex publication, quality, retrieval, four-tool API/MCP, and
   dashboard/admin evidence.
2. Prove interruption/resume plus new commit, PR open/synchronize, new issue,
   issue-comment no-op, replay, and stale-head behavior. Inspect that
   incremental outputs make useful, grounded retain/revise/add/retire choices.
3. Run the representative-repository and objective DeepWiki/Code Wiki
   comparison matrices with retained reports.
4. Run the same cold, resume, and incremental fixture through Daytona.
5. Review and execute the rebuildable-data reset in the intended environment,
   complete external platform bootstrap, deploy one immutable candidate, run
   production acceptance, and canary before broad traffic.

### Work package 1: finish the board-controlled repair and certification loop

Primary files:

- `packages/context-engine/src/workflow/board.ts`
- `packages/context-engine/src/workflow/board.test.ts`
- `apps/api/src/context-board-runtime.ts`
- `apps/api/src/context-board-runtime.test.ts`
- `apps/api/src/server.ts`
- `apps/worker/src/server.ts`
- `packages/daytona/src/local-agent-stages.ts`
- `packages/daytona/src/board-page-audit.ts`
- `packages/context-engine/src/ports/artifact-store.ts`

Implemented contract (retained end-to-end proof still required):

1. Repair-required source challenges and task evaluations have fake-Codex,
   immutable-artifact coverage.
2. The graph creates exactly one bounded repair pass and certification depends on
   the newest successor gates.
3. Page repairs, global drafts, challenge/evaluation results, and certification
   inputs are pass ordered.
4. Global repair preserves a bounded page set and changed pages receive independent
   citation audits.
5. Material challenge findings become durable repair inputs before the next critic.
6. Any non-pass critic outcome is blocking, regardless of advisory model labeling.
7. Certification binds the exact final page bytes, citation audit, task catalog,
   repository/ref/commit, and publication catalog.
8. Navigation validation requires every relative context link to resolve and every
   page to be reachable from `architecture.md`.
9. Exhausted repair limits preserve artifacts and terminate without publication.
10. Lease, replay, duplicate completion, and graph-expansion boundaries have focused
    coverage.

Acceptance evidence:

- focused tests cover every transition and replay;
- no completion path throws merely because remediation work is required;
- certification cannot claim an older pass;
- changed global pages have complete independent citation support;
- no internal workflow file appears in public output; and
- a retained board graph shows the entire repair/rechallenge loop.

### Work package 2: prove fenced board-native publication

Current implementation:

- `packages/context-engine/src/index/coordinator.ts`
- `packages/context-engine/src/derive/markdown-catalog.ts`
- `packages/context-engine/src/derive/markdown-document.ts`
- `packages/context-engine/src/derive/validator.ts`
- `apps/api/src/server.ts` fenced internal publication and PageIndex attachment
  operations
- `packages/db/src/context/*`

Recommended ownership:

- the board worker assembles and verifies artifact inputs under its lease;
- the API performs the authoritative PostgreSQL/store transaction through an
  internal lease/fence-scoped endpoint;
- GCS holds the immutable certified release bundle;
- the board result holds only the release ID and release artifact reference.

Implemented contract (retained end-to-end proof still required):

1. `run-context-publication` is a worker-supported Board topic.
2. Read the newest certification and exact certified page/draft artifacts from
   the dependency closure.
3. Recompute the ordered public snapshot digest and require exact equality with
   certification.
4. Rebuild and validate every Markdown document and evidence link against the
   immutable snapshot. Never trust only the earlier worker verdict.
5. The fenced internal API publication operation verifies task, attempt, lease ID,
   write fence, tenant, repository, build, ref, commit, and ref sequence.
6. In one authoritative transaction:
   - create immutable derived revisions/citations;
   - create the complete prepared release/projection;
   - bind the release to the certified page manifest and digests;
   - reject a stale ref sequence; and
   - leave the prior public current pointer unchanged until PageIndex is ready.
7. Upload a `context-release` artifact with the public page manifest, release
   identity, certification reference, source checkpoint identity, and digests.
8. Make retries idempotent. The same certified input must return the same
   release. A different digest under the same idempotency key must fail.
9. Prove that upload-before-transaction, transaction-before-response, duplicate
   completion, stale sequence, and concurrent newer build races cannot expose a
   partial or older release.
10. Ensure progress endpoints may show valid checkpoints while all four public
    retrieval tools still resolve only the published release.

Acceptance evidence:

- a real board build produces exactly one complete immutable release;
- a failed publication resumes without rerunning verified research/pages;
- an older delayed build cannot become current; and
- no partial page subset is queryable.

### Work package 3: prove board-native self-hosted PageIndex

Primary files:

- `services/pageindex-worker/worker.py`
- `services/pageindex-worker/README.md`
- `packages/context-engine/src/index/pageindex-local-client.ts`
- `packages/context-engine/src/index/hierarchy.ts`
- `packages/context-engine/src/context/codex-tree-selector.ts`
- `apps/worker/src/server.ts`
- `apps/api/src/server.ts`

Implemented contract (retained end-to-end proof still required):

1. `run-context-pageindex` is a worker-supported Board topic.
2. Read only the prepared certified release artifact emitted by the completed
   publication task.
3. Invoke the pinned local/self-hosted PageIndex worker, never PageIndex Cloud.
4. Verify PageIndex source commit/version at startup or build time.
5. Upload an immutable `pageindex-tree` artifact and, through one
   fenced/idempotent PostgreSQL operation, materialize the hierarchy, attach its
   reference, mark the generation published, and advance the ref's public
   current pointer.
6. Record represented documents, root count, node count, depth, adapter
   version, source pin, and build digest.
7. Define failure behavior: prepared release bytes remain immutable and the
   build root stays incomplete, but all four public tools continue resolving
   the prior indexed current release. Retry indexing without republishing pages.
8. Ensure search deterministically scores only the published derived-context
   tree and cannot invoke a model.
9. Test malformed worker output, timeout, crash, missing source checkout,
   version mismatch, duplicate index, and stale release.

Acceptance evidence:

- all generated pages are represented in the tree;
- `search_context` retrieves the pages used by the context-only critic for each
  required maintenance task;
- retrieval returns context and citations, not an answer; and
- list/read/diff work without any model.

### Work package 4: Board admission and production cutover

Manual build admission and the supported push, PR-open/synchronize, and
issue-open triggers now create Board builds with monotonic ref sequences and
provider-idempotent request keys. Public list/detail/progress views are
Board-backed and sanitize internal artifact, dependency, prompt, evidence, and
worker data. Comment/review/label/edit/close deliveries do not create Context
builds.

The coordinated production deployment now claims exactly the thirteen Board topics.
Do not reintroduce compatibility topics to a production worker. The legacy coordinator
source and rebuildable schema are absent from the active implementation and the current
dead-code scan is green. Executing the reviewed reset against the intended production
database remains pending.

Acceptance evidence:

- manual, push, PR opened, PR synchronize, and issue opened builds are visible
  entirely on the board;
- no production work is created by `ContextPipelineCoordinator`;
- all worker claims, retries, repairs, publication, and indexing are board
  tasks; and
- duplicate/out-of-order webhook tests pass.

Retain the exact local incremental matrix with the development-test-only
[trigger-admission acceptance harness](CONTEXT_TRIGGER_ADMISSION_ACCEPTANCE.md).
It refuses non-loopback APIs, uses the real signed webhook contract without
contacting GitHub, and checks manual, push, PR opened/synchronize, issue opened,
signed issue-comment no-op, request/delivery replay, and distinct stale-head
admission against exact Board-root deltas and ref sequences. Run it only against
an isolated API-only state with the worker stopped:

```bash
pnpm evaluate:context-trigger-admission -- \
  --api-url http://127.0.0.1:3000 \
  --tenant "$JINA_TENANT_ID" \
  --internal-token "$INTERNAL_API_TOKEN" \
  --webhook-secret "$GITHUB_WEBHOOK_SECRET" \
  --repository owner/repository \
  --branch main \
  --current-sha "<current-full-branch-sha>" \
  --pr-number 123 \
  --pr-head-sha "<current-full-pr-head-sha>" \
  --issue-number 456 \
  --report /absolute/path/to/retained/context-trigger-admission.json
```

### Work package 5: production agent executor

The transport-neutral runner and worker adapter are implemented. Each
dispatchable Board agent task uses one isolated sandbox, receives only a
bounded commit-bound archive and declared inputs, writes only declared outputs,
and uploads through lease/fence-scoped API routes. Local and Daytona envelopes
share the same byte contract.

Production sets `CONTEXT_BOARD_EXECUTOR=daytona`; startup fails for local or
implicit execution. Cloud Build also requires exactly one Daytona snapshot or
image plus a Daytona organization model-Secret name before it performs a cloud
mutation. Remaining acceptance is a retained Daytona run using the same Board
fixture after local Board E2E is green.

### Work package 6: API, MCP, token, and retrieval acceptance

The exact surface harness is implemented in `scripts/context-surface-e2e.mjs`.
It checks release/build binding, citations, hierarchy/PageIndex, no-answer
semantics, HTTP/MCP equivalence, token scopes, tenant isolation, and that
list/read/diff do not consume model quota. Exact successful Board model usage
is also persisted in the tenant quota ledger. A real published Board release is
still required to run this harness end to end; per-principal/per-token usage
reporting is explicitly outside this rollout contract and is tracked in
[API_TOKENS.md](API_TOKENS.md).

The complementary local-only security/load harness is documented in
[CONTEXT_SECURITY_LOAD_ACCEPTANCE.md](CONTEXT_SECURITY_LOAD_ACCEPTANCE.md). It
requires an already completed build and published release, runs concurrent
deterministic list/read/diff traffic without search or model calls, checks
authorization/isolation/revocation and public-payload leak boundaries, and
writes an explicit retained JSON report. Run it without restarting the current
API or worker:

```bash
pnpm evaluate:context-security-load -- \
  --api-url http://127.0.0.1:3000 \
  --tenant "$JINA_TENANT_ID" \
  --internal-token "$INTERNAL_API_TOKEN" \
  --query-token "$CONTEXT_API_TOKEN" \
  --principal "$JINA_CONTEXT_PRINCIPAL_ID" \
  --repository owner/repository \
  --build cb_completed_build \
  --release cr_published_release \
  --report /absolute/path/to/retained/context-security-load.json
```

Validate the exact public surface:

```text
HTTP:
POST /context/search
GET  /context/releases
GET  /context/list
GET  /context/read
GET  /context/diff

MCP:
search_context
list_context
read_context
diff_context
```

Implemented contract; retained surface acceptance is still required:

- every API/MCP call resolves the token's tenant and principal from the token,
  not caller-supplied identity headers;
- every call checks repository ACL before retrieval and again before returning;
- scopes independently gate query, build, review, and admin operations;
- revocation and expiry take effect immediately;
- no cross-tenant artifact key or release ID can be used as an oracle;
- public errors do not reveal whether another tenant's repository/release
  exists;
- search results contain only derived context sections with citations and
  release metadata;
- no prompt, model transcript, raw evidence, source blob, provider payload,
  board metadata, or private checkpoint is returned;
- per-tenant rate, concurrency, storage, and model-use quotas are enforced and
  observable; and
- MCP and HTTP return equivalent release/document semantics.

### Work package 7: dashboard and admin completion

Primary directories:

- `apps/dashboard/src/components/context`
- `apps/dashboard/src/lib`
- `apps/admin/app`
- `apps/admin/lib`

Implemented read/inspection behavior:

- board build graph, queued/running/retrying/failed/completed states;
- bounded failure summaries and checkpoint availability;
- valid active-build pages clearly labeled as unpublished checkpoints;
- current certified release and PageIndex health;
- list/read/search/diff over published releases;
- no internal plan, worker, prompt, transcript, evidence, audit, or artifact
  object layout in the public UI;
- loading, empty, partial, resume, failure, publication, and degraded-index
  states; and
- dashboard/admin/API agreement on release identity and status.

The public dashboard proxy is intentionally read-only. Tenant-admin retry is
available through fenced API operations and the local watcher, and token
mint/list/revoke is available through the internal administrative API with no
secret re-display. Direct editing of generated Context remains unsupported.
Retained acceptance must verify the dashboard, admin, API, and catalog show the
same final release and build state.

### Work package 8: reset legacy data and remove compatibility

Use `packages/db/src/reset-context-data.ts` and the documented reset policy.
Legacy pipeline/coordinator tables, coordinator source, and their rebuildable
repositories have been removed from the fresh schema. Focused tests and the current
dead-code scan pass. The explicit reset has not been executed against a production
database.

Required sequence:

1. Review a dry run against a disposable database.
2. Verify preserved identity/control rows and exact deleted rebuildable rows.
3. Execute only with the required explicit confirmation.
4. Start API/workers against the empty Context corpus.
5. Run a cold board build and all retrieval surfaces.
6. Re-run dead-code, migration, and fresh-database tests after the reset.

Do not treat “backward compatibility not required” as permission to delete
tenant, installation, repository, ACL, token, erasure, or audit identity.

## Local acceptance matrix

All rows require retained artifacts and machine-readable reports.

### Jina

1. Cold build at exact commit.
2. Interrupt after several verified pages.
3. Resume the same commit and prove checkpoint reuse.
4. Complete all pages and audits.
5. Source challenge, context-only evaluation, bounded repair, rechallenge, and
   unchanged certification.
6. Atomic publication.
7. Self-hosted PageIndex.
8. Quality evaluator.
9. Retrieval evaluator.
10. HTTP and all four MCP tools.
11. Dashboard and admin inspection.
12. New commit incremental build.
13. PR opened incremental/preview build.
14. PR synchronize with a new head.
15. New issue build on default branch.
16. Issue comment no-op.
17. Duplicate and out-of-order webhook behavior.

### Representative repositories

Use at least:

- a small focused library;
- a medium service or monorepo with operational behavior;
- a repository with meaningful issue/PR/commit history.

VectifyAI/PageIndex and VectifyAI/OpenKB are useful fixtures but do not by
themselves cover every shape. Capture exact commits and provider evidence.

For every repository:

- retain the input snapshot, public output, private state, board snapshot,
  release artifact, PageIndex tree, quality report, retrieval report, and
  incremental comparison;
- verify every required maintenance question has a latest context-only pass;
- verify every page is used by at least one passing task;
- verify every material assertion's stable citation identity is independently
  supported;
- verify architecture reachability and crosslinks;
- verify relevant history connects to current behavior;
- verify exact commit/ref/frontier freshness; and
- inspect the public documents for maintainer usefulness rather than scoring
  length.

## Objective parity audit

Do not claim “comparable to DeepWiki and Code Wiki” from page count or visual
similarity.

Create a fixed repository-specific maintenance-task set for each fixture and
compare:

- time and context needed to orient a change;
- entrypoint and important-symbol discovery;
- control/data/state-flow explanation;
- trust boundaries and invariants;
- failure and recovery guidance;
- configuration and operations;
- focused verification/tests;
- exact concept-to-source navigation;
- history relevance;
- hierarchy and cross-page navigation;
- useful diagrams; and
- stale or unsupported statements.

Use the context-only critic attempts as machine-auditable evidence. Add blind
human inspection where practical. Record concrete deficits and repeat
derivation until there are no blocking gaps. A passing deterministic evaluator
is necessary but not sufficient.

## Local Board-native stack

The supported local stack exercises the dynamic Board workflow rather than the
legacy three-stage coordinator. It starts PostgreSQL with the production
capability roles, the API with the PostgreSQL publication transaction, a
filesystem artifact store, separate snapshot/agent/auditor/certification/
publication/PageIndex workers, and the pinned self-hosted PageIndex checkout.
Three agent workers and two auditor workers run by default, so independent
research subjects, pages, and audits are claimed concurrently.

The Board agents use the local Codex CLI, the current signed-in session,
`gpt-5.6-terra`, and low reasoning effort. `dev-up.sh` verifies PageIndex commit
`982514ab40fe42a169ea087c13819cf87c87724f` and its source digest before
starting. It installs the isolated Python environment once under
`/tmp/jina-dev/pageindex`; set `JINA_DEV_PAGEINDEX_BOOTSTRAP_PYTHON` when
Python 3.10+ is not the default.

Local workers use a stack-owned Codex runtime home and symlink only the current
session `auth.json`. Mutable model-cache and configuration files are not shared
with the desktop client. This preserves the requested session authentication
while preventing a desktop cache-schema refresh from breaking an in-flight
build.

```sh
scripts/dev-up.sh
source /tmp/jina-dev.env
scripts/context-build.sh omxyz/jina --budget 10800 --detail thorough
scripts/dev-restart.sh
scripts/dev-down.sh --processes-only
```

`context-build.sh` follows tasks by id as the Board materializes them. It shows
parallel research/page/audit work, repair passes, and unpublished checkpoint
pages without assuming a fixed stage order. A successful watcher then reads the
atomically published catalog and reports the release and attached PageIndex
tree. `dev-down.sh --processes-only` stops the API and workers while preserving
PostgreSQL, Board state, credentials, PageIndex, logs, and local immutable
artifacts. Plain `dev-down.sh` is terminal teardown: it also removes the owned
PostgreSQL container and private environment/restart files while leaving logs
and immutable artifacts under `/tmp/jina-dev`. Override `JINA_DEV_AGENT_WORKERS`,
`JINA_DEV_AUDIT_WORKERS`, or `JINA_DEV_LOG_RETENTION` for local capacity and
retention.

Use `scripts/dev-restart.sh` after an API or worker failure, or when validating
checkpoint recovery. It stops only PIDs recorded by this checkout, releases
active worker leases while the API is still reachable, and then restores the
same role topology and credentials. It does not recreate or remove PostgreSQL,
rewrite `/tmp/jina-dev.env`, delete immutable artifacts, or discard logs.
Afterward it verifies the API and every worker health/topology endpoint and
prints active or failed build IDs with the corresponding
`scripts/context-build.sh --watch <build-id>` command. Compilation is
deliberately separate; pass
`scripts/dev-restart.sh --build` only when the current sources should replace
the already-built process artifacts.

An older local stack may predate the private restart configuration. Bootstrap
it without stopping anything:

```sh
scripts/dev-restart.sh --capture-current
scripts/dev-restart.sh
```

Capture refuses custom database/container/port layouts. It requires an owned,
running PostgreSQL container, a current-user 0600 environment file, the exact
recorded 3-agent/2-auditor PID topology, matching process tokens/settings, a
valid Codex session, and the attested PageIndex probe. It reads settings from
the owned processes and creates only `/tmp/jina-dev/restart.env`; it does not
signal a process or mutate the database, environment, artifacts, or logs.

If the private environment files were lost but an explicitly recovered,
checkout-owned PostgreSQL container and the immutable artifact directory are
still present, reseed only the local process credentials:

```sh
PAGEINDEX_SOURCE_ROOT=/absolute/path/to/the/pinned/PageIndex \
CONTEXT_PAGEINDEX_PYTHON=/absolute/path/to/its/venv/bin/python \
scripts/dev-restart.sh --reseed-local-state
scripts/dev-restart.sh --build
```

Reseeding fails closed unless retained `jina_runtime.api_state`, the current
Codex session, and the pinned PageIndex probe are available. It rotates the
local static API credentials but does not alter repository data, Board state,
or artifacts. It never discovers or attaches a PostgreSQL volume; the operator
must establish that database/container identity explicitly first.

Local Board agent runners use a 128,000-token context limit and compact at
96,000 tokens. These bounds accommodate publication and source-challenge stages
that consume all dynamically discovered research packets while remaining below
the runner's 256,000-token hard maximum.

## Full validation commands

Focused:

```sh
pnpm --filter @jina/context-engine test
pnpm --filter @jina/daytona test
pnpm --filter @jina/api test
pnpm --filter @jina/worker test
git diff --check
```

Repository harness:

```sh
pnpm test:context-repository-harness
pnpm evaluate:context-repository -- --help
pnpm evaluate:context-quality /absolute/path/to/retained-run
CONTEXT_DERIVE_DIR=/absolute/path/to/retained-run \
CONTEXT_PAGEINDEX_WORKER=/absolute/path/to/services/pageindex-worker/worker.py \
CONTEXT_PAGEINDEX_PYTHON=/absolute/path/to/python \
pnpm evaluate:context-retrieval
```

Before a production-readiness claim, also run from the workspace root:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm lint:dead-code
pnpm build
```

## Failure and chaos cases that must be proven

- worker dies before any artifact;
- worker dies after artifact upload but before board completion;
- completion response is lost after the transaction;
- lease expires and a stale worker tries to upload or complete;
- two workers receive duplicate delivery attempts;
- older ref sequence finishes after a newer build;
- API restarts during dynamic graph expansion;
- GCS upload/read outage;
- PostgreSQL transaction rollback;
- invalid/colliding immutable artifact write;
- model timeout on one page while siblings complete;
- page repair and global repair exhaustion;
- source challenge adds a new material subject;
- context-only critic returns partial/fail with malformed gap severity;
- certification sees mismatched page or task digest;
- publication preparation succeeds and PageIndex fails before public-pointer
  advancement;
- PageIndex returns malformed or incomplete tree;
- token is revoked between retrieval start and response;
- cross-tenant artifact/release IDs are supplied directly; and
- erasure races an in-flight build or projection.

Every case needs an explicit expected state, retained diagnostic, retry path,
and proof that no partial or stale release became public.

## Production rollout

Only after all local board-native acceptance is green:

1. Run the same board fixture using Daytona.
2. Review and execute the rebuildable-data reset against the intended
   environment.
3. Configure the immutable Daytona derivation sandbox and model Secret, then
   deploy the model-free API, the exact thirteen-topic PageIndex-capable Board
   worker, dashboard, and admin from one coordinated immutable revision.
4. Run a real GitHub App installation cold build.
5. Exercise bound non-admin HTTP and MCP tokens.
6. Run all four MCP tools from a real local coding/review agent.
7. Verify dashboard/admin state against API release IDs.
8. Canary one repository/tenant before broad rollout.
9. Monitor queue latency, lease expiry, task duration, retries, repair counts,
   citation failures, partial-build age, publication latency, lexical retrieval
   misses, PageIndex failure, storage, and per-tenant build-model consumption.
10. Maintain rollback and reindex runbooks. A rollback must never advance an
    older release over a newer ref sequence.

## Completion checklist

Implementation evidence at the rebased revision:

- [x] Board is the only production scheduler.
- [x] Every required Board topic has a production executor.
- [x] Dynamic research, pages, audits, repairs, gates, publication, and indexing
      are visible and resumable Board tasks.
- [x] Terminal failures fence descendant leases and quotas, and exact worker
      completions remain replayable.
- [x] New builds can seed and reconcile an immutable prior Context release.
- [x] Public-current advancement is atomic with PageIndex attachment.
- [x] Search returns selected derived Context rather than a generated answer.
- [x] List/read/diff are model-free.
- [x] MCP exposes exactly `search_context`, `list_context`, `read_context`, and
      `diff_context`.
- [x] Issue comments and non-trigger events produce no build in focused and
      trigger-harness tests.

Do not close the objective until every acceptance item below has retained or
deployed evidence:

- [ ] Final citation audit supports every public core evidence binding; the lead
      and every substantive section are grounded, and the context-only critic
      finds no uncited high-impact assertion.
- [ ] Context-only critic passes every required maintenance task.
- [ ] Every public page is used by a latest passing task.
- [ ] No open blocking gaps remain.
- [ ] Final certification binds unchanged public bytes, task catalog, citation
      audit, repository/ref/commit, and publication plan/catalog.
- [ ] Atomic publication and stale-sequence fencing are proven.
- [ ] Self-hosted pinned PageIndex is attached to the release.
- [ ] API and the exact four MCP tools pass tenant/principal/ACL isolation.
- [ ] Dashboard and admin show the same published release state.
- [ ] Jina cold, interrupted/resumed, commit, PR, and issue scenarios pass.
- [ ] Representative repository matrix passes.
- [ ] Retrieval benchmark passes for required maintenance tasks.
- [ ] DeepWiki/Code Wiki comparison has no blocking deficit.
- [ ] Legacy scheduler, schema, data, routes, and accidental artifacts are
      removed.
- [ ] Full unit, integration, E2E, typecheck, lint, dead-code, build, security,
      chaos, and production acceptance are green.

## First actions for a new session

1. Read this file and the three linked specifications.
2. Confirm the worktree still derives from
   `476c3b09e1b102d1e1c5ec3480a4d753d92ebf2e`, inspect `git status --short`,
   and run `git diff --check` plus the five focused package suites.
3. Check whether the clean rebased Jina run already has an owner. Do not start a
   duplicate. Record its build ID and follow it with
   `scripts/context-build.sh --watch <build-id>`.
4. When that run becomes terminal, verify there are no orphaned leases or active
   model reservations. A failed run is failure evidence, not permission to
   describe publication as successful.
5. For a successful run, retain and inspect certification, release, PageIndex,
   quality, retrieval, API/MCP, dashboard, admin, duration, token, repair, and
   retry evidence before starting the incremental matrix.
6. Run Jina interruption/resume, new commit, PR open/synchronize, issue open,
   issue-comment no-op, replay/stale-head, and representative-repository
   matrices.
7. Run the same fixture through the preflighted Daytona executor.
8. Review the production reset dry run and platform-bootstrap inventory; only
   then run the coordinated candidate deployment, acceptance job, and canary.
9. Keep the implementation plan current, but do not rewrite the acceptance
   benchmark to match easier existing behavior.
10. Continue until the complete checklist has evidence; do not mark parity from
    partial tests or a plausible document sample.
