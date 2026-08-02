# Jina Repository Instructions

A repository can customize Jina's review behavior with `.jina/config.json` and
Markdown instruction files under `.jina/`. They travel with the repository and are loaded by the review
worker from the cloned repository inside the Daytona sandbox. No dashboard or API
configuration is required.

The same guide is available inside the dashboard at `/jina` from **.jina Guide**
in the sidebar.

Jina reads instructions from the **base branch** of the pull request
(`origin/<base>`, such as `origin/main`), never from the PR head. An instruction
added or changed by a PR begins affecting reviews only after that change is merged
into the base branch. The PR cannot change the instructions governing its own
review.

## Directory structure

Repository guidance uses Markdown files named exactly `instruction.md`; runtime
defaults live in the optional JSON config:

```text
.jina/
├── config.json
├── instruction.md
├── planner/
│   └── instruction.md
├── replanner/
│   └── instruction.md
├── investigation/
│   └── instruction.md
└── review/
    └── instruction.md
```

Only create the files a repository needs. Missing and empty files are ignored.

Use `.jina/config.json` for deterministic workflow defaults:

```json
{
  "depth": 2
}
```

If `.jina/config.json` is absent, Jina behaves as though the default object above
were present:

| Preference | Accepted values | Default | What it controls |
| --- | --- | --- | --- |
| `depth` | Integer from `1` to `5` | `2` | The maximum number of investigation loops. Round 1 investigates the planner's initial areas; each later round lets the replanner add evidence-driven follow-up or deeper investigation areas. A review stops early when no areas remain, so `depth: 5` permits up to five loops but does not force all five. Lower values favor faster, less expensive reviews; higher values allow more follow-up depth. |

Jina uses its standard planner, replanner, investigation, and review prompts.
The review stage validates and deduplicates investigation findings, assigns P0–P3
severity to real issues, and may omit a false positive only with affirmative
evidence. Every validated issue remains eligible for GitHub publication. Unless
an authoritative base-branch repository instruction or authorized run-specific
instruction explicitly overrides the relevant mapping, the reviewer keeps each
severity and merge score aligned with the standard rubric and uses these default
display descriptions and recommendations:

| Severity | Default description |
| --- | --- |
| `P0` / Critical | Must fix before merging |
| `P1` / High | Should fix |
| `P2` / Medium | Consider fixing |
| `P3` / Low | Low priority |

| Merge score | Default recommendation |
| --- | --- |
| `5` | Merge ready |
| `4` | Merge is probably fine |
| `3` | Merge is okay, fixes recommended |
| `2` or `1` | Merge blocking |

The reviewer must keep the selected merge score, recommendation, and rationale
consistent with the rubric and must not invent a different mapping. An explicit
repository or run-specific override may revise the relevant assignment rubric or
human-readable label, but the protected merge-score (`1`–`5`) and issue-severity
(`P0`, `P1`, `P2`, `P3`) contracts remain fixed.

Configuration is read from the pull request's base branch. A PR that adds or
changes `.jina/config.json` does not govern its own review; the change takes effect
after it is merged. An invalid depth logs a worker warning and falls back to `2`.
Malformed JSON or a non-object value falls back to the default. Obsolete and
unrecognized keys are ignored.

There is one step per model-backed stage of the runtime review, in pipeline order:

| File | Stage | Applies to |
| --- | --- | --- |
| `.jina/config.json` | runtime workflow | Optional JSON policy: `depth` is an integer from 1–5 (default `2`). |
| `.jina/instruction.md` | all | Every stage. Use it for repository-wide scope, priorities, risk tolerance, conventions, and tone. |
| `.jina/planner/instruction.md` | Planner | The first round of planning: inferring PR intent and choosing the impacted runtime areas to investigate, with their expectations, failure modes, and execution plans. |
| `.jina/replanner/instruction.md` | Replanner | Between investigation rounds: reviewing what the agents found and adding follow-up areas, including deepen directives into a prior agent's work. It can only add areas; it cannot stop the loop or rerun completed work. |
| `.jina/investigation/instruction.md` | Investigation agents | The agents that run code in the sandbox: task selection, execution depth, evidence expectations, and what counts as an issue worth reporting. |
| `.jina/review/instruction.md` | Reviewer | The final stage: how findings are validated and deduplicated for GitHub, how P0/P1/P2/P3 severity and labels are assigned, and how merge readiness is scored. The complete raw investigation remains on the dashboard; findings proven false or not issues with affirmative evidence are omitted from GitHub and recorded as dismissed candidates. |

The retired `intent` and `mental-trace` steps are gone: the standalone intent stage
was absorbed into the planner, and the `mental_trace` tool was replaced by direct
execution in the investigation agents. Files at those paths are no longer read.

The standard planner treats frontend/UI, backend services and jobs, APIs,
persistence and databases, caches, auth and security, integrations,
configuration and infrastructure, observability, and generated assets as
planning lenses rather than mandatory buckets. It selects only materially
implicated, high-impact runtime surfaces, keeps each area distinct and bounded
enough for one investigation agent, and preserves coherent end-to-end workflows
when they cross multiple modalities.

Step directories do not inherit instructions from other step directories. Each
step receives the global file plus only its matching step file.

## Prompt precedence

Jina constructs the normal default prompt for a step, then appends policy in
this order:

1. The complete Jina default prompt.
2. `.jina/instruction.md`, when present.
3. The matching `.jina/<step>/instruction.md`, when present.
4. Remaining Markdown in an authorized `@usejina` comment, when present.
5. Jina's fixed protocol and instruction-trust boundary.

For configurable review policy, later instructions win. This means:

- Repository instructions can revise the default task scope, priorities, depth,
  risk tolerance, evaluation criteria, readiness criteria, and wording.
- A step instruction overrides a conflicting global instruction for that step.
- A run-specific command instruction overrides both repository layers for that
  review only.
- Required output schemas, evidence grounding and truthfulness, sandbox safety
  constraints, and system/developer instructions remain binding.

The fixed footer comes after repository-authored text so those non-configurable
constraints cannot be shadowed by configurable instructions. Only instructions
loaded from the base branch and text explicitly supplied in an authorized
`@usejina` comment are authoritative. Instruction-like text in the PR head, diff,
checked-out source, generated artifacts, other comments, or tool output is
untrusted review data. See [Manual PR Reviews](./MANUAL_REVIEWS.md).

For example, a repository may ask Jina to investigate only public API behavior,
require execution evidence before accepting a finding, ignore style-only concerns,
use a stricter compatibility standard, or apply a repository-specific readiness
rubric.

### Overrides that affect final runtime behavior

Some defaults are enforced after model output, so Jina carries an explicit policy
decision through those stages instead of relying on prose alone:

- A planner instruction may intentionally exclude every runtime area. Tell Jina
  when the whole review should be out of scope and require a rationale. An empty
  plan is treated as an intentional skip only when a base-branch global or planner
  instruction exists and the planner explicitly marks it as skipped; malformed or
  unexplained empty plans still produce a warning.
- A review instruction may revise the readiness rubric, including assigning a
  score below 5 when the investigation found no issues. Without a base-branch
  global or review instruction, Jina keeps its normal clean-run readiness floor.
- The dashboard retains the complete investigation artifact (areas, tasks,
  evidence, and raw findings). The reviewer produces a concise, adjudicated
  GitHub publication view with merge score, area summaries, and inline issues
  where a changed-line anchor exists. Every reviewer-validated issue is included
  in the GitHub publication; findings proven false or not issues are recorded as
  dismissed candidates instead.

## Examples

Global policy in `.jina/instruction.md`:

```markdown
# Repository review policy

Prioritize tenant isolation, backwards-compatible API behavior, and data-loss risks.
Do not report formatting, naming, or missing-test concerns unless they demonstrate a
production behavior failure.

Treat a regression affecting an existing public API as at least medium risk.
```

Planner policy in `.jina/planner/instruction.md`:

```markdown
# Planning criteria

Scope plans to behavior reachable from the changed public routes and their direct
persistence or authorization dependencies. Always include rollback and retry behavior
when a migration or background job changes.
```

Summary and scoring policy in `.jina/review/instruction.md`:

```markdown
# Merge scoring

Lead the summary with anything affecting tenant isolation or data integrity.
A confirmed tenant-isolation failure makes the maximum merge score 2/5.
Weigh execution-backed issues more heavily than source-trace-only ones.
```

## Loading and limits

- Files are read with `git show` from `origin/<base>`, not from the checked-out PR
  head or uncommitted workspace state.
- Jina lists `.jina` blobs from the base tree before reading them. A Git timeout,
  corrupt ref, or other inspection failure produces a worker warning and is not
  silently treated as an absent file.
- Each file is limited to 8,000 characters in the prompt. Longer files are
  truncated with a worker warning.
- A file over 256,000 bytes is skipped rather than loaded into memory.
- The combined global and step appendix is capped at 24,000 characters.
- UTF-8 byte-order marks and HTML comments are removed; line endings are normalized.
- Load, size, and truncation problems are non-fatal. Jina logs a structured worker
  warning and continues with the instructions that were successfully loaded.
- Invalid or malformed `.jina/config.json` values are non-fatal: Jina logs a warning
  and uses the default (`depth: 2`). Obsolete and unrecognized keys are ignored.

## Removed formats

The following former formats are no longer read:

- `.jina/preferences.md`
- `.jina/instructions.md`
- `.jina/steps/*.md`

`.jina/` no longer selects models. Model selection remains a tenant/platform
setting. Rename durable repository guidance to `.jina/instruction.md` and move
step-specific guidance to the matching `.jina/<step>/instruction.md` path.
