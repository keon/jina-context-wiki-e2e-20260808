# Derived context implementation plan

Status: implementation is source-complete for the production architecture and
local acceptance is in progress. Focused and workspace validation are green at
the current working revision. A clean retained Jina Board run has not yet
produced a terminal acceptance report; representative-repository, Daytona, and
production acceptance and deployment remain open.

This document records the architecture decisions, implementation status, validation
evidence, and remaining rollout work for the derived-context reset.

For an empty-context continuation, current implementation truth, exact retained-run
locations, remaining acceptance and rollout work, validation commands, and the completion checklist,
read [`CONTEXT_V2_CONTINUATION_RUNBOOK.md`](CONTEXT_V2_CONTINUATION_RUNBOOK.md).
Where older status prose in this plan conflicts with that runbook, the runbook is
authoritative for current completion status; this plan remains authoritative for the
product decisions.

## Product contract

Jina builds repository context similar in purpose to DeepWiki or Code Wiki, but the
product term and public surface are **context**.

Only citation-valid derived context is searchable. Repository files, commits, pull
requests, and issues are immutable evidence used during derivation and citation
verification.

Retrieval returns context packs for coding and review agents. It does not synthesize an
answer.

## Final architecture

```mermaid
flowchart LR
    GH["New commit, PR head, or issue"] --> E["Thin immutable evidence snapshot"]
    E --> C["Codex derives Markdown context"]
    C --> V["Host validates every link and page"]
    V --> K["Checkpoint private page work"]
    K --> P["Prepare complete immutable release"]
    P --> T["Build self-hosted PageIndex Markdown tree"]
    T --> Q["Atomically attach tree and advance public release"]
    Q --> S["Model selects tree nodes"]
    S --> API["HTTP and four MCP tools"]
    API --> A["Calling agent reasons over context"]
```

### Model use

Models are used only to derive and verify Context during builds. Public querying is
model-free: `search_context` uses deterministic lexical tree scoring and list, read, and
diff are direct immutable-release operations. No retrieval route writes an answer.

### PageIndex

The open-source PageIndex Markdown implementation is self-hosted and pinned to commit
`982514ab40fe42a169ea087c13819cf87c87724f`.

The local bridge receives only citation-valid derived documents. Jina retains:

- tenant and repository authorization;
- stable internal IDs;
- immutable release state;
- citation anchors;
- artifact ownership; and
- failure/fallback policy.

No private repository context is sent to PageIndex Cloud.

OpenKB is an interface and workflow reference only. It is not a runtime dependency.

## GitHub and branch policy

Build triggers:

- branch push with a new head;
- pull request `opened`;
- pull request `synchronize` with a new head; and
- issue `opened`.

No build is scheduled for comments, reviews, edits, labels, closes, or other provider
events.

The request key is carried into derivation as provenance. A PR- or issue-triggered build
therefore tells Codex which exact provider record caused the run. Codex must inspect that
record and cite it when it adds supported maintenance context, but the trigger is never
treated as evidence by itself.

Refs:

- the default branch is canonical;
- other pushed branches keep their branch ref;
- PR previews use `pull/<number>/head`;
- issues build the default branch.

## Build and checkpoint policy

The task board is the only production workflow authority. A build is one aggregate root
whose children are created as the agent discovers bounded work:

```text
build-context
└─ snapshot-context-input
   └─ plan-context-research
      ├─ research-context-subject × N
      └─ plan-context-publication
         ├─ context-page × N
         │  ├─ write-context-page
         │  ├─ audit-context-page
         │  └─ repair-context-page / audit-context-page × bounded N
         ├─ challenge-context-sources
         ├─ evaluate-context-tasks
         ├─ certify-context-release
         └─ publish-context-release
            └─ index-context-release
```

The graph is dynamic rather than a fixed list of repository subjects. Research, page,
repair, and evaluation tasks are created only from validated agent plans or audit
results. Every required dynamic child gets a root-completion edge, so the aggregate
cannot finish while discovered work is missing.

`snapshot-context-input` is a thin deterministic boundary, not an interpretation or
retrieval stage. It records the manifest, file bodies needed for citations, Git
metadata, bounded provider observations, frontiers, ACL state, and completeness. This
minimal snapshot cannot disappear: an immutable input identity is required to validate
citations, reject stale worker writes, and resume work reproducibly.

Codex first produces a durable research plan. The Board validates that plan and fans it
out into bounded subject-research tasks. A publication planner uses the research
artifacts to propose the document catalog, after which the Board creates one aggregate
per page with separate write, audit, and bounded repair tasks. Each dispatchable agent
task is a fresh Codex/sandbox invocation; Codex chooses how to investigate its bounded
goal rather than following a fixed repository taxonomy or research script. The plan
tracks evidence-backed subjects
spanning features, flows, components, interfaces, state, security, operations, decisions,
history, and patterns. For each subject, the research planner dynamically derives realistic
maintenance questions from entrypoints, state changes, boundaries, tests, failures,
operations, change hotspots, and relevant history. Subject discovery moves between
current implementation evidence and Git/provider history rather than treating history
as a final appendix.

After drafting and a tiered source-aware citation audit, a critic begins with only the candidate
public context and recorded questions. It
attempts realistic change, debugging, failure, and extension tasks, then reports shallow,
contradictory, or unanswerable questions. The host requires a grounded lead and every
substantive section to contain a core evidence binding, while the auditor checks
consequential architecture, behavior, API/configuration, security/tenancy,
state/invariant, failure/recovery, numeric/default, and history claims. Connective prose
and descriptive labels are not converted into per-sentence audit work. Writers target
one decisive source link in the lead and one per substantive section, increasing to
two or at most three only for distinct high-impact claims; this is
an evidence budget, not a hard maximum or permission to leave a high-impact assertion
unsupported. Complementary evidence links attached to one compound assertion are
audited together, while every member must contribute real support; this avoids the
false requirement that each excerpt independently prove the entire compound claim. A
parallel source challenger checks the exact
snapshot. Material findings create Board-visible repair and successor gate tasks. This
separation gives critic and challenger tasks fresh context and durable retry boundaries.
Automatic global repair stops after three passes. A terminal global-quality failure
retains the latest candidate and gate checkpoints and cancels certification. Once the
underlying defect is corrected, an administrator can add one more
repair/challenge/evaluation pass without repeating discovery, research, or completed
page work.

The plan records stable subject, question, page, worker, review, and gap IDs; source
signals and priorities; question-to-page answers; subject-to-page mappings; deterministic
repository-area coverage; worker roles; completed critic reviews; and blocking/advisory
gaps. It is stored independently of pages with its own digest and monotonic sequence. On
retry, the latest plan and valid pages are both restored, but citation-valid pages are
reopened when their maintenance questions remain unanswered or the prior review no longer
applies to changed behavior.

Provider responses cross an allowlist boundary before snapshot creation. Only bounded
repository, issue, pull-request, and discussion facts used for research are retained;
operational clone URLs, temporary installation tokens, authorization fields, and nested
provider credentials never enter immutable artifacts or agent inputs.

Each page is parsed and validated independently:

- structurally valid pages are pending resumable checkpoints and do not publish before final certification;
- invalid pages retain diagnostics and are withheld;
- identical progress is idempotent;
- changed pages increment a sequence;
- retries seed valid checkpoint pages over prior context; and
- a claimed complete output publishes a complete release only after host checks confirm
  internal consistency: required question answers and critic review references, required
  items, area coverage, captured-history accounting, terminal workers/reviews, and no open
  blocking gaps.

The agent owns semantic depth and the repository-specific acceptance questions. The host
does not prescribe document headings or use word count as a quality proxy.

This avoids the all-or-nothing failure mode where a long derivation produces nothing.

### Board state and artifact state

Board rows contain orchestration data only: task identity and type,
tenant/repository/ref scope, input and output digests, GCS artifact references, status,
dependency edges, attempt number, lease identity, timestamps, and a bounded error
summary. Prompts, evidence, reports, page bodies, transcripts, audit payloads, and
private checkpoints are immutable GCS objects and are never embedded in board metadata.

Worker result envelopes are versioned and task-typed. The API validates their artifact
references against the task's tenant, repository, and build before it records a
completion. Snapshot, research-plan, publication-plan, and unsupported page-audit
completions expand the next graph segment in the same board transaction that records the
result and terminal transition. A dependent claim receives the bounded artifact results
of its completed dependency closure, never their embedded content.

Leased board workers use internal artifact upload/read routes. Uploads are named by task
and attempt, must use the artifact kind assigned to that task type, and are accepted only
while the attempt/lease/token fence is current. A stale attempt may leave an unreferenced
immutable object but cannot attach it to the board or publish it. Both the GCS and local
adapters are create-only and treat a same-key/different-digest write as a collision.

One page is the normal durable work unit. A page writer, source-aware citation audit, and
any repair/audit iterations are independently retryable sandbox calls. A process loss
returns an expired lease to the same task; a valid digest-bound output is reused. A
semantic audit failure creates bounded repair work instead of failing the whole build.
Execution failure exhausts the affected task's retry policy without discarding verified
sibling pages.

The historical filesystem ledger is only a local acceptance adapter for exercising
artifact contracts without PostgreSQL and GCS. It is not a production scheduler and the
production execution path does not use it.

Progress endpoints may expose verified checkpoints from the active build, but
`search_context`, `list_context`, `read_context`, and `diff_context` resolve only an
atomically published release. `publish-context-release` prepares fenced immutable release
rows after final source challenge, context-only task evaluation, citation certification,
and verification of the complete unchanged public snapshot. `index-context-release`
attaches the verified PageIndex hierarchy and advances the public current pointer in the
same fenced PostgreSQL transaction. There is no query-visible release without its tree.

## Citation contract

Repository citations are ordinary Markdown links with exact line anchors:

```markdown
[lease expiry releases the row](packages/db/src/outbox.ts#L120-L128)
```

GitHub citations use natural provider URLs:

```markdown
[Operators need separate hit and miss counters](https://github.com/acme/cache/issues/2)
```

The host resolves and validates:

- manifest path and blob SHA;
- source identity and content digest;
- line range or provider JSON pointer;
- exact claim support; and
- tenant/repository/checkpoint scope.

A page with any invalid evidence link or no evidence link is not published.

## Public API and MCP

HTTP retrieval:

```text
POST /context/search
GET  /context/releases
GET  /context/list
GET  /context/read
GET  /context/diff
```

MCP exposes exactly:

```text
search_context
list_context
read_context
diff_context
```

Old answer-synthesis and raw projection routes are removed from the public server and
dashboard.

## Tenant tokens

Both HTTP and MCP support tenant/principal-scoped credentials.

Per-principal tokens:

- use `jina_atk_…` random secrets;
- store only a SHA-256 secret hash;
- bind one tenant and principal;
- carry explicit read/query/build/admin scopes;
- expire;
- can be revoked immediately; and
- recheck repository ACL on every request.

Static production credentials remain server-bound and cannot be retargeted with identity
headers.

## Artifact policy

Production artifacts use GCS. Object keys include tenant, repository, build, kind, and
name. Writes are immutable/create-only and carry SHA-256 metadata.

Stored artifact classes:

- evidence snapshot;
- research, plan, page, audit, repair, and certification checkpoints;
- context release bundle; and
- PageIndex tree.

Local development uses a filesystem implementation with the same key layout.

## Human governance

Direct editing of generated context files is not supported.

Owners may:

- inspect citations and build diagnostics;
- invalidate or reject a revision;
- rebuild the latest checkpoint;
- compare releases; and
- erase underlying evidence under the existing erasure/audit controls.

Regeneration is the correction mechanism.

## Reset policy

No rebuildable context-data compatibility is required.

Preserve:

- tenant and repository registrations;
- GitHub repository mappings;
- ACL observations;
- API token hashes;
- erasure filters; and
- audits.

Delete:

- evidence snapshots and materialized Git data;
- derivation runs, page checkpoints, revisions, and citations;
- releases and projections;
- outbox/checkpoint state; and
- retrieval telemetry.

The reset CLI is dry-run by default and requires an exact execution confirmation.

## Implementation status

### Complete

- Thin ingestion with structural parsing removed from the active pipeline.
- Codex Markdown derivation with local current-session execution.
- Durable Board-owned planning, agent-discovered maintenance questions, bounded
  research and critic tasks, context-only review/repair, and host-checked artifact
  consistency.
- Terra low defaults for local derivation and tree selection.
- Per-page private checkpoints, validation diagnostics, and resumability with atomic
  full-release publication only.
- Generic Board terminal-root reconciliation, including cancellation of unfinished
  descendants, retirement of pending or leased delivery fences, quota settlement, and
  safe atomic operator retry from preserved checkpoints.
- Completion ordering that records the terminal page audit or global gate as `done`
  before its bounded-exhaustion policy fails the page/build and cancels remaining work.
- Prior-release admission seeds, bounded agent access to the exact immutable prior
  release, and host-enforced retain/revise/add/retire accounting for incremental builds.
- Natural repository and GitHub citations with page-level withholding.
- Immutable derived-only releases.
- Self-hosted pinned PageIndex Markdown worker and TypeScript adapter.
- Prepared publication plus PageIndex attachment and public-pointer advancement in one
  fenced transaction, eliminating the former query-visible unindexed interval.
- Deterministic bounded lexical search over the published PageIndex tree.
- HTTP release/search/list/read/diff surfaces.
- Exact four-tool MCP surface.
- Tenant/principal token scopes and repository ACL enforcement.
- Filesystem and GCS artifact stores.
- Context-data reset CLI.
- Commit/PR/issue trigger and ref policy.
- Repository dashboard context explorer and build checkpoint view.
- Tenant admin release and citation view.
- Tenant-admin single/batch retry APIs, retry-eligibility projection, and local watcher
  recovery using stable request keys.
- Three-hour derivation and acceptance envelopes for the measured Jina-sized workflow.
- Portable local/Daytona task envelopes, production Daytona-only execution, immutable
  sandbox and organization-Secret validation, and live Codex toolchain preflight.
- Coordinated deployment gating that validates externally bootstrapped GCP resources,
  Daytona, Cloud SQL, GCS, images, and secrets before cloud mutation or traffic cutover.
- Production acceptance code migrated to release/search/four-tool contracts.
- Authoritative architecture, data model, derivation, sequence, token, and deployment
  documentation.

### Historical filesystem-harness validation complete

The earlier local filesystem harness:

1. created a temporary sample repository;
2. performed full initialization with issue history;
3. generated three citation-valid context documents using the current Codex session,
   `gpt-5.6-terra`, and low reasoning;
4. built the self-hosted PageIndex hierarchy;
5. added a second commit, PR #7, and issue #2;
6. generated an incremental release grounded in the old issue, new issue, and new PR;
7. selected metrics and expiry context through deterministic lexical tree search;
8. verified that search returned no answer;
9. exercised page-level withholding for one stale line citation while retaining the
   other valid pages;
10. diffed the immutable releases.

This remains useful contract evidence, but it is not proof of the Board-native Jina
build, atomic publication, production PageIndex attachment, or deployed surfaces.

Focused suites cover engine, API/MCP, GitHub triggers, dashboard, admin, worker acceptance,
artifact keys, type checking, and dead-code detection.

## Remaining production rollout

The worker image embeds the pinned PageIndex source and Python runtime. The API image
embeds the Codex CLI but does not contain PageIndex or Python. Shared GCP resources,
including the GCS artifact bucket, service accounts, IAM bindings, Cloud SQL, and
secrets, are an explicit platform-bootstrap prerequisite. The coordinated deployment
fails before cloud mutation when that contract, the immutable Daytona sandbox,
organization model Secret, or Codex toolchain probe is missing. It does not silently
create long-lived shared infrastructure.

Remaining acceptance is deliberately ordered:

1. Finish the clean retained Board-native Jina cold build and retain its Board,
   certification, release, PageIndex, quality, retrieval, API/MCP, dashboard,
   and admin evidence. The configured three-hour envelope is implemented; its
   adequacy and the successful cold duration still need measurement.
2. Run Jina interruption/resume, additional commit, PR, issue, and issue-comment
   no-op cases. Prove checkpoint reuse and retain/revise/add/retire behavior from
   the published prior release, then run the representative-repository matrix.
3. Supply Daytona access and run the same full/incremental fixture there using the
   explicitly authorized current Codex session.
4. Execute the rebuildable-context reset against the intended production database after a
   reviewed dry run.
5. Complete the documented platform bootstrap and preflight, then deploy API,
   workers, dashboard, and admin from one immutable revision without moving
   traffic before acceptance.
6. Run production acceptance with a real GitHub App installation, bound non-admin reader
   token, HTTP search, and all four MCP tools.
7. Canary one tenant/repository and monitor page-validation failure rate,
   unpublished-checkpoint age, lexical retrieval miss rate, PageIndex failures, citation
   count, and backlog.

## Definition of done

The rollout is done when:

- only derived cited context is publicly retrievable;
- full and interrupted builds both preserve valid work;
- retries resume from checkpoints;
- new commits, PR heads, and issues update the correct refs;
- comments do not trigger builds;
- PageIndex and Codex run on approved infrastructure;
- search returns context rather than an answer;
- the four MCP tools are the only MCP surface;
- tenant tokens cannot cross tenant, principal, scope, or repository boundaries;
- dashboard and admin show the same immutable release state;
- the old rebuildable corpus has been reset; and
- local, Daytona, and production acceptance all pass.
