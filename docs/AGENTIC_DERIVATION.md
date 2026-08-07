# Agentic Context derivation

Context uses a page-oriented Board workflow. The Board owns admission, durability,
leases, retries, dependency expansion, quotas, and publication authority. Codex owns
repository-specific investigation, organization, and writing inside bounded execution
phases. The host validates every artifact and citation before it can enter a release.

## Active workflow

The active graph has four claimable worker topics:

```text
build-context (aggregate)
├─ snapshot-context-input       -> run-context-input-snapshot
├─ plan-context-pages           -> run-context-page-plan
├─ build-context-page × N       -> run-context-page-build
└─ publish-context-release      -> run-context-publication
```

`context-build-graph` is a non-dispatchable latch that keeps the aggregate open while
the planner materializes page tasks. The planner and publication depend on the snapshot;
each generated page depends on the planner; publication depends on every page
disposition.

The old research, write, audit, repair, challenge, evaluation, certification, and
PageIndex queue topics are not claimable. A locked production preflight rejects a
nonterminal old-graph build or a pending/leased old Context outbox message before a
candidate release can cut over.

## Checkpointed phases inside durable tasks

The four-topic graph does not collapse all model work into one opaque call. Expensive
phases write create-only, input-digest-bound artifacts and can be reused by a fenced
retry of the same durable task.

The planner task performs, in order:

1. repository-specific research planning;
2. bounded subject research for each validated assignment; and
3. publication planning, including stable page paths and `add`, `retain`, `revise`, or
   `retire` operations.

Subject research is currently sequential inside one planner lease. Page construction
fans out only after that plan completes.

Each `build-context-page` task performs:

1. page writing or prior-page retention;
2. deterministic structure and citation validation;
3. one independent semantic citation audit; and
4. when required, one repair and one replacement audit.

The page result has an explicit disposition:

- `accepted` attaches the validated page artifact and its evidence/generation
  fingerprints;
- `omitted` records a bounded reason when a new page cannot be supported; and
- during publication, an unsupported revision retains the prior validated page instead
  of silently deleting established Context.

There is no active operator path that appends old multi-topic global gap-repair or
certification work. See [Retired multi-topic remediation](CONTEXT_PAGE_REMEDIATION.md)
for the migration boundary.

## Input boundary

The immutable snapshot contains:

| Input                           | Purpose                                                             |
| ------------------------------- | ------------------------------------------------------------------- |
| Repository archive and manifest | Exact commit bytes, paths, Git blob identities, and content digests |
| Git metadata                    | Bounded commit history, parents, and changed paths                  |
| Provider observations           | Allowlisted repository, pull-request, issue, and comment records    |
| Trigger provenance              | Exact push, pull-request, issue, or manual admission identity       |
| Prior release                   | Latest eligible derived Context for the same ref                    |
| ACL and frontier state          | Authorization fingerprint and evidence completeness                 |

The snapshot is evidence, not a public search corpus. It does not build embeddings, a
symbol graph, an import graph, or a raw-source index.

## Local and production executors

Local Board development selects the local executor and can use the signed-in Codex
session:

```text
CONTEXT_BOARD_EXECUTOR=local
CONTEXT_CODEX_AUTH=session
CONTEXT_CODEX_MODEL=gpt-5.6-terra
CONTEXT_CODEX_EFFORT=low
```

Production requires the Daytona executor, an approved image or snapshot, and an
organization model-secret name. Both executors receive the same immutable repository
archive, declared dependency artifacts, task/attempt identity, cancellation signal,
output manifest, and result-envelope contract.

The repository is read-only. Browser access, plugins, ambient repository instructions,
and unrestricted network access are unavailable. Repository and provider content is
untrusted data. Credentials remain outside Board metadata and artifacts and are injected
only into the private ephemeral sandbox selected by the write-once execution profile.

## Citation and page contract

Public output is repository-specific Markdown. `architecture.md` is the entry point;
other document paths are stable logical IDs chosen from repository terminology.
Research plans, prompts, reports, audit results, receipts, and checkpoint metadata stay
private.

Repository links use ordinary Markdown and GitHub-style line anchors:

```markdown
[Expired entries are removed](src/cache.ts#L11-L14)
```

Before accepting a page, the host verifies artifact scope, manifest membership, blob and
content digests, inclusive line ranges, provider-record identity, and document
structure. The semantic auditor receives the exact nearby assertion and captured
excerpt. Unsupported core claims cannot be published from that candidate.

Generated pages may link to one another for navigation, but another generated page is
never original evidence.

## Publication

The publication task rereads the publication plan and every page disposition. It:

1. selects accepted pages;
2. copies byte-identical retained pages from the prior release;
3. retains prior bytes for unsupported revisions and records omitted new pages;
4. removes navigation to omitted documents;
5. revalidates the complete derived-only catalog;
6. builds the pinned self-hosted PageIndex tree; and
7. calls the fenced internal publication transaction.

One PostgreSQL transaction creates the immutable release and advances the current pointer
only when its admitted `refSequence` is still current. Replay of identical input is
idempotent; a stale sequence or changed bytes under the same identity is rejected. The
previous complete release remains queryable until the successor commits.

PageIndex receives only validated derived Markdown. It never receives repository
credentials, raw evidence, or release authority. `search_context`, `list_context`,
`read_context`, and `diff_context` are deterministic and do not invoke a model.

## Recovery and limits

Every claim carries an attempt-bound renewable lease and write-fence token. A worker
that loses its lease cannot record a phase checkpoint, complete work, or publish late.
Matching completed phase artifacts may be reused; an unfinished call alone is repeated.

Each build also has an absolute time budget and model-token budget. Reaching either
limit fails the aggregate, retires remaining work, preserves completed private
checkpoints, and never partially publishes. Transient provider, sandbox, and transport
failures can consume bounded task retries. Deterministic contract failures remain
terminal until an ordinary eligible task retry is authorized.

## Source of truth

The workflow contract and task graph live in
`packages/context-engine/src/workflow/context-workflow.ts`. Queue topic names live in
`packages/shared-kernel/src/worker-topics.ts`, and worker execution lives in
`apps/worker/src/server.ts`. Those executable contracts take precedence over prose.
