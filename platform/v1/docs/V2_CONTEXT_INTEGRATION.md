# V2 Context integration

V1 owns the GitHub App webhook and code-review workflow. V2 owns Context
derivation, publication, retrieval, and its generic Board tasks.

## Request paths

1. GitHub sends one delivery to `POST https://api.usejina.com/webhooks/github`.
2. V1 verifies the original HMAC and performs its normal idempotent review dispatch.
3. V1 forwards the unchanged body, event, delivery ID, and signature to V2
   `POST /context/webhooks/github`.
4. V2 verifies the GitHub HMAC again and admits only Context work:
   branch pushes, opened/synchronized PRs, and opened issues. Comments and other
   actions are acknowledged without a build. V2 creates no review tasks on this route.

V1 returns an error when the relay fails so GitHub redelivery repairs the handoff.
Both review dispatch and Context admission are idempotent.

## Dashboard

The browser authenticates only to V1. V1 verifies tenant membership and proxies
model-free V2 catalog reads:

- `/context/releases` selects the current published default-branch release;
- `/context/list` supplies document summaries and hierarchy;
- `/context/read` supplies the exact release document and citations; and
- `/context/builds/:id/progress` supplies checkpoint progress after an explicit
  admin build.

The browser receives neither V2 URL nor credentials. A document request carries its
repository and immutable release ID so two repositories cannot resolve an ambiguous ID.

## Review MCP

Before creating a Daytona sandbox, Trigger asks V1
`POST /internal/context/mcp-access` for the exact installation, repository, PR, and
review run. V1 resolves the shared tenant UUID, verifies that V2 has a published
release, and calls V2 `POST /internal/context/review-access`.

V2 returns a one-time opaque bearer for a deterministic run-and-repository principal.
Its ACL contains one repository and its scopes are only `context:query` and
`context:read`. Daytona connects directly to V2 `/mcp` and enables:

- `search_context`
- `list_context`
- `read_context`
- `diff_context`

All four tools are LLM-less. Codex decides how to use the returned context. Review
telemetry retains tool name, stage, status, and a bounded error only; it does not retain
arguments or Context bodies.

## Shared model routing

The existing Models page owns tenant-wide routing for both PR reviews and Context.
It stores four stage models (planner, investigation, review, and Context), an optional
low/medium/high reasoning effort for each, and separate fallback policies for PR
reviews and Context:

- `fail_notify` stops the run and preserves the provider failure in review events or
  the Context task board; and
- `managed` retries once with Jina managed model access and consumes organization
  credits.

Context does not read these settings from the browser. A V2 worker calls V1
`POST /internal/context/execution-profile` with the shared tenant UUID and Context
build ID. V1 creates a write-once profile containing the selected settings and an
encrypted copy of the exact credential revision. Every checkpoint retry for that
build resolves the same profile. Raw credentials are never written to V2 task
metadata, GCS artifacts, public Context documents, or dashboard responses.

For tenant BYOK, Context uses the tenant OpenRouter key, or the tenant OpenAI key
when every selected Context model is OpenAI-family. For Codex, the administrator
who last selected the provider or saved model settings becomes the designated Context credential owner;
their connected Codex credential is used only inside the ephemeral Daytona sandbox.
Managed execution continues to use V2's operator-owned Daytona model secret.

Authentication, exhausted quota/credits, and invalid-model errors fail once and are
shown to the owner instead of consuming automatic retries. Transient provider and
sandbox failures retain the bounded Board retry policy.

## Deployment order and acceptance

Deploy V2 first, then the V1 API, Trigger tasks, and dashboard. Verify:

1. V2 rejects an invalid relay signature.
2. One signed PR delivery creates one Context build and no V2 review task.
3. Redelivery is a no-op and an issue comment creates no build.
4. V1 `/context` lists and reads an existing V2 release.
5. A minted review token lists the four MCP tools, reads its repository, returns not
   found for another repository, and cannot call `/context/build`.
6. A real V1 review receives direct V2 MCP configuration and records a Context tool
   attempt without exposing its token or response.
7. A Context build uses the saved model and effort, retains its profile across a
   checkpoint retry, and follows each fallback policy without exposing credentials.

These checks use an existing release and synthetic signed deliveries. Do not start a
full derivation merely to validate application wiring.
