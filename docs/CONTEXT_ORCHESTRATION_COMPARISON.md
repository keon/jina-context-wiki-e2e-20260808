# Context orchestration comparison

This comparison tests whether a Codex research lead with bounded subagents produces
better derived context than the previous single-agent prompt. It is a local experiment,
not a claim that orchestration is always better.

## Method

Both runs received the same immutable input from `omxyz/jina`:

- commit `23841553ebff18c272b7006ced98e733d88c375c`;
- 291 manifest entries;
- 1,450 source and provider evidence records;
- no prior context; and
- complete source availability.

Both used `gpt-5.6-terra` with low reasoning effort and the current Codex session. Both
outputs passed the same Markdown parser, exact citation verifier, host completion checks,
and self-hosted PageIndex tree builder. The only intentional derivation difference was
the v3 durable lead/worker orchestration contract.

The reported token totals come from Codex turn events. Orchestrated totals include the
lead and its workers. Wall time is observed end-to-end derivation time. This is one
stochastic pair, so the results establish behavior and expose tradeoffs; they do not
establish a statistically stable quality improvement.

## Results

| Metric                   | Single agent v2 | Lead and workers v3 |  Change |
| ------------------------ | --------------: | ------------------: | ------: |
| Documents                |               8 |                   8 |    0.0% |
| Words                    |           2,338 |               2,867 |  +22.6% |
| Valid citations          |              66 |                 113 |  +71.2% |
| Provider citations       |               0 |                   1 |      +1 |
| Git commit-history links |               0 |                   3 |      +3 |
| PageIndex nodes          |              19 |                  43 | +126.3% |
| PageIndex roots          |               8 |                   8 |    0.0% |
| Observed wall time       |           534 s |               588 s |  +10.1% |
| Input tokens             |         948,962 |           1,082,036 |  +14.0% |
| Cached input tokens      |         836,352 |             978,944 |  +17.0% |
| Output tokens            |          21,887 |              19,063 |  -12.9% |
| Collaboration tool calls |               0 |                   8 |      +8 |
| Collaboration failures   |               0 |                   0 |       0 |

The v3 plan contained eight page items, six required items, 22 deterministic repository
areas, three completed workers, and no blocking gaps. All required items resolved and all
areas were covered.

The host initially downgraded this exact output because `.env.example` was incorrectly
classified as code instead of configuration. The comparison found that implementation
bug. After correcting the classifier and adding its regression test, the retained
catalog revalidated as `complete`, with eight accepted documents and zero conversion
problems. No document or metric was regenerated for that recheck.

## Organization

The single agent produced:

```text
api/github-webhook-intake.md
architecture.md
board/task-scheduling.md
context/derivation.md
context/evidence-ingestion.md
context/projection-and-query.md
context/runtime-database-capabilities.md
runbooks/derivation-timeout.md
```

The orchestrated lead produced:

```text
apps/api-webhooks.md
apps/dashboard.md
apps/worker-runs.md
architecture.md
context-engine/derivation.md
context-engine/workflow-publication.md
review/pull-request-review.md
storage/postgres.md
```

The orchestrated catalog is more aligned with repository ownership boundaries and adds
dedicated dashboard, worker, pull-request review, and PostgreSQL pages. Its 43-node tree
has substantially more useful headings for PageIndex traversal. It also grounds recent
direction in commit history and one pull request, whereas the baseline uses no provider
history.

The reorganization is not an unconditional win. The baseline has dedicated pages for
task scheduling, evidence ingestion, projection/query, runtime capabilities, and
derivation timeout. V3 covers those concepts across architecture, derivation,
publication, worker, and storage pages, but their absence as first-class document paths
can make exact path discovery less obvious. The higher PageIndex node count helps tree
selection, but fixed real-question evaluation is still needed to show that this
organization retrieves the right context more often.

## Original-plan coverage

This catalog is not an acceptance result for the Context v2 implementation plan. It was
generated from committed checkpoint `23841553ebff18c272b7006ced98e733d88c375c`; the plan
and most of its implementation were uncommitted and therefore absent from the pinned
checkout, manifest, and evidence. The agent correctly could not document code it was not
allowed to see.

Against its own checkpoint, the catalog is strongly grounded: all eight documents passed
host validation with 113 citations and no conversion problems. Against the intended
Context v2 end state, its semantic coverage is only roughly one third:

- it satisfies repository-specific organization, cited Markdown, maintenance-oriented
  architecture and operations, and limited commit/PR history;
- it partly covers the three-stage build, validation, fencing, retries, and tenant-aware
  PostgreSQL boundaries; but
- it does not cover self-hosted PageIndex, deterministic lexical-tree search, the
  four MCP tools, the release/list/read/search/diff API, scoped API tokens, GCS artifacts,
  durable orchestration planning, bounded workers, coverage review, the new trigger/ref
  policy, context-data reset, or the new dashboard/admin context surfaces.

Some content is not merely absent but obsolete relative to the plan. The generated
architecture and publication pages describe a publicly usable raw-evidence baseline and
materialized manifest/fragment/structural indexes. Context v2 instead exposes only
citation-valid derived context. The derivation page also describes the older
fail-closed/no-revision behavior rather than independently checkpointed pages and partial
releases.

Formal plan coverage does not fix this temporal mismatch: the generated plan accounted
for 22 of 22 repository areas, but repository-area coverage is not equivalent to
capability coverage. A valid acceptance comparison requires a new immutable checkpoint
that actually contains the Context v2 implementation, followed by a fixed maintenance
question suite over the resulting catalog.

That finding led to orchestration contract v2's internal `subjects` inventory. Required
features, flows, components, interfaces, state, security, operations, decisions, history,
and patterns now carry exact current-source and typed Git/provider signals and must map
to completed pages. The agent discovers and revises these subjects while alternating
between current implementation and history. This improves the completeness control
plane, but does not retroactively change or rescore the comparison above.

## Incremental end-to-end result

A separate local fixture exercised a full initialization followed by a new commit, a new
pull request, and a new issue. Both the initial and incremental plans ended `complete`;
each published four cited documents and four PageIndex roots. The incremental catalog
grounded both captured issues and the pull request, and all four documents changed rather
than disappearing.

The same run verified:

- immutable release listing, document listing and reads, search, and release diff over
  HTTP;
- tenant-bound MCP authentication, including rejection without a token;
- exactly `search_context`, `list_context`, `read_context`, and `diff_context`;
- deterministic PageIndex tree selection with no generated answer; and
- model-free list, read, and diff behavior.

## Goal-driven current-checkpoint result

A later experiment replaced the procedural research script with a compact maintenance
goal, an exact artifact contract, and a host-driven verification loop. Unlike the
controlled comparison above, this run used a synthetic immutable snapshot of the current
Context v2 worktree:

- commit `3b5e2993f8da820fd4e37dbb9549ce8eba3f0c8c`;
- 305 manifest entries;
- 1,162 source and provider evidence records;
- 807 provider observations; and
- recovered context and plan checkpoints from preceding attempts.

The accepted attempt produced 13 engineering-document pages, 2,555 words, 96 valid
citations, 45 PageIndex nodes, and 13 PageIndex roots. Its plan ended `complete` with 13
items, six subjects, 24 of 24 deterministic areas accounted for, one commit-history
signal, no workers in the final resumed attempt, and no open gaps. The accepted attempt
took 533 seconds and reported 1,039,642 input tokens, of which 893,184 were cached, plus
16,995 output tokens. Those cost numbers exclude preceding checkpoint-building attempts
and therefore are not a total experiment cost.

The checkpoint progression matters more than the final green state:

| Checkpoint               | Documents | Words | Citations | Provider citations | PageIndex nodes | Host result                        |
| ------------------------ | --------: | ----: | --------: | -----------------: | --------------: | ---------------------------------- |
| First goal-driven draft  |         8 | 1,048 |        32 |                  0 |              24 | Invalid plan                       |
| First valid resumed plan |        10 | 1,461 |        50 |                  0 |              31 | Exposed missing history accounting |
| History-aware resume     |        10 | 1,589 |        55 |                  1 |              33 | Partial                            |
| Accepted repair          |        13 | 2,555 |        96 |                  0 |              45 | Complete                           |

The goal-driven result is broader than both earlier eight-page catalogs and its prose
looks more like concise engineering documentation. It has dedicated pages for PageIndex,
retrieval, security, GitHub intake, worker execution, development, and history. Internal
plans, worker evidence, and transcripts no longer leak into the public document tree.

It is not an unconditional content-quality improvement:

- all 13 pages are at the root, whereas the procedural catalog used repository-oriented
  `apps/`, `context-engine/`, `review/`, and `storage/` groupings;
- 96 citations are fewer than the procedural run's 113, although the snapshots differ;
- the final catalog cites one commit but no issue or pull request despite 807 captured
  provider observations;
- the six subjects are broad labels rather than an exhaustive maintenance-question
  inventory; and
- the final resumed attempt used no workers. Earlier checkpoint attempts exercised three
  bounded workers, but that collaboration provenance did not survive in the final plan.

The most important result is that a goal alone was insufficient. The first draft looked
plausible but had an invalid control-plane plan. Subsequent drafts claimed completeness
while omitting captured-history accounting or leaving subject/page mappings unresolved.
Durable checkpoints, exact schema validation, history accounting, semantic diagnostics,
and targeted repair were what converted useful partial work into the accepted result.

### Current-plan semantic coverage

The accepted plan proves citation validity, file existence, declared evidence categories,
subject/page mappings, area accounting, worker terminality, and closed blocking gaps. It
does not prove that the agent discovered every product capability. A manual audit against
the original Context v2 plan gives the following result:

| Original-plan concern                                                | Coverage | Evidence or omission                                                                                                      |
| -------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| Derived-only, citation-grounded context and no generated answer      | Full     | Architecture, evidence, and retrieval pages state the trust boundary and fail-closed behavior.                            |
| Engineering-document organization                                    | Full     | Every public file is a titled engineering document with a lead summary and no control-plane artifacts.                    |
| Three-stage pipeline and thin ingestion                              | Partial  | The three stages and evidence boundary are present; removal of structural interpretation from ingestion is not explained. |
| Agentic derivation, durable lead plan, critic, and bounded subagents | Missing  | The derivation implementation is mentioned, but its orchestration contract is not documented.                             |
| Page checkpoints, partial releases, repair, and resume               | Partial  | Per-page checkpoint/resume and bounded repair are present; partial-release publication rules are not.                     |
| Self-hosted pinned PageIndex hierarchy                               | Full     | The local trust boundary, deployment, limits, IDs, and failure modes are documented.                                      |
| Model-free lexical tree search, list, read, and diff                 | Full     | Public retrieval is deterministic, bounded, and returns cited context without an answer.                                  |
| HTTP search/release/list/read/diff contract                          | Full     | All five public routes are named.                                                                                         |
| Exact four MCP tools                                                 | Partial  | The catalog says four read-only tools but never names them.                                                               |
| Tenant/principal token lifecycle                                     | Partial  | Binding, ACL ordering, and scopes are covered; prefix, hashing, expiry, and revocation are not.                           |
| Immutable GCS artifact policy                                        | Missing  | GCS appears only as something the PageIndex worker does not know about.                                                   |
| Exact GitHub trigger and ref policy                                  | Partial  | Push, PR, and issue admission are present; the event exclusion and ref matrix are absent.                                 |
| Direct editing disabled and regeneration governance                  | Full     | The evidence page explicitly says editing is unsupported.                                                                 |
| Context-data reset policy                                            | Missing  | Rebuild and erasure endpoints are mentioned, but reset scope and confirmation are not.                                    |
| Dashboard and admin Context surfaces                                 | Missing  | Deployment mentions the applications, not their Context explorer or release/citation views.                               |
| Incremental prior-context seeding and retirement                     | Missing  | Cache identity is documented, but incremental reconciliation is not.                                                      |
| Worker, security, operations, and failure boundaries                 | Full     | These have dedicated evidence-cited pages.                                                                                |
| Git/provider history explaining current behavior                     | Partial  | One timeout-related commit is useful, but issue/PR history is effectively unused.                                         |

This is six fully covered, seven partially covered, and five missing concerns. It is
materially closer to the original plan than the old-checkpoint catalog, but it does not
satisfy the plan as a whole. In particular, deterministic area coverage produced a false
sense of completeness: `apps/dashboard` was marked covered by `interfaces.md`, even
though that page does not document the dashboard Context experience. Future completion
logic needs capability or maintenance-question acceptance checks in addition to
repository-area accounting.

The follow-up version 3 orchestration contract implements that lesson agent-first:
subjects now carry structured maintenance questions and answer-page mappings, workers
carry research or critic roles, and the lead records context-only critic reviews and
their gaps. A complete plan requires every required question to be resolved and tested
by a completed review. The host checks reference consistency and terminal state, while
the agent continues to choose the repository-specific questions and judge semantic
depth.

The first live version 3 recovery also exposed a subtler failure: the lead could write
one broad required question across several independent pages, while the critic exercised
only a subset of the required questions. The prompt now requires atomic maintenance
tasks, full required-question review, and critic-invented repository-specific tasks that
surface untested pages or behavior. This remains an agent judgment rather than a
document-count, question-count, or word-count threshold.

The resumed Jina validation completed with 13 public documents, 2,622 words, 87
host-validated citations, one provider citation, and a 40-node PageIndex hierarchy. Its
version 3 plan has eight subjects, eight maintenance questions (six required), four
completed context-only reviews, and three critic-raised gaps, all resolved. The retry
also demonstrated the intended division of responsibility: agents chose the questions,
research, repairs, and document changes, while host checks rejected stale citation
ranges, unreviewed required questions, and a pull-request citation incorrectly declared
as commit-history evidence. The final plan is `complete`.

This resumed plan predates the atomic-question prompt and retained several broad
questions for stable checkpoint identity. It validates recovery and complete critic
coverage, but it is not evidence that a fresh version 5 initialization will choose ideal
question granularity. That remains a multi-repository evaluation target rather than a
reason to add a deterministic question-count floor.

## Decision

Keep conditional orchestration. On this repository it materially improved citation
density, provider-history use, operational coverage, and PageIndex navigability, but
cost 10% more wall time and 14% more input tokens. The prompt therefore permits workers
only when at least four independent unresolved page items exist and caps them at three;
smaller plans remain with the lead.

Do not interpret area coverage as an answer-quality score. Before raising concurrency or
requiring more pages, evaluate several repository shapes and a stable set of maintenance
questions. The largest remaining evidence-quality gap in this sample is provider-history
recall: one grounded provider citation is better than zero, but too little to claim broad
issue-history synthesis from the 807 captured provider records (635 observations and 172
pull requests).

## Reproduce

Retain a baseline derivation directory, then run:

```sh
CONTEXT_BASELINE_DIR=/absolute/path/to/baseline-run \
CONTEXT_COMPARISON_REPORT=/tmp/context-orchestration-comparison.json \
CONTEXT_PAGEINDEX_WORKER="$PWD/services/pageindex-worker/worker.py" \
CONTEXT_PAGEINDEX_PYTHON=/absolute/path/to/python \
pnpm evaluate:orchestration
```

The JSON report excludes document bodies but includes paths, aggregate metrics, plan
coverage, worker state, observed checkpoints, and PageIndex size.
