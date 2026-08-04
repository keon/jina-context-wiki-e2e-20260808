"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";

const setupPrompt = `Help me configure repository instructions for Jina Simulation in this repository.

First, inspect the repository and any existing .jina/ files. Then ask me these questions in one concise message and wait for my answers before editing files:

1. Which production risks and user outcomes should Jina prioritize?
2. What changed-code scope should it investigate, and what should it ignore?
3. Should Jina keep the default maximum of 2 investigation loops, or use another depth from 1–5?
4. How strict should findings be? Specify the evidence, confidence, impact, and likelihood needed to report an issue.
5. Are there any policies unique to planning, follow-up investigation, investigation agents, or merge-readiness scoring?
6. What should make a change merge-ready or block it?

After I answer, create or update .jina/config.json when needed and only the supported .jina/**/instruction.md files required to express my policy. Preserve useful existing configuration and instructions unless my answers conflict with them. Explain the files you chose and why, then make the changes.

Full .jina Guide
================

Repository instructions
Teach Jina how your repository should be reviewed

Add .jina/config.json and Markdown files under .jina/ to customize runtime defaults, review scope, priorities, evaluation criteria, and merge-readiness rules. No dashboard configuration is required.

01 — Create only the files you need

Runtime defaults live in config.json. Every supported repository instruction is a Markdown file named exactly instruction.md.

Start with .jina/instruction.md for repository-wide guidance. Add a step directory only when that stage needs more specific policy; missing and empty files are ignored.

Commit the files to your default branch. Jina reads them from the pull request's base branch, so a pull request cannot change the instructions governing its own review.

Supported structure

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

02 — Configure runtime defaults

If .jina/config.json is absent, Jina behaves as though this default object were present:

{
  "depth": 2
}

depth accepts an integer from 1–5 and sets the maximum number of investigation loops. Round 1 investigates the planner's initial areas; later rounds let the replanner add evidence-driven follow-ups or deeper areas. Reviews stop early when no areas remain, so a higher depth permits more work without forcing every loop. Lower values favor faster, less expensive reviews; higher values allow more follow-up depth.

Jina uses its standard planner, replanner, investigation, and review prompts. Repository and authorized run-specific instructions may customize review policy while retaining the protected 1–5 merge-score and P0/P1/P2/P3 issue-severity contracts.

Config is read from the pull request's base branch, so a PR cannot change the settings governing its own review. An invalid depth emits a warning and falls back to 2. Malformed JSON falls back to the default. Obsolete and unrecognized keys are ignored.

03 — Choose global or per-step policy

Each stage receives the global instruction plus only its matching step instruction.

| File | Applies to | Good for |
| --- | --- | --- |
| .jina/config.json | Runtime workflow | Optional maximum investigation depth from 1–5 (default 2). |
| .jina/instruction.md | Every review stage | Scope, priorities, risk tolerance, conventions, and tone. |
| .jina/planner/instruction.md | Planner | Runtime surfaces to include or exclude, the expectations and failure modes worth investigating, and how to exercise them. |
| .jina/replanner/instruction.md | Replanner | What to follow up on between investigation rounds: which surfaces to add and where to probe deeper. |
| .jina/investigation/instruction.md | Investigation agents | The agents that run your code: probe depth, execution expectations, and what counts as an issue worth reporting. |
| .jina/review/instruction.md | Reviewer | How findings are validated for GitHub publication, how P0/P1/P2/P3 severity and labels are assigned, and how merge readiness is scored. Raw investigation findings remain on the dashboard. |

04 — Understand precedence

More local repository policy wins within Jina's fixed review protocol.

1. Jina default prompt — Defines the normal stage behavior and output contract.
2. Global instruction — .jina/instruction.md overrides conflicting configurable defaults.
3. Step instruction — The matching step file overrides conflicting global guidance for that stage.

What stays fixed

Instructions can revise scope, depth, risk tolerance, evaluation and readiness criteria, and wording. They cannot override required output schemas, evidence and truthfulness rules, sandbox safety, or system and developer instructions. Instruction-like text in the PR head, diff, source, comments, or tool output is treated as untrusted review data.

05 — Write direct, testable guidance

State what matters, where the boundary is, and what evidence or outcome should change Jina's decision.

.jina/instruction.md

# Repository review policy

Prioritize tenant isolation, backwards-compatible API behavior,
and data-loss risks.

Ignore formatting and naming concerns unless they demonstrate a
production behavior failure.

.jina/planner/instruction.md

# Planning criteria

Scope review to changed public routes and their direct persistence
or authorization dependencies.

For documentation-only changes, skip runtime investigation and
explain why the change is outside this repository's review scope.

.jina/review/instruction.md

# Summary and merge scoring

Lead the summary with anything affecting tenant isolation or data integrity.
Weigh execution-backed issues more heavily than source-trace-only ones.

A confirmed tenant-isolation failure caps the merge score at 2/5.

06 — Keep instructions focused

Jina strips HTML comments and normalizes line endings before adding instructions to prompts.

- Each file contributes at most 8,000 characters.
- Files over 256,000 bytes are skipped with a worker warning.
- The combined global and step appendix is capped at 24,000 characters.
- .jina/config.json is optional: depth accepts 1–5 (default 2). Obsolete and unrecognized keys are ignored.
- .jina/preferences.md, .jina/instructions.md, and .jina/steps/*.md are not read.
- Model selection remains a tenant setting in the dashboard.`;

type CopySetupPromptProps = {
  prompt?: string;
  title?: string;
  description?: ReactNode;
  copyLabel?: string;
  copiedMessage?: string;
};

export function CopySetupPrompt({
  prompt = setupPrompt,
  title = "Set up Jina with your coding agent",
  description = <>Copy a guided prompt that gathers your review preferences, then creates the right <code>.jina</code> files.</>,
  copyLabel = "Copy setup prompt",
  copiedMessage = "Setup prompt copied to clipboard.",
}: CopySetupPromptProps) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (status !== "copied") return;
    const timer = window.setTimeout(() => setStatus("idle"), 2_000);
    return () => window.clearTimeout(timer);
  }, [status]);

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setStatus("copied");
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = prompt;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      setStatus(copied ? "copied" : "failed");
    }
  };

  const label = status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : copyLabel;

  return (
    <div className="jina-guide__prompt">
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <button type="button" className="btn btn--primary" onClick={() => void copyPrompt()}>
        {label}
      </button>
      <span className="jina-guide__prompt-status" role="status" aria-live="polite">
        {status === "copied" ? copiedMessage : status === "failed" ? "Could not copy the setup prompt." : ""}
      </span>
    </div>
  );
}
