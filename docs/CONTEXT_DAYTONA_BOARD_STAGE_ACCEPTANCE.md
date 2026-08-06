# Daytona Board-stage acceptance

Use `scripts/context-daytona-board-stage-e2e.mjs` to retain one real
production-shaped Board agent-stage proof before a production Context build.
The harness calls the same low-level `DaytonaBoardAgentStageRunner` selected by
the worker adapter. It does not call the simpler authentication preflight and
does not substitute a fake executor.

The proof is deliberately small. It sends a commit-pinned repository archive,
asks Codex to read the committed root `package.json`, returns a strict JSON
result, and writes one declared Markdown output. The host independently checks
the package name, commit binding, canonical result bytes, envelope digest,
model usage, output digest, snapshot identity, and sandbox cleanup.

This proves the low-level agent-stage boundary used by checkpointed planner and page
phases. It does not prove that an internal phase name is a claimable Board topic; the
active queue exposes only snapshot, planner, page, and publication topics.

## Authentication boundary

The Daytona API credential is accepted only through `DAYTONA_API_KEY`. The
model credential is never accepted by this script and is never copied from the
host. The sandbox receives only the configured Daytona organization Secret
name:

```text
CONTEXT_DAYTONA_MODEL_SECRET=jina-context-openai
CONTEXT_DAYTONA_MODEL_SECRET_ENV=OPENAI_API_KEY
```

Daytona injects an opaque placeholder and substitutes the real credential only
for `api.openai.com`. The retained manifest records the Secret name and allowed
host, never its value or placeholder.

The host's current Codex/ChatGPT session is not used in Daytona mode.
`CODEX_HOME`, `CONTEXT_CODEX_AUTH`, and host model-key variables are not
forwarded. Local current-session acceptance is a separate executor path and
must not be described as a production Daytona proof.

## Prerequisites

- Node, pnpm, Git, and a `tar` implementation with `--format ustar`;
- access to the exact repository commit being proved;
- an enabled GCP Secret Manager version for `jina-daytona-api-key`;
- an active immutable Daytona snapshot containing the expected Codex CLI;
- the `jina-context-openai` organization Secret restricted to
  `api.openai.com`; and
- Daytona permissions to read snapshot metadata, create/delete ephemeral
  sandboxes, and list sandboxes by label.

Snapshot reads and post-run sandbox listing are mandatory. The harness fails
closed if metadata is unavailable, the snapshot identity changes during the
run, a matching sandbox remains, or cleanup cannot be observed.

## Run

Choose a new retained directory and an explicit full commit SHA. Do not put
credential values in command-line arguments.

```bash
commit_sha="$(git rev-parse HEAD)"
retained_dir="$(pwd)/retained/daytona-board-stage-${commit_sha}"

DAYTONA_API_KEY="$(gcloud secrets versions access latest \
  --project=jina-v2 \
  --secret=jina-daytona-api-key)" \
CONTEXT_DAYTONA_SNAPSHOT=jina-context-board-codex-0-145-0-bwrap-v2 \
CONTEXT_DAYTONA_MODEL_SECRET=jina-context-openai \
CONTEXT_DAYTONA_MODEL_SECRET_ENV=OPENAI_API_KEY \
CONTEXT_DAYTONA_MODEL_DOMAINS=api.openai.com \
CONTEXT_CODEX_MODEL=gpt-5.6-terra \
CONTEXT_CODEX_EFFORT=low \
CONTEXT_CODEX_VERBOSITY=high \
CONTEXT_CODEX_CONTEXT_TOKENS=128000 \
CONTEXT_CODEX_COMPACT_TOKENS=96000 \
pnpm evaluate:context-daytona-board-stage -- \
  --repository "$(pwd)" \
  --commit "$commit_sha" \
  --stage-id "daytona-board-${commit_sha:0:12}" \
  --output-dir "$retained_dir"
```

The command builds the Daytona package and worker adapter before execution.
Those two build subprocesses receive an explicitly empty `DAYTONA_API_KEY`; the
original environment value is available again only to the final harness
process.
The archive contains only the requested commit. Dirty and untracked worktree
files are excluded. Git's PAX archive is extracted and repacked in sorted
`ustar+gzip` form because the production runner rejects extended global-header
entries.

Do not rerun into an existing non-empty directory. Use a new stage ID and
retained directory for every attempt.

## Retained files

```text
<output-dir>/
  manifest.json
  result.json
  files/
    proof.md
```

Every retained file is mode `0600`; the directory is mode `0700`.

- `manifest.json` records the commit and archive digest, strict-schema digest,
  snapshot name/ID/read-only metadata before and after, Secret name, exact
  allowlist, model settings, canonical envelope digest and byte length, model
  usage, declared-output hashes, cleanup attempts, and violations.
- `result.json` is the exact canonical byte payload returned by the Board-stage
  envelope.
- `files/proof.md` is the exact declared output returned by the sandbox.

The run passes only when `manifest.json` has `"status": "passed"`,
`cleanup.status` is `passed`, no violations exist, and the retained file hashes
match their bytes. Any runner failure, malformed envelope, non-canonical JSON,
usage mismatch, secret echo, undeclared/missing output, snapshot replacement,
residual sandbox, or cleanup observation error exits nonzero.

## Hermetic test

```bash
pnpm test:context-daytona-board-stage
```

The test suite creates temporary Git repositories and fake Daytona
runner/observer boundaries. It proves deterministic commit archives, dirty-file
exclusion, exact low-level runner input, canonical envelope retention,
mode-`0600` evidence, host-session exclusion, snapshot continuity, secret
redaction, and fail-closed residual/uncertain cleanup. It never contacts
Daytona or GCP.
