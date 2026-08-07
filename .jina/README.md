# Jina Repository Instructions

Repositories customize Jina's review prompts with Markdown files named exactly
`instruction.md`:

```text
.jina/
├── instruction.md                  # global; appended to every stage
├── planner/instruction.md          # round-1 planning: infer intent, choose areas to investigate
├── replanner/instruction.md        # between rounds: add follow-up areas and deepen directives
├── investigation/instruction.md    # the agents that run code to find production issues
└── review/instruction.md           # final summary and merge scoring
```

One step per model-backed stage, in pipeline order. The former `intent/` and
`mental-trace/` steps are gone (intent is now inferred by the planner, and
investigation agents execute directly instead of using a trace tool); files at
those paths are no longer read.

Jina reads these files from the pull request's base branch, not its head. It
appends the global instruction and then the matching step instruction after the
step's default prompt. Repository instructions can revise review scope,
priorities, strictness, and evaluation criteria; the step instruction wins when
it conflicts with the global instruction. Jina then restores its fixed output,
evidence, safety, and base-branch trust rules after repository-authored text.

Base-branch planner policy can explicitly skip all runtime areas, and base-branch
review policy can revise clean-readiness scoring. Empty plans are not honored
without the matching repository policy. Issues are never filtered: every issue the
investigation finds is published, so a review instruction shapes how the review is
summarized and scored, not which issues are reported.

The old `.jina/config.json`, `.jina/preferences.md`, `.jina/instructions.md`, and
`.jina/steps/*.md` formats are not read.

See [`docs/JINA_INSTRUCTIONS.md`](../docs/JINA_INSTRUCTIONS.md) for precedence,
examples, supported override boundaries, and file limits.
