# Context quality benchmark

Status: the quality dimensions in this document remain the target. Runtime page
validation, citation audits, publication validation, and API/MCP acceptance are
authoritative.

This benchmark defines what “comparable to DeepWiki and Code Wiki” means for Context. It compares the quality of the generated engineering documentation and the usefulness of the context returned to another agent. It does not require Context to copy either product's chat experience.

The unit of quality is a repository-specific maintenance task that a coding or review agent can complete from the generated context and its exact source links. Word count, page count, and prose length are not parity metrics. Longer documentation can still be incomplete, ungrounded, or difficult to navigate.

## Reference behavior

Google describes Code Wiki as continuously rebuilding a structured wiki from the full repository, keeping it current after changes, linking explanations to exact source locations, and including architecture, class, and sequence diagrams where they clarify the system. It also emphasizes navigation from a high-level concept to the supporting implementation ([Introducing Code Wiki](https://developers.googleblog.com/en/introducing-code-wiki-accelerating-your-code-understanding/)).

DeepWiki's generated pages expose a hierarchy, a “Relevant source files” section, detailed implementation mechanics, tables, cross-page navigation, diagrams, and exact file/line links. Its [PageIndex documentation](https://deepwiki.com/VectifyAI/PageIndex) demonstrates repository overview and subsystem navigation, while its [OpenAI Python client documentation](https://deepwiki.com/openai/openai-python/3-core-client-classes) demonstrates class relationships, sync/async execution models, and request flow grounded in source.

Those observable properties become the baseline below. Context intentionally differs at
query time: `search_context`, `list_context`, `read_context`, and `diff_context` return
citation-grounded context rather than a synthesized answer. All four tools are
deterministic and invoke no LLM. `search_context` uses bounded lexical scoring over the
published PageIndex tree; the calling coding or review agent performs the final reasoning.

## Acceptance dimensions

### Maintenance-task answerability

The derivation lead must discover concrete questions that represent real maintenance work in that repository, such as changing a flow safely, tracing state ownership, diagnosing a failure, extending an interface, or understanding why a current design exists.

For every required question in an offline benchmark corpus:

- the question is mapped to the pages intended to answer it;
- a context-only critic attempts the task using public generated pages;
- the critic records the pages actually used and a `pass`, `partial`, or `fail` verdict;
- a partial or failed attempt creates a benchmark finding; and
- regressions are investigated before treating a model or prompt change as an
  improvement.

Maintenance-task evaluation is no longer a claimable runtime Board gate. It is an
offline quality signal: production publication is gated by page dispositions, exact
citation validation, the deterministic publication manifest, and PageIndex validation.
The host also requires every final page to retain at least one normalized substantive
term from each planned required topic and maintenance question, both during page audit
and again immediately before certification. This deterministic check is not a substitute
for the offline semantic critic, but it prevents a structurally valid page from silently
dropping an entire planned subject without making planner wording a public-page contract.

An offline pass should bind SHA-256 digests of the exact public Markdown snapshot and
maintenance-task catalog. The critic should record an auditable attempt—headings, entry
points, symbols, change plan, invariants, verification, failure triage, and unknowns—
rather than returning a bare verdict. Any later page or task change invalidates that
benchmark result.

### Grounding and exact source navigation

Every published document must contain at least one exact line-anchored source link. Claims about control flow, state, configuration, tests, or history should link as close as practical to the supporting implementation. A healthy context set uses multiple relevant source paths rather than repeatedly citing a single overview file.

Repository ranges wider than 120 lines are rejected. A symbol name somewhere inside a thousand-line handler is technically findable but does not provide useful concept-to-code navigation. The host's citation validation remains authoritative. The benchmark counts exact links, range precision, and distinct paths, but a high citation count does not compensate for an invalid or irrelevant citation.

Structural link validity is only the first grounding gate. Every current repository
or captured GitHub evidence link also receives a stable `cite_<digest>` identity
derived from its document path, exact target, nearby assertion, and occurrence. A
separate read-only, source-aware Codex audit receives that assertion and the exact
captured excerpt. It must return each citation identity exactly once and mark every
one `supported`; an unsupported or omitted citation blocks parity.

For a retained page-oriented run, validation should reconstruct those identities and
check the private audit binding chain:

- `citation-audit-input.json` contains exactly the current public citations, their
  assertions, targets, and source-bound excerpts;
- its input digest binds that payload, and its public-snapshot digest binds the
  current ordered Markdown snapshot;
- `citation-audit.json` covers every current citation exactly once, with no stale,
  invented, duplicated, or unsupported result;
- each page phase checkpoint binds task, input digest, exact citation catalog, and audit
  result bytes; and
- the publication `certification.json` manifest binds the exact current public snapshot,
  page artifacts, publication plan, and omitted-page dispositions.

These files remain private immutable artifacts. The public contract remains ordinary
engineering Markdown with ordinary source links.

### Navigable hierarchy

The context set must progress from repository overview to the features, components, flows, interfaces, state, operations, decisions, and history that are material in that repository. The agent owns the taxonomy; there is no fixed page template.

Pages use meaningful heading hierarchy and link to related Wiki pages. All relative Wiki links must resolve. A reader should be able to move from a concept to its implementation details without reconstructing the repository structure from search results.

Every public document must be reachable from `architecture.md` through document links. This tests the generated hierarchy independently of the dashboard's fallback file tree.

### Useful diagrams

Architecture, sequence, state, and data-flow diagrams are expected when they make a multi-component relationship materially easier to understand. Diagrams must express information that is supported by cited prose and must be reviewed as part of task answerability.

There is no minimum diagram count. A decorative diagram is not evidence of quality, and a simple repository should not receive one solely to satisfy a metric.

### Provider evidence and history

The agent considers commits, pull requests, issues, and provider observations while discovering subjects. When provider or history evidence is material and a plan item requires it, the resulting document must connect that evidence to the current implementation.

History explains why the present design exists or how a failure shaped it. It must not present an old issue or pull request as current source of truth when current code or configuration supersedes it.

### Full initialization and incremental freshness

A full initialization must evaluate the repository at one exact commit and produce a complete, critic-passed context release. A later commit, pull request, or new issue must create an incremental plan against the new repository/provider frontier. Issue comments alone do not trigger a context build.

Incremental testing compares two retained artifacts and verifies:

- the current run is marked `incremental`;
- the commit or provider frontier advanced;
- unchanged useful pages can retain stable logical identities;
- affected pages are repaired or added;
- the resulting release again passes grounding and task-answerability gates.

An irrelevant commit may legitimately leave document bodies unchanged, so changed-document count is evidence, not a universal gate.

### Checkpoint recovery

The durable orchestration plan and each accepted document are checkpoints. An interrupted run must retain completed, citation-valid pages, record unfinished work and gaps, and resume on the same commit without discarding valid progress. Publication still requires complete, current page and citation gates.

Artifact inspection can prove that plan and page checkpoints exist. It cannot by itself prove that execution reused them. Resume behavior therefore requires an end-to-end test that interrupts a run, starts it again, and observes reuse before successful publication.
