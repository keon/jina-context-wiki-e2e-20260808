# Representative repository Context E2E

`scripts/context-repository-e2e.mjs` is the repeatable local acceptance harness
for generating Context from a real repository. It is intentionally separate
from API/MCP acceptance: its job is to prove that exact repository evidence can
be researched, turned into citation-valid engineering documentation, and
published through the self-hosted PageIndex hierarchy.

The harness reads an immutable snapshot from Git objects at the repository's
exact `HEAD`. A dirty working tree therefore cannot change either the manifest
or citation authority. It ingests every tree entry, includes up to a configured
number of commit records, and optionally includes issues and pull requests from
a retained provider-evidence file. Binary and oversized blobs remain visible in
the manifest but are not made available as prose evidence.

## Prepared acceptance fixtures

The local fixture root is `/tmp/jina-context-fixtures`. Its
`manifest.json` is the machine-readable authority for the prepared snapshots,
capture bounds, hashes, build shapes, validation results, and absolute artifact
paths. Each fixture has this layout:

```text
<slug>/
  repository/                     detached, clean Git checkout
  repository-input.json           exact Git-object input and commit history
  provider-evidence.json          retained repository/issue/PR observations
  provider-capture-metadata.json  capture frontier and GitHub response identity
  capture-validation.json         no-model ingestion result
```

Retained model and Board acceptance evidence belongs under
`/tmp/jina-context-acceptance/representative`, not inside a fixture directory.
The capture command owns exactly the five inputs above and intentionally refuses
to replace a fixture containing unrelated report files. Keeping evidence in a
separate root therefore lets a later branch-head capture replace the immutable
fixture without deleting or moving the preceding cold-build evidence.

The 2026-07-30 matrix is:

| Repository            | Ref and immutable commit                               | Versioned files / bytes | Captured text files / bytes | Retained history | Retained provider evidence                | Complementary shape                                                                                                   |
| --------------------- | ------------------------------------------------------ | ----------------------: | --------------------------: | ---------------: | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `VectifyAI/PageIndex` | `main` at `982514ab40fe42a169ea087c13819cf87c87724f`   |         56 / 27,177,499 |                47 / 693,495 |  all 327 commits | repository + all 121 issues + all 221 PRs | Compact Python tree-search/retrieval implementation, prompt-heavy code, tests, examples, and binary document fixtures |
| `VectifyAI/OpenKB`    | `main` at `ff54396e575ee6feb0113b631a34caa082b441cc`   |        293 / 28,992,587 |             289 / 3,456,776 |  all 175 commits | repository + all 53 issues + all 150 PRs  | Medium full-stack system: Hatch Python CLI/API plus React/Vite TypeScript workbench                                   |
| `rs/xid`              | `master` at `40a728ce78a40c2c2ef30d2fad55402e74ae920d` |             20 / 40,522 |                 20 / 40,522 |   all 88 commits | repository + all 50 issues + all 67 PRs   | Genuinely small compiled Go library with platform-specific files, stable encoding/database contracts, tests, and CI   |

“Captured text” means a regular Git blob whose exact bytes are available to the
derivation agent. The versioned-byte count also includes binary blobs that remain
manifest-visible but are not prose evidence.

The provider captures are immutable observations. Capture is bounded to 500
commits, 500 retained issues, 500 retained pull requests, and ten 100-record
pages per GitHub endpoint. A smaller repository, including all three prepared
fixtures above, can still exhaust its Git and provider frontiers within those
bounds. Because GitHub's issues endpoint also returns PRs, those records are
filtered out and retained once as `pull_request` evidence. The manifest records
the configured bounds, page counts, response ETags, and whether each endpoint
frontier was exhausted. Issue comments are intentionally outside this fixture
contract; production snapshotting may collect comments as evidence, but
comment delivery never triggers a Context build.

`benbjohnson/clock` was considered for the small-library row and rejected
because GitHub marks it archived. `rs/xid` is active, public, small, and adds a
repository shape not already covered by the two Python-heavy targets.

Refresh a fixture with the checked-in capture command. The command accepts only
a public `OWNER/NAME`, resolves the exact branch head through `git ls-remote`,
clones and detaches that SHA, captures immutable Git objects, and checks that
the authoritative head did not move before publication. It validates the
result through `IngestEvidenceService` and `EvidenceFocusSelector`, hashes every
retained JSON artifact, and atomically replaces only the selected fixture and
its manifest entry:

```sh
pnpm capture:context-repository-fixture -- \
  --repository VectifyAI/PageIndex \
  --ref main \
  --slug pageindex \
  --fixture-root /tmp/jina-context-fixtures \
  --history-limit 500 \
  --issue-limit 500 \
  --pull-request-limit 500 \
  --provider-page-limit 10
```

Public GitHub API capture works anonymously. `GH_TOKEN` or `GITHUB_TOKEN` may be
provided through the environment only when rate-limit headroom is needed; there
is deliberately no token CLI flag. Provider payloads are reduced to an
allowlist of research-relevant fields, clone URLs and temporary token fields
are discarded, and neither authorization headers nor credential values are
written to artifacts. The command refuses to replace a fixture directory that
contains files outside its five owned inputs, preventing old build reports from
being silently deleted or misattributed to the new SHA.

Validate the prepared corpus without invoking Codex:

```sh
jq -e '
  .fixtures | length == 3
  and all(.validation.status == "passed")
  and all(.gitHistory.complete == true)
  and all(.providerHistory.complete == true)
' /tmp/jina-context-fixtures/manifest.json

for fixture in pageindex openkb xid; do
  git -C "/tmp/jina-context-fixtures/${fixture}/repository" \
    status --short --branch
done

pnpm test:context-repository-harness
```

Every checkout should report detached `HEAD` with no changed paths. The
machine-readable validation files were produced by passing each repository
input and provider capture through `IngestEvidenceService` and
`EvidenceFocusSelector`; this verifies the same evidence contract used before
model derivation. `rs/xid` produces a complete checkpoint. PageIndex and OpenKB
correctly produce partial checkpoints because 9 and 4 binary blobs,
respectively, are manifest-visible but unavailable as prose evidence; their Git
and issue/PR histories are complete.

## Prerequisites

Build the JavaScript packages and prepare the pinned PageIndex worker as
described in [`services/pageindex-worker/README.md`](../services/pageindex-worker/README.md).
The worker must use the pinned open-source PageIndex checkout; repository
contents are not sent to PageIndex Cloud.

The default derivation configuration is:

- current Codex session authentication;
- `gpt-5.6-terra`;
- low reasoning effort;
- a 3,600-second total budget;
- two attempts with a 70/30 initial/repair budget split; and
- checkpoint-validated retries that resume the preceding run's public pages,
  durable orchestration, and private research, writer, source-challenge, and
  critic stage receipts.

Unused initial time carries into the repair attempt. `--first-attempt-share`
configures the initial share between `0.5` and `0.9`; at least 60 seconds is
reserved for every configured attempt. The private-stage environment setting is
scoped to one Codex generation call and restored afterward, so a retained
checkpoint cannot leak into another harness invocation. The executor still
validates the repository/ref/commit identity and receipt input digests before
reusing any private stage.

All settings can be overridden through flags or the environment.

## Run a repository

```sh
PAGEINDEX_SOURCE_ROOT=/absolute/path/to/PageIndex \
CONTEXT_PAGEINDEX_PYTHON=/absolute/path/to/pageindex-venv/bin/python \
pnpm evaluate:context-repository -- \
  --repo-dir /absolute/path/to/PageIndex \
  --repository VectifyAI/PageIndex \
  --history-limit 50 \
  --budget-seconds 3600 \
  --first-attempt-share 0.7 \
  --report /absolute/path/to/pageindex-context-report.json
```

OpenKB uses the same generic path:

```sh
PAGEINDEX_SOURCE_ROOT=/absolute/path/to/PageIndex \
CONTEXT_PAGEINDEX_PYTHON=/absolute/path/to/pageindex-venv/bin/python \
pnpm evaluate:context-repository -- \
  --repo-dir /absolute/path/to/OpenKB \
  --repository VectifyAI/OpenKB \
  --report /absolute/path/to/openkb-context-report.json
```

Run the prepared fixtures with their pinned provider observations:

```sh
FIXTURES=/tmp/jina-context-fixtures
ACCEPTANCE=/tmp/jina-context-acceptance/representative
mkdir -p "${ACCEPTANCE}"/{pageindex,openkb,xid}
PAGEINDEX_SOURCE_ROOT="${FIXTURES}/pageindex/repository"
CONTEXT_PAGEINDEX_PYTHON=/tmp/jina-pageindex-venv/bin/python

PAGEINDEX_SOURCE_ROOT="${PAGEINDEX_SOURCE_ROOT}" \
CONTEXT_PAGEINDEX_PYTHON="${CONTEXT_PAGEINDEX_PYTHON}" \
pnpm evaluate:context-repository -- \
  --repo-dir "${FIXTURES}/pageindex/repository" \
  --repository VectifyAI/PageIndex \
  --ref main \
  --history-limit 500 \
  --provider-evidence "${FIXTURES}/pageindex/provider-evidence.json" \
  --budget-seconds 5400 \
  --report "${ACCEPTANCE}/pageindex/cold-report.json"

PAGEINDEX_SOURCE_ROOT="${PAGEINDEX_SOURCE_ROOT}" \
CONTEXT_PAGEINDEX_PYTHON="${CONTEXT_PAGEINDEX_PYTHON}" \
pnpm evaluate:context-repository -- \
  --repo-dir "${FIXTURES}/openkb/repository" \
  --repository VectifyAI/OpenKB \
  --ref main \
  --history-limit 500 \
  --provider-evidence "${FIXTURES}/openkb/provider-evidence.json" \
  --budget-seconds 5400 \
  --report "${ACCEPTANCE}/openkb/cold-report.json"

PAGEINDEX_SOURCE_ROOT="${PAGEINDEX_SOURCE_ROOT}" \
CONTEXT_PAGEINDEX_PYTHON="${CONTEXT_PAGEINDEX_PYTHON}" \
pnpm evaluate:context-repository -- \
  --repo-dir "${FIXTURES}/xid/repository" \
  --repository rs/xid \
  --ref master \
  --history-limit 500 \
  --provider-evidence "${FIXTURES}/xid/provider-evidence.json" \
  --budget-seconds 3600 \
  --report "${ACCEPTANCE}/xid/cold-report.json"
```

Use `--provider-evidence` when a retained `derive-input/evidence.json` contains
GitHub issues or pull requests. Commit history does not require a provider
export: it is collected directly from the local Git repository and bounded by
`--history-limit`.

Run `node scripts/context-repository-e2e.mjs --help` for every flag and
environment equivalent.

## Board cold and incremental commands

The repository harness above is the immutable local-input quality proof. The
Board worker independently clones GitHub and fails closed unless a supplied
commit is still the authoritative remote head. The local harness uses an
in-memory Context store and the retained provider capture; it does not call the
API or consume the retained Board worker pool.

Run the matrix only against worker processes built from the candidate checkout.
After every earlier build is terminal, use `scripts/dev-restart.sh --build` to
load the candidate without discarding retained PostgreSQL or artifact state.
Do not restart an active build here; interruption/resume has its own acceptance
case and evidence.

Then perform these read-only gates. Every command must succeed:

```sh
source /tmp/jina-dev.env
ACCEPTANCE_ROOT=/tmp/jina-context-acceptance/representative
mkdir -p "${ACCEPTANCE_ROOT}"

curl -fsS "${JINA_API_URL}/health" |
  jq -e '.ok == true and .storage == "postgres" and .durableWorker == true'

curl -fsS \
  -H "Authorization: Bearer ${JINA_INTERNAL_TOKEN}" \
  -H "X-Jina-Tenant-Id: ${JINA_TENANT_ID}" \
  -H "X-Jina-Principal-Id: tenant:${JINA_TENANT_ID}" \
  "${JINA_API_URL}/context/builds?status=active" |
  tee "${ACCEPTANCE_ROOT}/active-builds-preflight.json" |
  jq -e '.builds | length == 0'

PAGEINDEX_SOURCE_ROOT=/tmp/jina-context-fixtures/pageindex/repository \
CONTEXT_PAGEINDEX_PYTHON=/tmp/jina-pageindex-venv/bin/python \
/tmp/jina-pageindex-venv/bin/python \
  services/pageindex-worker/worker.py --probe |
  jq -e '
    .available == true
    and .sourcePin == "982514ab40fe42a169ea087c13819cf87c87724f"
  '

while IFS="$(printf '\t')" read -r repository ref expected; do
  actual="$(
    git ls-remote "https://github.com/${repository}.git" \
      "refs/heads/${ref}" |
      awk 'NR == 1 { print $1 }'
  )"
  test "${actual}" = "${expected}"
done <<'EOF'
VectifyAI/PageIndex	main	982514ab40fe42a169ea087c13819cf87c87724f
VectifyAI/OpenKB	main	ff54396e575ee6feb0113b631a34caa082b441cc
rs/xid	master	40a728ce78a40c2c2ef30d2fad55402e74ae920d
EOF
```

An active-build result other than an empty array is a stop condition, not a
warning. Run representative Board builds one at a time so their model work,
audits, and repairs do not contend in the shared pool. Use `rs/xid` as the
small smoke test, then PageIndex, then OpenKB. Wait for each build and its
acceptance report to finish before submitting the next.

After the gates pass, synchronize the fixture ACL and submit the exact ref and
SHA:

```sh
source /tmp/jina-dev.env
ACCEPTANCE=/tmp/jina-context-acceptance/representative
mkdir -p "${ACCEPTANCE}"/{xid,pageindex,openkb}

curl -fsS -X POST \
  -H "Authorization: Bearer ${JINA_INTERNAL_TOKEN}" \
  -H "X-Jina-Tenant-Id: ${JINA_TENANT_ID}" \
  -H "X-Jina-Principal-Id: tenant:${JINA_TENANT_ID}" \
  -H "Content-Type: application/json" \
  --data '{"repositories":["VectifyAI/PageIndex","VectifyAI/OpenKB","rs/xid"],"mode":"merge"}' \
  "${JINA_API_URL}/internal/context/access/sync"

start_pinned_build() {
  repository="$1"
  ref="$2"
  commit_sha="$3"
  phase="$4"
  response_path="$5"
  curl -fsS -X POST \
    -H "Authorization: Bearer ${JINA_INTERNAL_TOKEN}" \
    -H "X-Jina-Tenant-Id: ${JINA_TENANT_ID}" \
    -H "X-Jina-Principal-Id: tenant:${JINA_TENANT_ID}" \
    -H "Content-Type: application/json" \
    --data "$(jq -nc \
      --arg repository "${repository}" \
      --arg ref "${ref}" \
      --arg commitSha "${commit_sha}" \
      --arg requestKey "representative-${phase}:${repository}:${commit_sha}" \
      '{repository:$repository,ref:$ref,commitSha:$commitSha,
        requestKey:$requestKey,derivationBudgetSeconds:5400,
        derivationDetail:"thorough"}')" \
    "${JINA_API_URL}/context/build" | tee "${response_path}"
}

start_pinned_build \
  rs/xid master \
  40a728ce78a40c2c2ef30d2fad55402e74ae920d \
  cold "${ACCEPTANCE}/xid/board-cold-response.json"

XID_COLD_BUILD="$(jq -er '.build.id' "${ACCEPTANCE}/xid/board-cold-response.json")"
scripts/context-build.sh --watch "${XID_COLD_BUILD}"
pnpm evaluate:context-board-quality -- \
  --artifact-root "${CONTEXT_ARTIFACT_DIRECTORY}" \
  --build "${XID_COLD_BUILD}" \
  > "${ACCEPTANCE}/xid/board-cold-quality.json"

start_pinned_build \
  VectifyAI/PageIndex main \
  982514ab40fe42a169ea087c13819cf87c87724f \
  cold "${ACCEPTANCE}/pageindex/board-cold-response.json"

PAGEINDEX_COLD_BUILD="$(jq -er '.build.id' "${ACCEPTANCE}/pageindex/board-cold-response.json")"
scripts/context-build.sh --watch "${PAGEINDEX_COLD_BUILD}"
pnpm evaluate:context-board-quality -- \
  --artifact-root "${CONTEXT_ARTIFACT_DIRECTORY}" \
  --build "${PAGEINDEX_COLD_BUILD}" \
  > "${ACCEPTANCE}/pageindex/board-cold-quality.json"

start_pinned_build \
  VectifyAI/OpenKB main \
  ff54396e575ee6feb0113b631a34caa082b441cc \
  cold "${ACCEPTANCE}/openkb/board-cold-response.json"

OPENKB_COLD_BUILD="$(jq -er '.build.id' "${ACCEPTANCE}/openkb/board-cold-response.json")"
scripts/context-build.sh --watch "${OPENKB_COLD_BUILD}"
pnpm evaluate:context-board-quality -- \
  --artifact-root "${CONTEXT_ARTIFACT_DIRECTORY}" \
  --build "${OPENKB_COLD_BUILD}" \
  > "${ACCEPTANCE}/openkb/board-cold-quality.json"
```

Each watcher must reach `completed`, and each quality command must exit zero,
before submitting the next row. If a remote branch has advanced, do not remove
`commitSha`: refresh and validate a new immutable fixture, then submit that new
exact head.

After each cold build, prove the manual request is idempotent without creating
another Board root. Reuse the exact phase, repository, ref, and SHA:

```sh
assert_cold_replay() {
  repository="$1"
  ref="$2"
  commit_sha="$3"
  cold_response="$4"
  replay_response="$5"
  expected_build="$(jq -er '.build.id' "${cold_response}")"
  before_count="$(
    curl -fsS \
      -H "Authorization: Bearer ${JINA_INTERNAL_TOKEN}" \
      -H "X-Jina-Tenant-Id: ${JINA_TENANT_ID}" \
      -H "X-Jina-Principal-Id: tenant:${JINA_TENANT_ID}" \
      "${JINA_API_URL}/context/builds" | jq '.builds | length'
  )"

  start_pinned_build \
    "${repository}" "${ref}" "${commit_sha}" \
    cold "${replay_response}"

  jq -e --arg build "${expected_build}" \
    '.duplicate == true and .build.id == $build' \
    "${replay_response}"

  after_count="$(
    curl -fsS \
      -H "Authorization: Bearer ${JINA_INTERNAL_TOKEN}" \
      -H "X-Jina-Tenant-Id: ${JINA_TENANT_ID}" \
      -H "X-Jina-Principal-Id: tenant:${JINA_TENANT_ID}" \
      "${JINA_API_URL}/context/builds" | jq '.builds | length'
  )"
  test "${after_count}" = "${before_count}"
}

assert_cold_replay \
  rs/xid master 40a728ce78a40c2c2ef30d2fad55402e74ae920d \
  "${ACCEPTANCE}/xid/board-cold-response.json" \
  "${ACCEPTANCE}/xid/board-cold-replay-response.json"

assert_cold_replay \
  VectifyAI/PageIndex main 982514ab40fe42a169ea087c13819cf87c87724f \
  "${ACCEPTANCE}/pageindex/board-cold-response.json" \
  "${ACCEPTANCE}/pageindex/board-cold-replay-response.json"

assert_cold_replay \
  VectifyAI/OpenKB main ff54396e575ee6feb0113b631a34caa082b441cc \
  "${ACCEPTANCE}/openkb/board-cold-response.json" \
  "${ACCEPTANCE}/openkb/board-cold-replay-response.json"
```

Do not change the request key merely to force a second build at the same
frontier: that is neither a replay proof nor a valid incremental test.

For the next real branch-head commit, refresh the detached clone, prove the
frontier advanced, and submit a new fenced build. This example is for
PageIndex; use `VectifyAI/OpenKB main openkb` or `rs/xid master xid` as the
three arguments to refresh the other fixtures:

```sh
refresh_representative_fixture() {
  repository="$1"
  ref="$2"
  slug="$3"
  old_sha="$(
    jq -er --arg repository "${repository}" \
      '.fixtures[] | select(.repository == $repository) | .commit.sha' \
      /tmp/jina-context-fixtures/manifest.json
  )"
  remote_sha="$(
    git ls-remote "https://github.com/${repository}.git" \
      "refs/heads/${ref}" | awk 'NR == 1 { print $1 }'
  )"
  test -n "${remote_sha}"
  test "${remote_sha}" != "${old_sha}"

  pnpm capture:context-repository-fixture -- \
    --repository "${repository}" \
    --ref "${ref}" \
    --slug "${slug}" \
    --fixture-root /tmp/jina-context-fixtures \
    --history-limit 500 \
    --issue-limit 500 \
    --pull-request-limit 500 \
    --provider-page-limit 10

  new_sha="$(
    jq -er --arg repository "${repository}" \
      '.fixtures[] | select(.repository == $repository) | .commit.sha' \
      /tmp/jina-context-fixtures/manifest.json
  )"
  test "${new_sha}" = "${remote_sha}"
  jq -e --arg repository "${repository}" --arg sha "${new_sha}" '
    .fixtures[]
    | select(.repository == $repository)
    | .commit.sha == $sha
      and .validation.status == "passed"
      and .gitHistory.complete == true
      and .providerHistory.complete == true
  ' /tmp/jina-context-fixtures/manifest.json
}

refresh_representative_fixture VectifyAI/PageIndex main pageindex

FIXTURE=/tmp/jina-context-fixtures/pageindex
ACCEPTANCE=/tmp/jina-context-acceptance/representative/pageindex
OLD_SHA="$(
  jq -er '.build.commitSha' "${ACCEPTANCE}/board-cold-response.json"
)"
NEW_SHA="$(
  jq -er '.fixtures[] | select(.repository=="VectifyAI/PageIndex")
    | .commit.sha' /tmp/jina-context-fixtures/manifest.json
)"
test "${NEW_SHA}" != "${OLD_SHA}"

start_pinned_build \
  VectifyAI/PageIndex main "${NEW_SHA}" \
  incremental "${ACCEPTANCE}/board-incremental-response.json"
INCREMENTAL_BUILD="$(
  jq -er '.build.id' "${ACCEPTANCE}/board-incremental-response.json"
)"
scripts/context-build.sh --watch "${INCREMENTAL_BUILD}"

pnpm evaluate:context-board-quality -- \
  --artifact-root "${CONTEXT_ARTIFACT_DIRECTORY}" \
  --build "${INCREMENTAL_BUILD}" \
  --previous-build "${PAGEINDEX_COLD_BUILD}" \
  > "${ACCEPTANCE}/board-incremental-quality.json"
```

The refresh binds the manifest, detached checkout, provider evidence, and
validation to `NEW_SHA`; the old cold evidence remains under the separate
acceptance root. Apply the same sequence independently to OpenKB and `rs/xid`
when their real branch heads advance, using `OPENKB_COLD_BUILD` or
`XID_COLD_BUILD` as `--previous-build`. The incremental quality evaluator
deliberately fails when both commit and provider frontier are unchanged, so a
same-SHA build with a different request key is not acceptable substitute
evidence.

PR and issue incrementals should be admitted through GitHub intake, not
masqueraded as manual branch builds. On a dev-only stack, use the unsigned
fixture endpoint with the actual current PR head or default branch:

```sh
curl -fsS -H "Content-Type: application/json" \
  --data '{"repository":"owner/repo","pullRequestNumber":123,
    "headSha":"<current-full-pr-head-sha>"}' \
  "${JINA_API_URL}/dev/webhooks/github"

curl -fsS -H "Content-Type: application/json" \
  --data '{"repository":"owner/repo","issueNumber":456,
    "title":"<new-issue-title>","defaultBranch":"main"}' \
  "${JINA_API_URL}/dev/webhooks/github"
```

Use a genuinely new PR head or new issue record and retain the current/previous
Board quality reports. An issue comment must be sent through the signed
`issue_comment` webhook path and must leave the count of `build-context` tasks
unchanged; the dev fixture intentionally exposes only supported triggers.

## Fail-closed gates

The harness does not publish a partial result. Before indexing, it requires:

1. Codex's host-checked orchestration to be `complete`, including the persisted
   source-aware challenge and digest-bound context-only critic certification.
2. The retained artifact to pass `context-quality-benchmark.mjs`, including
   task answerability, exact source links, cross-document reachability, and
   provider/history accounting when applicable.
3. Every generated page to pass the Context engine's immutable citation
   validator. A run that would publish only a subset of its pages is rejected.
4. The real derivation service to commit one citation-valid revision for every
   generated page.
5. The real index coordinator to publish a release with derived knowledge and
   the self-hosted PageIndex hierarchy both available.

Any failed gate produces a JSON report with `status: "failed"` and a non-zero
process exit. Completed derivation directories remain on disk so the failure
can be inspected. Within one invocation, a retry receives the immediately
preceding run's checkpointed stage directory; it does not blindly trust it or
inherit one from the caller. Internal state stays under `derive-state`; only
Markdown under `derive-output` is public Context.

To exercise recovery across separate invocations, pass the retained run
explicitly:

```sh
pnpm evaluate:context-repository -- \
  --repo-dir /absolute/path/to/repository \
  --repository owner/name \
  --resume-run /absolute/path/to/jina-local-derive-previous
```

The first attempt then seeds only validated public pages, orchestration, and
`derive-state/agent-stages` from that run. Repository/ref/commit and per-stage
input digests still have to match; an invalid completed stage is repaired from
its last valid dependency checkpoint rather than silently reused.

## Report

The successful JSON report records:

- repository, ref, exact commit, retained run path, and public output path;
- manifest/evidence/history/provider input counts;
- each committed document's path, kind, revision, word count, citation count,
  history citations, and distinct source paths;
- dynamic subject, page, maintenance-question, worker, critic, area, and gap
  metrics;
- the complete static quality-benchmark result;
- release capabilities and projector statuses; and
- PageIndex adapter, node, root, depth, and represented-document metrics.

The report plus retained run is the evidence unit to compare across Jina,
VectifyAI/PageIndex, VectifyAI/OpenKB, and later incremental runs.

## No-model input test

The collection layer has a deterministic test that proves it reads committed
Git objects instead of dirty working-tree bytes, bounds history, calculates
HEAD changes, preserves executable and symlink metadata, and omits binary
content. The same suite proves the default 70/30 budget allocation, explicit
resume-flag parsing, and that attempt two sees exactly the preceding run's
stage directory while the environment is restored after success or failure:

```sh
pnpm test:context-repository-harness
```
