# Agentic context derivation

Context derivation is a dynamic Board workflow, not a fixed
`ingest -> derive -> index` stage. Codex owns repository-specific investigation,
organization, writing, challenge, and repair. The host owns identity, evidence,
authorization, task durability, artifact integrity, citation checks, repair bounds,
certification, and atomic publication.

The production workflow is:

```text
build-context
├─ snapshot-context-input
├─ plan-context-research
├─ research-context-subject × dynamic N
├─ plan-context-publication
├─ context-page × dynamic N
│  ├─ write-context-page
│  ├─ audit-context-page
│  └─ repair-context-page + replacement audit × bounded passes
├─ challenge-context-sources
├─ evaluate-context-tasks
├─ repair-context-gaps × bounded passes
├─ certify-context-release
├─ publish-context-release
└─ index-context-release
```

Every dispatchable agent task is one fresh Codex invocation in one bounded sandbox.
The Board—not a lead model—owns parallel fan-out, joins, retries, checkpoints, and
recovery. The local Board runner disables nested multi-agent orchestration. Production
uses the same task and artifact envelope with a Daytona sandbox.

## Local and production executors

Local Board development explicitly selects:

```text
CONTEXT_BOARD_EXECUTOR=local
CONTEXT_CODEX_AUTH=session
CONTEXT_CODEX_MODEL=gpt-5.6-terra
CONTEXT_CODEX_EFFORT=low
```

Production requires `CONTEXT_BOARD_EXECUTOR=daytona` and fails closed if a suitable
Daytona image or snapshot and organization model-Secret name are absent. Both executors
receive the same immutable repository archive, declared dependency artifacts, output
manifest, task/attempt identity, cancellation signal, and result-envelope schema.

When V1 model routing is configured, each production task resolves a write-once
tenant/build execution profile from V1. The profile selects the Context model,
low/medium/high effort, provider credential revision, and explicit `fail_notify` or
managed fallback policy. A cached profile is stable across the build's checkpoint
retries. Tenant credentials are redacted, held only in worker memory long enough to
provision the private ephemeral sandbox, and never enter Board metadata, artifacts,
prompts, or public Context.

The repository snapshot is read-only. Network access, browser tools, plugins, and
ambient repository instructions are unavailable to the agent. Each task can write only
its declared output files. Repository and provider content is untrusted data, never
instructions.

## Dynamic research and publication

The research-planning agent receives the engineering-documentation goal and exact input
snapshot. It discovers repository-specific subjects and maintenance questions without a
host-prescribed taxonomy. Subjects can include features, flows, components, interfaces,
state, security, operations, decisions, history, and recurring patterns. Discovery moves
between source, tests, configuration, Git metadata, commits, pull requests, and issues so
history is considered while the current behavior is being understood.

The API validates the plan and expands one bounded `research-context-subject` task per
accepted work specification. Those tasks can execute in parallel. Their immutable
reports join at `plan-context-publication`, where another agent organizes a coherent
engineering-documentation tree and a catalog of realistic maintenance tasks.

The publication plan is repository-specific. It does not require a document count,
minimum word count, or fixed directory layout. It must map every required subject,
maintenance task, and relevant repository area to supported pages or a concrete
exclusion. The Board validates it before creating page aggregates.

## Page generation, challenge, and repair

One page is the normal durable work unit:

1. A page writer receives the page specification, bounded research, the exact snapshot,
   and relevant prior context.
2. The host validates the Markdown, paths, evidence identities, ranges, and artifact
   scope.
3. An independent citation-audit task checks every emitted core-claim citation
   exactly once against its bound excerpt. When one compound assertion needs
   complementary sources, the auditor requires their exact excerpts to support the
   assertion collectively and requires every link to contribute material support;
   it does not require each excerpt to prove the whole assertion independently.
   Writers normally use one decisive anchor in the lead and one per substantive
   section, increasing to two or at most three only for distinct high-impact claims
   that genuinely require different sources; connective prose is assessed holistically by the
   context-only critic rather than converted into artificial per-sentence citation
   work. A table whose rows share the same focused implementation ranges is
   normally grounded once in its framing prose instead of repeating that target
   in every row.
4. Unsupported claims create a bounded repair task and a replacement audit; valid
   sibling pages remain untouched.

A repository-wide gap repair may make two small citation-repair attempts across
three audits. Its first pass reuses exact supported bindings from unchanged
validated page checkpoints. Every later global repair binds both independent gates
to the exact preceding draft and carries that draft's complete supported audit
forward. Audits within the repair likewise reuse unchanged supported claim groups,
so only unsupported or changed groups return to the model. This gives a repair
that makes partial progress another chance without paying to re-audit the rest of
the context tree.

After all page aggregates pass, two independent gates run:

- `challenge-context-sources` compares the candidate public bytes with the exact source
  snapshot to find omissions, contradictions, and unsupported conclusions.
- `evaluate-context-tasks` receives only candidate context and attempts the planned
  change, debugging, extension, and failure-triage tasks. It must identify the pages
  actually used and any blocking unknowns.

The context-only critic respects the captured-evidence boundary. A current provider
or control-plane state may remain explicitly unverified when Context names the
authority, gives concrete checks, and explains the safe decision for each result.
The critic blocks unsupported assertions or missing verification paths; it does not
force a writer to fabricate external state. It also judges whether Context makes the
requested maintenance work actionable, not whether that work is already complete:
a task to add a missing test or implementation passes when the current behavior,
change points, invariants, consequences, and verification plan are sufficiently clear.
The source challenger uses the same boundary. It does not invent a new blocking task
merely because the catalog lacks a duplicate focused question or the repository lacks
the proposed test or implementation when the public Context already makes that work
actionable.

A material finding creates a Board-visible `repair-context-gaps` pass followed by fresh
challenge and evaluation tasks. Certification always depends on the newest pass. Repair
limits are explicit: automatic orchestration stops after three global passes. Exhaustion
preserves the candidate draft, completed pages, evidence, and gate checkpoints without
publishing. After an operator fixes the underlying prompt, validator, model, or worker
defect, one explicit request can add one more repair/challenge/evaluation pass from
those checkpoints; it does not restart repository research or page writing.
Automatic repair passes must change the public snapshot so a no-progress loop fails
closed. An operator remediation pass may retain identical certified page bytes when
the corrected defect was in a gate prompt, validator, model, or worker; the fresh
gates still bind and reevaluate that exact snapshot.

Each expensive model boundary also records an immutable, input-digest-bound phase
checkpoint before host validation or the next model call. This includes research,
planning and bounded corrections, page writing and repair, citation-audit batches,
source challenge, task evaluation attempts, and global gap-repair/audit passes. If an
attempt loses its lease or reaches its per-task time limit after recording one of these
artifacts, the next fenced attempt reloads it and continues with host validation or the
next unfinished phase instead of paying for the completed call again. A checkpoint is
never reused when its exact source artifacts, public snapshot, contract version, or
repair diagnostic changes.

Page audit does not serialize deterministic cleanup ahead of semantic citation review.
When a page has source-bound references within the host limit, the worker audits those
valid references in the same pass even if other links, navigation, or section coverage
have deterministic defects. The resulting repair receives both finding sets together;
later passes reuse exact digest-bound verdicts. Empty and over-limit inventories remain
model-free and fail closed.

## Inputs

The immutable input snapshot contains:

| Input                           | Purpose                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------- |
| Repository archive and manifest | Exact commit bytes, paths, Git blob identities, and content digests          |
| Git metadata                    | Commit graph, changed paths, authorship, and bounded history                 |
| Provider observations           | Captured repository, pull-request, issue, and other permitted GitHub records |
| Trigger provenance              | Exact push, PR, or issue event that admitted the build                       |
| Prior release                   | Latest eligible derived context and citations for the same ref               |
| Same-build checkpoints          | Valid plans, research, pages, and audits from earlier attempts               |
| ACL and frontier state          | Authorization fingerprint and declared evidence completeness                 |

The snapshot boundary is intentionally thin. It does not build a source search corpus,
symbol graph, import graph, dense index, or public raw-evidence store. It exists because
citations, stale-write rejection, reproducibility, and recovery require an immutable
commit-bound identity.

## Public output contract

The public catalog contains only repository-specific Markdown engineering
documentation. `architecture.md` is the repository-level entry point; other paths are
stable logical document IDs chosen from repository terminology. Plans, prompts, reports,
transcripts, task receipts, audit results, and checkpoint metadata are private artifacts
and never appear in the catalog.

Every public page must:

- start with one level-one heading and a useful lead summary;
- explain an engineering subject or maintenance task rather than mirror files;
- include the architecture, behavior, interfaces, invariants, failure modes,
  operations, history, and change guidance that are relevant to that subject;
- cite at least one exact repository or captured provider source;
- use natural reader-facing link labels and ordinary relative links between context
  pages; and
- be reachable from `architecture.md`.

Example:

```markdown
# Cache expiry lifecycle

The cache removes expired entries before returning a lookup result.

## Verification

Check the [expiry guard in the lookup path](src/cache.ts#L11-L14).
```

The host does not accept empty template sections or prose length as a quality signal.
Semantic challenge and realistic maintenance-task evaluation determine whether the
organization is useful.

## Citation contract

Repository links use GitHub-style line anchors. The host resolves each target against
the exact checkpoint manifest and verifies path membership, blob identity, content
digest, line bounds, and the selected source excerpt. Natural GitHub commit, pull
request, issue, and observation URLs must resolve to exactly one captured provider
record.

An independent model audit judges whether the nearby assertion is supported by the
exact excerpt. Audit batches are deterministically bounded and digest-bound to the
repository checkpoint, public snapshot, and complete citation set. Every citation ID
must be returned exactly once. A page with an invalid or unsupported material citation
is withheld as a whole and may enter the bounded repair loop.

Generated context never cites another generated page as original evidence. Relative
context links are navigation only.

## Checkpoints and recovery

Board rows contain bounded control state: task type and identity, tenant/repository/ref,
dependencies, status, attempt, lease and write fence, input/output digests, timestamps,
errors, and immutable artifact references. Large content lives in GCS in production and
the contract-equivalent filesystem store locally.

Artifacts are create-only under:

```text
context-v2/tenants/<tenant>/repositories/<repository>/builds/<build>/<kind>/<name>
```

If a process or sandbox fails:

- completed snapshot, plan, research, sibling-page, and audit tasks remain complete;
- an expired lease can be reclaimed with a fresh attempt and fence;
- a matching immutable artifact can be reused;
- a stale worker cannot attach a late result or publish; and
- operator retry can reopen an atomic task batch and its blocked descendants without
  discarding unrelated checkpoints.

Valid page checkpoints are visible as unpublished build progress. They are not queryable
context. Only final certification and fenced atomic publication create a release.

## Certification and atomic publication

Certification binds:

- tenant, repository, ref, commit, and admitted ref sequence;
- the complete ordered publication catalog and public snapshot digest;
- every final page and citation-audit digest;
- the maintenance-task catalog and latest passing evaluation;
- the latest source challenge; and
- the worker receipt and schema versions.

`publish-context-release` rereads the certified immutable artifacts, reconstructs and
validates every page and citation, recomputes the public snapshot digest, and submits the
bundle to a fenced internal API operation. One PostgreSQL transaction creates the
immutable revisions/citations and complete release and advances the current pointer.
A stale ref sequence is rejected. Replay of the same certified input is idempotent;
different bytes under the same idempotency identity fail.

Publication is atomic. No page subset from an active, failed, or interrupted build is
queryable. The previous complete release remains available until the successor publishes.

## PageIndex and retrieval

After publication, the worker passes only the derived Markdown release to the
self-hosted PageIndex implementation pinned to
`982514ab40fe42a169ea087c13819cf87c87724f`. The PageIndex source and Python runtime are
embedded in the worker image, not the API image. The worker uploads the immutable tree
and calls the API's fenced attachment operation. Private repository context is never
sent to PageIndex Cloud.

At query time, `search_context` uses bounded deterministic lexical scoring over the compact
derived-context tree. It selects existing node IDs, hydrates derived context and citations,
and never invokes a model or writes an answer. `list_context`, `read_context`, and
`diff_context` are deterministic as well.

## Full and incremental behavior

A cold build researches the exact repository and relevant captured history. A later
branch commit, PR head, or newly opened issue creates a newer Board build for the
appropriate ref. Prior published context is an input, not mutable state: agents inspect
changed paths and triggering provider records, retain still-supported subjects, revise
affected pages, add newly supported pages, and omit retired material from the complete
successor catalog. `retain` is only a byte-identical optimization: if deterministic
validation finds that any immutable citation binding changed, the host promotes that page
to `revise` before writing begins. This is constraint enforcement rather than a content
decision and prevents an unwinnable downstream citation-repair loop.

The trigger itself is provenance, not evidence. A PR or issue is cited only when its
captured contents support a material current claim. Issue comments, reviews, labels,
edits, and close events do not schedule builds.

## Validation evidence

Focused tests cover Board graph expansion, retry/fencing, page audit and repair, global
challenge/evaluation and repair, certification, atomic publication, PageIndex
attachment, trigger policy, tenant tokens and ACLs, the five HTTP retrieval routes, the
exact four MCP tools, dashboard/admin consumption, and the retained acceptance harnesses.

Production acceptance uses the Board-native deployment and surface harnesses described
in `DEPLOYMENT.md`; no separate filesystem derivation runtime is retained.
