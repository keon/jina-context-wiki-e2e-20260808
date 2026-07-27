# Repository Context Engine — Architecture Decision

## Status

- **Decision:** accepted and implemented
- **Date:** 2026-07-26
- **Scope:** repository and engineering knowledge ingestion, derivation, projection, and retrieval
- **Current implementation:** [ARCHITECTURE.md](ARCHITECTURE.md)
- **Implementation record:** [CONTEXT_ENGINE_IMPLEMENTATION_PLAN.md](CONTEXT_ENGINE_IMPLEMENTATION_PLAN.md)
- **Evaluation:** [CONTEXT_ENGINE_EVALUATION.md](CONTEXT_ENGINE_EVALUATION.md)

This document records the final synthesis of research into PageIndex, retrieval-augmented
generation, long-context models, GraphRAG, code-intelligence systems, company-memory
products, and engineering-context products. The resulting architecture is now the runtime
implemented by this repository. Research sections retain recommendation language where
they describe evaluation-dependent future choices.

## Decision

Jina uses a **hybrid repository context engine**:

1. `ingest-evidence` remains the canonical, immutable evidence plane.
2. Required `derive-knowledge` runs a checkpoint-pinned Codex agent with read-only shell
   exploration over the exact repository plus immutable evidence, manifest, and prior
   knowledge. It produces versioned, cited `knowledge-documents-v4` rather than making
   broad model-generated graph relationships the primary semantic representation.
   Incremental runs must re-emit or explicitly retire every prior logical document.
3. `index-context` remains responsible for freshness, ref selection, permissions,
   invalidation, and rebuildable indexes. It projects:
   - a current knowledge-document catalog;
   - lexical and exact indexes;
   - an optional dense index, currently disabled pending evaluation;
   - a deterministic hierarchy for long, structured documents, with PageIndex retained as
     an optional adapter pending evaluation;
   - deterministic structural and temporal relations.
4. Query execution routes each question across the appropriate retrieval paths, merges
   and reranks candidates, surfaces material conflicts, and grounds final answers in original
   evidence.
5. Relations remain only where deterministic, explicitly sourced, or required by a
   validated product feature. Jina does not use a universal
   LLM-generated semantic graph as its company or engineering brain.

The concise form is:

```text
immutable evidence
  -> cited knowledge-document revisions
  -> multiple disposable retrieval projections
  -> task-aware retrieval and synthesis
  -> answer grounded in original evidence
```

The documents include cited facts, answered questions, and diagnostic symptoms, likely
causes, checks, and fixes. HTTP and MCP expose a `diagnose` task kind that combines this
knowledge with structured provider state and temporal change history.

## Why this is the decision

The research does not support one universal storage or retrieval primitive. It supports a
layered architecture in which different representations answer different question types:

| Information need                                           | Best-supported path                                            |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| Exact identifier, error code, path, symbol, ticket, or SHA | lexical/exact search and metadata filters                      |
| Caller, import, dependency, ownership, or explicit lineage | deterministic structural relations                             |
| Fuzzy concept or paraphrase                                | dense retrieval followed by reranking                          |
| Long document or hierarchical overview                     | PageIndex/RAPTOR-style hierarchy                               |
| Architecture, rationale, history, or incident explanation  | cited knowledge documents plus source retrieval                |
| Current lists, counts, status, or field filters            | direct structured query against canonical data                 |
| Small, strongly interdependent corpus                      | routed long-context read                                       |
| Temporal contradiction or point-in-time truth              | versioned sources and, when justified, temporal relations      |
| Hypothetical execution or blast radius                     | validated code/runtime model, not an unverified semantic graph |

The consensus is therefore **hybrid context assembly**, not graph-only, vector-only,
tree-only, or long-context-only retrieval.

## Evidence standard

Sources were weighted in three tiers:

1. **Independent research:** peer-reviewed papers and evaluations receive the most weight.
2. **Documented production changes:** first-party engineering retrospectives and disclosed
   strategy changes are useful evidence of operational failure modes.
3. **Vendor architecture and benchmarks:** useful for identifying market direction, but not
   treated as independent proof.

Claims from PageIndex, PlayerZero, Unblocked, Driver, Greptile, Quarkify, Zep, and similar
vendors are therefore evidence of their disclosed design, not proof that their performance
claims generalize to Jina.

## Research synthesis

### Hybrid retrieval is the strongest default

Sparse, dense, structural, and human-curated sources provide complementary signals.
[MoR](https://aclanthology.org/2025.emnlp-main.601/) found that a mixture of heterogeneous
retrievers outperformed every individual retriever and larger retrieval models.
[T2-RAGBench](https://aclanthology.org/2026.eacl-long.8/) found hybrid BM25, combining
sparse and dense representations, most effective on its real-world text-and-table corpus.
[Anthropic's Contextual Retrieval experiments](https://www.anthropic.com/engineering/contextual-retrieval)
found that contextualized chunks, BM25, embeddings, and reranking delivered cumulative
reductions in retrieval failure.

These results argue for query routing and result fusion. They do not support eliminating
lexical search in favor of embeddings, or eliminating embeddings in favor of a single tree.

### Hierarchies help, but trees are not a complete corpus architecture

[RAPTOR](https://proceedings.iclr.cc/paper_files/paper/2024/hash/8a2acd174940dbca361a6398a4f9df91-Abstract-Conference.html)
and [TreeRAG](https://aclanthology.org/2025.findings-acl.20/) show that hierarchical
summaries improve holistic and multi-step retrieval over long documents.

However, 2026 cross-document research identifies structural isolation, distribution
assumptions, and loss of fine detail as weaknesses of existing tree approaches, then adds
an agentic hybrid retriever to address them:
[Hierarchical Abstract Tree for Cross-Document RAG](https://arxiv.org/abs/2605.00529).

PageIndex is consequently a valuable long-document projection, not Jina's sole index or
canonical knowledge representation.

### Graphs help conditional question classes

[HybGRAG](https://aclanthology.org/2025.acl-long.43/) shows that combining textual and
relational retrieval helps questions that genuinely require both. Graph methods also work
well when the input is already a reliable graph or when the task requires multi-hop
relational reasoning.

The result does not generalize to graphing every semantic statement. In the more realistic
[WildGraphBench](https://aclanthology.org/2026.findings-acl.679/), GraphRAG helped
multi-fact aggregation over a moderate number of sources but could overemphasize high-level
statements and lose fine-grained detail. A 2025 systematic comparison likewise found
distinct strengths for RAG and GraphRAG rather than one universal winner:
[RAG vs. GraphRAG](https://arxiv.org/abs/2502.11371).

Microsoft's own progression is instructive. Original GraphRAG performs LLM extraction,
community construction, and resource-intensive global search. Microsoft later introduced
dynamic selection and
[LazyGraphRAG](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/),
which defers LLM work, uses a lighter concept graph, and combines text relevance with
query-time reasoning. This is a move toward a hybrid, routed architecture.

### Long context is another route, not a replacement for retrieval

When the relevant corpus fits and cost is unconstrained, long-context models often
outperform conventional chunk RAG. RAG remains materially cheaper, and routing between the
two preserves much of the quality:
[Retrieval Augmented Generation or Long-Context LLMs?](https://arxiv.org/abs/2407.16833).

Long context still has positional and dependency failure modes:
[Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/) and
[Lost in Decomposition](https://aclanthology.org/2026.findings-acl.2097/).
Jina should route selected questions to long-context reading after discovery, not put the
entire repository or organizational corpus into every prompt.

## What production systems disclose

### Unblocked: graph plus hybrid retrieval and query-time reasoning

Unblocked describes a five-stage pipeline:

1. webhook-driven ingestion plus reconciliation;
2. normalization into common document shapes with typed metadata;
3. a typed graph joining code symbols, PRs, messages, tickets, people, and documents;
4. parallel semantic, lexical, structural, and temporal retrievers;
5. conflict handling, authority weighting, permissions, and cited synthesis.

Its graph is a retrieval substrate, not the final answer format. It explicitly combines
BM25, dense embeddings, structural traversal, temporal retrieval, reranking, and iterative
query reformulation:
[Unblocked architecture](https://getunblocked.com/blog/how-a-context-engine-actually-works-and-why-you-need-to-care-now/).

Unblocked also published a useful first-party retrospective describing three shipped
failures:

- adding more sources without deeper reasoning reduced answer quality;
- silently hiding source conflicts eroded trust;
- caching answers over changing inputs produced confidently stale output.

Its resulting rules are to rank fewer sources more aggressively, surface material
conflicts, compute answers against live state, and cache only derivations of immutable
inputs:
[Three Hard Lessons from Building Context at Scale](https://getunblocked.com/blog/three-hard-lessons-context-scale/).

This is the closest public architecture to the recommended Jina target.

### PlayerZero: a graph is justified by simulation

PlayerZero anchors a semantic dependency graph in code, then enriches it with tickets,
telemetry, deployments, customer sessions, configurations, historical failures, and agent
investigation trajectories. Its primary derived artifact is a scenario describing expected
behavior. Its Sim-1 system predicts state transitions and possible failure paths across the
model:
[PlayerZero architecture](https://playerzero.ai/docs/how-playerzero-works) and
[Sim-1](https://playerzero.ai/research/sim-1).

This graph has a stronger reason to exist: it supports simulation, state propagation,
impact prediction, and interpretable execution traces. PlayerZero also argues that useful
relationships emerge from repeated, problem-directed investigation trajectories:
[Context Graphs and Engineering World Models](https://playerzero.ai/resources/context-graphs-building-engineering-world-models-for-the-age-of-ai-agents).

Jina's current code and GitHub evidence is insufficient for the same claim. A
PlayerZero-style world model would require runtime telemetry, configurations, deployments,
customer behavior, confirmed incident outcomes, and a benchmark demonstrating predictive
value. PlayerZero's public benchmark results are vendor-run and have not been treated as
independently reproduced evidence.

### Driver, Greptile, and Sourcegraph: deterministic code structure remains valuable

[Driver](https://www.driver.ai/) uses compiler-inspired passes over DAGs, ASTs, symbol
tables, and call graphs, then generates symbol-complete documentation and architecture
context. The deterministic structure supplies coverage; generated documents supply
consumable explanations.

[Greptile](https://www.greptile.com/docs/how-greptile-works/graph-based-codebase-context)
uses a code graph of files, functions, classes, calls, imports, dependencies, and usage
sites for code-review impact analysis.

Sourcegraph moved Cody's multi-repository context from embedding-only retrieval to its core
search engine and made embeddings optional:
[Sourcegraph 5.3](https://sourcegraph.com/blog/sourcegraph-5-3-changelog).
Its later Deep Search combines exact search, code navigation, iterative exploration, and
grounded summaries:
[Sourcegraph Deep Search](https://sourcegraph.com/blog/introducing-deep-search).

These systems support retaining Jina's deterministic code plane. They do not justify
encoding every inferred feature, rationale, or likely impact as a graph edge.

### Quarkify: useful filesystem projection, not a knowledge substrate

[Quarkify](https://github.com/companyjupiter/quarkify) is a local-first static-analysis
tool that materializes code structure as a directory tree. Its `quark/` hierarchy gives
agents a familiar `ls`/`find`/`rg` navigation surface, while `_mirror/` and `_axon/`
materialize alternate indexes by kind, role, file, performance band, and opcode. This is an
interesting agent interface: it is inspectable, requires no retrieval service, and lets
ordinary filesystem tools perform deterministic filtering.

Implementation inspection at
[commit `cace87f`](https://github.com/companyjupiter/quarkify/tree/cace87f5ea96333642d6198b6364ab38efd99ff9)
substantially narrows the claims implied by the README:

- most supported-language parsing is implemented with custom regular expressions,
  brace/indentation scanning, and hand-written statement parsers rather than compiler
  frontends or typed symbol resolution;
- `call__...` folders identify call-shaped text by name but do not resolve the callee;
- the D3 "graph" scans directory-containment edges; it is not the `_axon` relation index
  and is not a semantic, dependency, or knowledge graph;
- `_axon` primarily records membership in mirror categories, plus a PTX opcode index;
- each run deletes and rebuilds `quark/`, `_mirror/`, and `_axon/`; there is no incremental
  revision model, permission propagation, citation contract, cross-source retrieval, or
  answer synthesis;
- filename normalization is lossy and truncated, so collisions and filesystem
  path/inode limits are production concerns.

The current automated tests cover CLI materialization, glob matching, and output-directory
safety. They do not measure parser accuracy, symbol resolution, retrieval quality, or the
README's "90% token savings" and "0% hallucination" claims. The published large-project
figures count generated folders, which demonstrates that the tool runs but not that agents
find complete or correct evidence.

Quarkify therefore reinforces one part of this decision without changing the primary
architecture: retain a deterministic structural projection and offer an agent-native way
to browse it. Jina may evaluate a Quarkify-like **virtual hierarchy or on-demand local
export**, backed by compiler/Tree-sitter/LSP-quality facts and exact source anchors. It
should not make millions of physical directories the canonical or hosted index, and it
should not substitute Quarkify for knowledge-document assertion, PageIndex-style
long-document navigation, hybrid retrieval, or cited synthesis.

### Zep: temporal graphs are justified by changing facts

Zep reports that its earlier extracted-fact RAG pipeline produced incomplete facts, poor
recall, and contradictions. It moved to Graphiti because agent memory requires provenance,
validity windows, and explicit invalidation of superseded facts. Importantly, Graphiti still
combines semantic retrieval, BM25, and graph traversal:
[Zep's architecture change](https://www.ycombinator.com/companies/zep-ai) and
[Graphiti](https://www.getzep.com/platform/graphiti/).

This supports a temporal sidecar when "what was true when?" is a core product question. It
does not justify a universal graph for static explanations.

### 2025–26 company-memory systems: living artifacts over raw graphs

Recent company-memory products increasingly serve human- and agent-readable derived
artifacts:

- [Memory Store](https://www.ycombinator.com/companies/memory-store) turns conversations
  into memories and continuously updated Briefs.
- [Hyperspell](https://www.hyperspell.com/) describes an internal context graph but serves
  structured results and LLM-ready Markdown.
- [Kaelio](https://www.ycombinator.com/companies/kaelio) separates Markdown business
  knowledge from deterministic YAML definitions compiled into SQL.
- [Airbyte Context Store](https://airbyte.com/context-store) materializes searchable,
  permissioned business entities for discovery and uses live APIs only when fresh state or
  an action is required.

The market signal is a materialized context layer with several representations, not a
single exposed graph.

## Rejected alternatives

### Universal LLM-generated semantic graph

Rejected as the primary knowledge form because:

- graph extraction introduces cost, refresh latency, ontology pressure, and cascading
  extraction errors;
- graph retrieval helps only particular relational and aggregation questions;
- prose explanations, uncertainty, alternatives, and source conflicts do not fit naturally
  into triples;
- most user and agent interfaces ultimately require cited text, not raw nodes and edges.

The deterministic relation sidecar remains allowed.

### PageIndex-only, vectorless retrieval

Rejected as the only retrieval method because:

- PageIndex is strongest on long, well-structured professional documents;
- exact code identifiers, ticket IDs, error strings, and exhaustive matches still require
  lexical retrieval;
- cross-document relationships and temporal state require other indexes;
- PageIndex's headline FinanceBench result is first-party evidence;
- independent research favors mixtures of retrievers.

PageIndex-style hierarchy remains part of `index-context`.

### Quarkify-only physical filesystem index

Rejected as the primary hosted index because a directory per syntactic or derived feature
creates a large inode and path-management surface, is lossy when names are normalized,
requires expensive rebuilds, and does not supply version selection, ACLs, citations,
cross-source retrieval, or semantic synthesis. Hand-written pattern parsers are also not a
sufficient source of truth for code relations.

A Quarkify-like virtual tree or local export remains allowed as an agent-facing view over
the structural projector.

### Flat vector RAG

Rejected because semantic similarity is not exact relevance, code identifiers perform
poorly, chunk boundaries lose structure, and one retriever does not generalize across query
classes.

Dense retrieval remains an optional complementary path.

### Put everything in long context

Rejected because organizational corpora exceed practical windows, cost increases with
irrelevant context, and long-context attention remains unreliable for some positions and
dependency structures.

Long-context reading remains a routed path after discovery.

### Generated wiki as canonical truth

Rejected because generated explanations become stale and may silently contradict code or
newer decisions.

Knowledge documents are immutable, cited revisions and disposable indexes. They are not
the source of truth.

### Cache final answers

Rejected for evolving questions. Answers must be assembled against the current ref,
permissions, and source state. Parsing, embeddings, structural analysis, and summaries of
immutable inputs may be cached by exact fingerprint.

## Target data architecture

### Canonical plane

The following remain canonical:

- immutable provider observations;
- commits and exact trees;
- content-addressed blobs and parser output;
- first-parent changes;
- explicit PR, issue, commit, deployment, and membership facts;
- provider identity and ACL observations;
- human review and audit events.

Force-pushes and ref movement select different immutable state; they do not rewrite
historical evidence.

### Knowledge-document plane

`derive-knowledge` creates immutable `KnowledgeDocumentRevision` records. A logical
document may have many revisions, but each body and evidence set is immutable.

A revision requires at least:

```text
logical_id
revision_id
tenant_id
repository
kind
title
body
summary
scope:
  ref
  commit_sha
  paths
  symbols
  pull_requests
  issues
anchors
citations:
  source_type
  source_id
  content_digest
  path_or_url
  range
evidence_fingerprint
generator_name
generator_version
confidence
review_status
valid_from
valid_to
supersedes_revision_id
created_at
```

Initial `kind` values should be bounded:

```text
architecture
component
feature
decision
change_summary
incident
issue_explanation
ownership
runbook
glossary
```

The schema may contain typed anchors and metadata for filtering. It must not require every
semantic claim to become a separately materialized graph node or edge.

Model output remains untrusted:

- every material statement must cite immutable evidence;
- cited paths and ranges must be verified against the pinned checkout;
- evidence digests must be recorded;
- invalid or incomplete output fails closed;
- model generation never mutates canonical source facts;
- reviewed revisions retain their exact evidence and audit history.

### Projection plane

`index-context` remains a durable, idempotent stage with independent consumers:

1. **Manifest projector** selects the exact current ref tree.
2. **Knowledge projector** selects the current valid document revision per logical ID and
   ref.
3. **Lexical projector** builds exact and BM25-friendly documents.
4. **Dense projector** builds embeddings when enabled and justified by evaluation.
5. **Hierarchy projector** creates PageIndex-style navigation over long source and derived
   documents.
6. **Structural projector** materializes deterministic code and provider relations.
7. **Identity projector** folds redirects and provider identities.
8. **Retention projector** applies tombstones, erasure, and bounded derived-artifact
   retention.

Every projection is disposable and rebuildable from canonical inputs plus immutable
knowledge-document revisions.

The structural projector may additionally expose a Quarkify-like virtual filesystem, MCP
resource tree, or explicit local export for agent navigation. That is a presentation over
versioned structural records, not a second canonical store. The hosted system should avoid
physically materializing every statement and attribute as a directory unless evaluation
shows a decisive benefit after inode count, path collisions, rebuild latency, and
cross-platform behavior are included in the cost.

## Graph boundary

The retained relational sidecar may include:

- files, symbols, definitions, references, calls, imports, and inheritance;
- manifest and package dependencies;
- service declarations and explicit deployment targets;
- CODEOWNERS and explicit provider ownership;
- PR-to-commit and PR-to-file membership;
- explicit issue resolution and reference links;
- identity redirects and revision supersession;
- reviewed causal relations only if the causal product remains independently validated.

The following should default to knowledge-document content and anchors, not graph edges:

- inferred feature identity;
- likely impact;
- architectural rationale;
- implementation intent;
- documentation relevance;
- inferred ownership;
- unverified causality;
- semantic similarity;
- alternatives considered;
- summaries of incidents or decisions.

PostgreSQL adjacency tables are sufficient until measured traversal requirements demonstrate
the need for a dedicated graph database.

## Query architecture

A query request should carry:

```text
principal
tenant
repository/ref scope
question
task kind
optional target paths, symbols, PRs, issues, or time window
```

The query engine should:

1. resolve repository, ref, principal, and permissions;
2. classify the information need;
3. dispatch eligible retrievers in parallel;
4. fuse candidates;
5. rerank by task relevance, exactness, source authority, recency, and evidence validity;
6. detect material source conflicts;
7. reformulate and retrieve again when coverage is insufficient;
8. read the selected original evidence;
9. return a synthesized answer with citations, conflicts, ambiguities, and coverage gaps.

Suggested routing:

| Query signal                                         | Primary retriever                               |
| ---------------------------------------------------- | ----------------------------------------------- |
| path, SHA, symbol, error, issue number               | exact/lexical                                   |
| paraphrased concept                                  | dense plus lexical                              |
| overview or long document                            | hierarchy                                       |
| caller, dependency, ownership, blast radius          | structural                                      |
| "why", decision, prior attempt                       | knowledge documents plus temporal source search |
| "what changed"                                       | commit/PR history plus knowledge documents      |
| list, count, open/closed, owner, date filter         | canonical structured query                      |
| strong cross-document dependency in a bounded corpus | routed long-context read                        |

The response contract should no longer imply that every answer is `graph-derived`.

## Conflict and authority policy

Jina must not silently launder disagreement into certainty.

Candidate authority depends on the question:

- code is authoritative for current implemented behavior;
- a pinned ref is authoritative for behavior at that ref;
- reviewed specifications and ADRs are stronger for intended behavior;
- provider state is authoritative for current ticket or PR fields;
- immutable observations are authoritative for what a source said at a point in time;
- recent Slack or ticket discussion may explain intent but does not automatically override
  reviewed code or a canonical provider field.

When strong sources disagree, the answer should identify the disagreement and cite both.
Recency is a ranking signal, not an unconditional truth rule.

## PageIndex integration

PageIndex should be evaluated as the hierarchy projector and tree-search retriever for:

- RFCs and architecture documents;
- runbooks and incident reports;
- technical manuals and API documentation;
- large generated knowledge documents;
- repository- or service-level overview collections.

It should not own:

- canonical source storage;
- ref or permission resolution;
- exact code search;
- structured issue/PR queries;
- code dependency traversal;
- cross-source identity resolution;
- answer synthesis;
- invalidation and deletion semantics.

The integration boundary should permit replacing PageIndex without rewriting ingest,
knowledge-document storage, or the public query contract.

## Implemented outcome

The implementation preserves:

- exact immutable trees and content-addressed parsing;
- a canonical/derived separation;
- checked citations and evidence fingerprints;
- human review and audit provenance;
- consumer-owned outbox deliveries;
- ref-scoped projections and ACL enforcement;
- deterministic structural code relations;
- idempotent, rebuildable projectors.

See the current stage contract in [ARCHITECTURE.md](ARCHITECTURE.md) and storage planes
in [DATA_MODELS.md](DATA_MODELS.md).

The clean cutover:

- changed the semantic output from relationship proposals to knowledge-document
  revisions;
- replaced broad semantic graph materialization with knowledge, lexical, dense, hierarchy,
  and structural projections;
- replaced the fixed graph-only query planner with routed hybrid retrieval;
- preserved deterministic relation queries through the context API;
- removed `basis: graph-derived` from general answer semantics;
- removed unvalidated causal/counterfactual answer behavior; it can return only behind a
  separately evaluated, source-grounded relation model.

The runtime uses only the durable stage names `ingest-evidence`, `derive-knowledge`, and
`index-context`. It exposes `/context/*`, the `jina-context` MCP server, and only the
`query_context` MCP tool. The old package, schema, routes, topics, executor shape,
dashboard canvas, environment variables, and compatibility aliases were deleted.

The PostgreSQL embedding adapter and dense retriever are present but disabled until an
approved embedding backend demonstrates an incremental evaluation win. The deterministic
heading hierarchy is active; PageIndex is a replaceable adapter/fallback candidate and is
not enabled until it beats that fallback on the expanded long-document slice.

## Original incremental migration outline

The implementation plan supersedes this outline with a clean replacement that does not
dual-write or retain compatibility aliases. The phases below remain useful as historical
rationale for the ordering of evaluation, knowledge documents, projectors, retrieval, and
graph retirement.

### Phase 0 — Establish evaluation before changing storage

Build a representative, versioned evaluation set covering:

- exact symbol and identifier lookup;
- architecture and repository overview;
- "why was this built?" decision history;
- change and incident explanation;
- cross-repository dependencies;
- issue and PR status;
- ownership;
- conflicting sources;
- stale documentation;
- long-document retrieval;
- causal and counterfactual queries currently supported.

Record current answer quality, retrieval recall, citation validity, latency, cost, and
coverage gaps.

### Phase 1 — Add knowledge documents in parallel

- Introduce immutable knowledge-document revisions.
- Generate them from the existing bounded assertion checkout and evidence bundle.
- Continue producing current assertions temporarily for comparison.
- Validate every citation and evidence fingerprint using existing mechanisms.

### Phase 2 — Add independent projectors

- Build current-revision, lexical, hierarchy, and optional dense projectors.
- Reuse the existing canonical outbox and per-consumer acknowledgement pattern.
- Keep deterministic structural projection unchanged.
- Prototype a virtual or local Quarkify-like structural view only if it can be benchmarked
  against exact search, LSP/compiler indexes, and direct source navigation.

### Phase 3 — Shadow hybrid retrieval

- Run the new retriever on the evaluation set and selected production queries without
  changing user-visible results.
- Compare retrieval recall, evidence selection, conflict disclosure, latency, and cost.
- Log which retrieval path contributed each cited source.

### Phase 4 — Change the answer path

- Introduce a general context-query contract while retaining compatibility for
  `query_graph`.
- Serve hybrid answers with citations, conflicts, ambiguities, and coverage gaps.
- Keep exact structural templates for callers, dependencies, ownership, and explicit
  lineage.

### Phase 5 — Retire broad semantic graph projection

Retire model-generated semantic graph nodes and edges only after:

- the hybrid path meets or exceeds the current benchmark on supported questions;
- causal/counterfactual scope is deliberately retained or removed;
- no public client requires raw graph generations;
- retention, erasure, and ACL parity are verified;
- the dashboard has a replacement for semantic graph inspection.

## Evaluation contract

Storage design must be decided by representative tasks, not by benchmark marketing.

Required dimensions:

| Dimension                | Measurement                                                         |
| ------------------------ | ------------------------------------------------------------------- |
| Retrieval coverage       | recall@k of all evidence required for the answer                    |
| Citation precision       | cited sources materially support the associated statement           |
| Citation integrity       | source exists and digest/range matches the selected ref             |
| Exact-query completeness | exact list and identifier tasks omit no matching canonical rows     |
| Groundedness             | unsupported answer claims                                           |
| Conflict handling        | known material disagreements are surfaced                           |
| Freshness                | time from source change to eligible retrieval                       |
| ACL safety               | no source or derived fact crosses its effective permission boundary |
| Temporal correctness     | answer matches the requested ref or time                            |
| Latency                  | end-to-end and per-retriever p50/p95                                |
| Cost                     | indexing, refresh, retrieval, reranking, and synthesis              |
| Stability                | variance across repeated runs over identical immutable inputs       |

No approach should be selected because it wins only on vendor-authored financial-document
QA, a small curated graph, or a single coding demonstration.

## Revisit conditions

Revisit a broader semantic or temporal graph when all of the following are true:

- a product-critical query class requires repeated multi-hop traversal or simulation;
- the relevant relations can be measured against reliable ground truth;
- ingestion includes the runtime or temporal signals needed for the claim;
- incremental refresh and invalidation meet freshness requirements;
- the graph outperforms hybrid document retrieval on Jina's evaluation set by enough to
  justify its operational cost.

Revisit PageIndex as a larger part of the system when:

- long structured documents dominate the corpus;
- hierarchy retrieval wins independently on Jina's evaluation set;
- exact, cross-document, temporal, and permissioned queries remain covered elsewhere.

Revisit a dedicated graph database only when measured PostgreSQL traversal latency,
concurrency, or graph algorithms exceed established budgets after query and index tuning.

## Final synthesis

The durable industry pattern is not an actual graph replacing documents, or documents
replacing every graph. It is:

> Canonical source evidence, deterministic structure, versioned derived knowledge,
> multiple retrieval projections, and task-aware query-time reasoning.

For Jina, the best next architecture is **Unblocked-like in retrieval**, **Driver-like in
deterministic code grounding**, **PageIndex-like for long-document navigation**, and
optionally **Quarkify-like at the agent navigation boundary**. PlayerZero's graph-first
world model is a later product direction only if Jina begins ingesting runtime reality and
can validate simulation. Zep's temporal graph is a specialized option only when changing
facts are central.

The concrete decision is to make cited knowledge documents the primary output of
`derive-knowledge`, keep `index-context` as the owner of disposable indexes, retain a narrow
deterministic relation sidecar, and build a routed hybrid query engine that returns
evidence-backed answers rather than exposing the internal storage primitive.
