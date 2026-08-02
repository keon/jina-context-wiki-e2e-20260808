# Runtime Review Evals

This folder contains Golden Dataset 1 and an isolated helper for evaluating the active runtime review pipeline.

Dataset files:

- [`golden-dataset-1.md`](./golden-dataset-1.md): human-readable regression PR dataset with evidence summaries.
- [`golden-dataset-1.json`](./golden-dataset-1.json): structured equivalent used by the helper.

Active helper:

- [`run-isolated-review-v1.mjs`](./run-isolated-review-v1.mjs): runs the current consolidated Trigger `review` workflow's runtime implementation locally against one golden-dataset PR.

The removed scenario-generation and scenario-simulation production paths are no longer evaluated here.

## Run A Runtime Review Eval

Example for Golden Dataset E1 in `manaflow-ai/cmux`:

```sh
cd evals
node run-isolated-review-v1.mjs \
  --repo manaflow-ai/cmux \
  --pr 2467
```

The default output directory is:

```text
evals/runs/golden-dataset-1/<repo-safe>/pr-<N>/review-runtime-v1
```

The helper does not enqueue Trigger.dev, call the internal API, create Daytona sandboxes, or publish GitHub reviews/comments. It runs a temporary worker copy of `trigger/src/runtime-review/index.ts#runRuntimeReview` locally, applies eval-only checkout/artifact/isolation patches to that copy, and writes runtime review artifacts.

For quick smoke runs, use eval-only caps such as `--max-expectations`, `--area-concurrency`, and `--max-agent-iterations`. Omitting those caps uses production runtime options.

Credential lookup is non-interactive. The helper uses `--github-token`, `GITHUB_TOKEN`, `GH_TOKEN`, `gh auth token`, or `git credential fill`, in that order.
