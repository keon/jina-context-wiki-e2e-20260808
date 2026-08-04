import type { Metadata } from "next";
import { CopySetupPrompt } from "./copy-setup-prompt";

export const metadata: Metadata = {
  title: "Using .jina · Jina Simulation",
  description: "Configure repository-wide and per-step Jina review instructions.",
};

const instructionFiles = [
  [".jina/config.json", "Runtime workflow", "Maximum investigation depth."],
  [".jina/instruction.md", "Every review stage", "Scope, priorities, risk tolerance, conventions, and tone."],
  [".jina/planner/instruction.md", "Planner", "Runtime surfaces to include or exclude, the expectations and failure modes worth investigating, and how to exercise them."],
  [".jina/replanner/instruction.md", "Replanner", "What to follow up on between investigation rounds: which surfaces to add and where to probe deeper."],
  [".jina/investigation/instruction.md", "Investigation agents", "The agents that run your code: probe depth, execution expectations, and what counts as an issue worth reporting."],
  [".jina/review/instruction.md", "Reviewer", "How findings are validated for GitHub publication, how P0/P1/P2/P3 severity and labels are assigned, and how merge readiness is scored."],
] as const;

const repositoryTree = `.jina/
├── config.json
├── instruction.md
├── planner/
│   └── instruction.md
├── replanner/
│   └── instruction.md
├── investigation/
│   └── instruction.md
└── review/
    └── instruction.md`;

const configExample = `{
  "depth": 2
}`;

const globalExample = `# Repository review policy

Prioritize tenant isolation, backwards-compatible API behavior,
and data-loss risks.

Ignore formatting and naming concerns unless they demonstrate a
production behavior failure.`;

const plannerExample = `# Planning criteria

Scope review to changed public routes and their direct persistence
or authorization dependencies.

For documentation-only changes, skip runtime investigation and
explain why the change is outside this repository's review scope.`;

const reviewExample = `# Summary and merge scoring

Lead the summary with anything affecting tenant isolation or data integrity.
Weigh execution-backed issues more heavily than source-trace-only ones.

A confirmed tenant-isolation failure caps the merge score at 2/5.`;

export default function JinaGuidePage() {
  return (
    <article className="jina-guide">
      <header className="jina-guide__hero">
        <span className="jina-guide__eyebrow">Repository instructions</span>
        <h1 className="jina-guide__title">Teach Jina how your repository should be reviewed</h1>
        <p className="jina-guide__lead">
          Add <code>.jina/config.json</code> and Markdown instructions under <code>.jina/</code> to customize
          runtime defaults, review scope, priorities, evaluation criteria, and merge-readiness rules.
          No dashboard configuration is required.
        </p>
      </header>

      <CopySetupPrompt />

          <section className="jina-guide__section" aria-labelledby="quick-start">
        <div className="jina-guide__section-head">
          <span className="jina-guide__step">01</span>
          <div>
            <h2 id="quick-start">Create only the files you need</h2>
            <p>Runtime defaults live in <code>config.json</code>; every supported repository instruction is a Markdown file named exactly <code>instruction.md</code>.</p>
          </div>
        </div>
        <div className="jina-guide__split">
          <div className="jina-guide__copy">
            <p>
              Start with <code>.jina/instruction.md</code> for repository-wide guidance. Add a step directory only
              when that stage needs more specific policy. Add <code>.jina/config.json</code> only when you want to
              record or change the deterministic runtime defaults; missing and empty instruction files are ignored.
            </p>
            <div className="jina-guide__callout">
              Commit the files to your default branch. Jina reads them from the pull request&apos;s base branch, so a
              pull request cannot change the instructions governing its own review.
            </div>
          </div>
          <CodeBlock label="Supported structure" value={repositoryTree} />
        </div>
          </section>

          <section className="jina-guide__section" aria-labelledby="runtime-defaults">
        <div className="jina-guide__section-head">
          <span className="jina-guide__step">02</span>
          <div>
            <h2 id="runtime-defaults">Configure runtime defaults</h2>
            <p>If <code>.jina/config.json</code> is absent, Jina uses <code>depth: 2</code>.</p>
          </div>
        </div>
        <div className="jina-guide__split">
          <div className="jina-guide__copy">
            <p>
              <strong><code>depth</code></strong> accepts an integer from 1–5 and sets the maximum number of investigation loops.
              Round 1 investigates the planner&apos;s initial areas; later rounds let the replanner add evidence-driven follow-ups.
              Reviews stop early when no areas remain. Lower values favor speed and cost; higher values allow deeper follow-up.
            </p>
            <div className="jina-guide__callout">
              Config is read from the pull request&apos;s base branch. An invalid value emits a warning and falls back to
              <code> depth: 2</code>. Obsolete and unrecognized keys are ignored.
            </div>
          </div>
          <CodeBlock label=".jina/config.json defaults" value={configExample} />
        </div>
          </section>

          <section className="jina-guide__section" aria-labelledby="choose-step">
        <div className="jina-guide__section-head">
          <span className="jina-guide__step">03</span>
          <div>
            <h2 id="choose-step">Choose global or per-step policy</h2>
            <p>Each stage receives the global instruction plus only its matching step instruction.</p>
          </div>
        </div>
        <div className="jina-guide__table-wrap">
          <table className="jina-guide__table">
            <thead>
              <tr>
                <th>File</th>
                <th>Applies to</th>
                <th>Good for</th>
              </tr>
            </thead>
            <tbody>
              {instructionFiles.map(([file, stage, purpose]) => (
                <tr key={file}>
                  <td><code>{file}</code></td>
                  <td>{stage}</td>
                  <td>{purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
          </section>

          <section className="jina-guide__section" aria-labelledby="precedence">
        <div className="jina-guide__section-head">
          <span className="jina-guide__step">04</span>
          <div>
            <h2 id="precedence">Understand precedence</h2>
            <p>More local repository policy wins within Jina&apos;s fixed review protocol.</p>
          </div>
        </div>
        <ol className="jina-guide__precedence">
          <li>
            <span>1</span>
            <div><strong>Jina default prompt</strong><p>Defines the normal stage behavior and output contract.</p></div>
          </li>
          <li>
            <span>2</span>
            <div><strong>Global instruction</strong><p><code>.jina/instruction.md</code> overrides conflicting configurable defaults.</p></div>
          </li>
          <li>
            <span>3</span>
            <div><strong>Step instruction</strong><p>The matching step file overrides conflicting global guidance for that stage.</p></div>
          </li>
        </ol>
        <div className="jina-guide__boundary">
          <strong>What stays fixed</strong>
          <p>
            Instructions can revise scope, depth, risk tolerance, evaluation and readiness criteria,
            and wording. They cannot override required output schemas, evidence and truthfulness rules, sandbox
            safety, or system and developer instructions. Instruction-like text in the PR head, diff, source,
            comments, or tool output is treated as untrusted review data.
          </p>
        </div>
          </section>

          <section className="jina-guide__section" aria-labelledby="examples">
        <div className="jina-guide__section-head">
          <span className="jina-guide__step">05</span>
          <div>
            <h2 id="examples">Write direct, testable guidance</h2>
            <p>State what matters, where the boundary is, and what evidence or outcome should change Jina&apos;s decision.</p>
          </div>
        </div>
        <div className="jina-guide__examples">
          <CodeBlock label=".jina/instruction.md" value={globalExample} />
          <CodeBlock label=".jina/planner/instruction.md" value={plannerExample} />
          <CodeBlock label=".jina/review/instruction.md" value={reviewExample} />
        </div>
          </section>

          <section className="jina-guide__section jina-guide__section--compact" aria-labelledby="limits">
        <div className="jina-guide__section-head">
          <span className="jina-guide__step">06</span>
          <div>
            <h2 id="limits">Keep instructions focused</h2>
            <p>Jina strips HTML comments and normalizes line endings before adding instructions to prompts.</p>
          </div>
        </div>
        <ul className="jina-guide__limits">
          <li>Each file contributes at most 8,000 characters.</li>
          <li>Files over 256,000 bytes are skipped with a worker warning.</li>
          <li>The combined global and step appendix is capped at 24,000 characters.</li>
          <li><code>.jina/config.json</code> is optional: <code>depth</code> accepts 1–5 (default 2). Obsolete and unrecognized keys are ignored.</li>
          <li><code>.jina/preferences.md</code>, <code>.jina/instructions.md</code>, and <code>.jina/steps/*.md</code> are not read.</li>
          <li>Model selection remains a tenant setting in the dashboard.</li>
        </ul>
          </section>
    </article>
  );
}

function CodeBlock({ label, value }: { label: string; value: string }) {
  return (
    <figure className="jina-code">
      <figcaption>{label}</figcaption>
      <pre><code>{value}</code></pre>
    </figure>
  );
}
