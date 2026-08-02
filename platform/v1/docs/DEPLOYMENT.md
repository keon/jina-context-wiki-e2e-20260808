# Deployment

Production has three deployable surfaces:

- API: Cloud Run service built from `api/Dockerfile`.
- Trigger.dev workers: deployed from `trigger/`.
- Dashboard: Next.js app deployed separately, typically to Vercel.

For runtime behavior and task routing, see [Architecture](./ARCHITECTURE.md).

For the isolated staging environment — GitHub Environment variables, staging
secret names, Trigger.dev project setup, and deploy order — see
[Staging Environment](./STAGING.md). For the full source-of-truth map of
environment variables and secrets, see
[Environment Variables and Secrets](./ENVIRONMENT_AND_SECRETS.md).

## Environment Source Of Truth

Use one canonical variable per active setting:

| Setting | Canonical env var | Notes |
| --- | --- | --- |
| OpenRouter key | `OPENROUTER_API_KEY` | The only model gateway credential. `CODEX_API_KEY`/`OPENAI_API_KEY` are no longer used. |
| Dashboard URL | `DASHBOARD_URL` | Used for links, OAuth redirects, and default credentialed CORS origin. |
| Extra dashboard origins | `DASHBOARD_ORIGIN` | Optional comma-separated extras only. |
| GitHub App install URL | `GITHUB_APP_SLUG` | Preferred. `GITHUB_APP_INSTALL_URL` is an optional override. |
| PR review task | code constant `review` | Not configured by env. |
| Backfill task | code constant `github-installation-backfill` | Not configured by env. |

Configure the GitHub App **Setup URL** as
`$DASHBOARD_URL/integrations` and enable redirect-on-update. GitHub returns the
installation id and routing state there; the dashboard then asks the API to
attach that verified installation to the selected Jina tenant.

Removed current-flow config includes `TRIGGER_REVIEW_TASK_ID`, Anthropic/Claude vars, `CODEX_ARGS`, `CLAUDE_ARGS`, `JUDGE_PROVIDER`, `MODEL_TIMEOUT_MS`, and `SCENARIO_*`.

## Prerequisites

Create and configure:

- A GitHub App with webhook delivery to `https://api.usejina.com/webhooks/github`.
- A GitHub OAuth App for dashboard sign-in with callback `https://api.usejina.com/auth/github/callback`.
- A Trigger.dev project.
- A Daytona account/API key.
- A Postgres database, currently Cloud SQL in production.
- An OpenRouter API key (the only model gateway credential).
- Google Cloud project resources for Cloud Run, Cloud SQL, Artifact Registry, and Workload Identity Federation.

The GitHub App needs:

- Repository contents read access.
- Pull request read access.
- `pull_requests:write` to publish runtime review feedback.
- Installation and installation repository webhooks for backfill.
- Pull request webhooks for reviews.
- Issue-comment and pull-request-review-comment webhooks for manual `@usejina`
  reviews.
- Issues read access for top-level commands. Pull requests must remain writable
  so Jina can read inline parents and publish results.

## Database

Apply migrations before real webhook traffic reaches a new environment:

```bash
cd api
npm ci
DATABASE_URL=postgres://... npm run migrate
```

## API On Cloud Run

The API deploy workflow is `.github/workflows/deploy-api.yml`.

It runs on pushes to `main` (the `Production` GitHub Environment) and to
`staging` (the `Staging` GitHub Environment), and supports manual
`workflow_dispatch` with a `target_environment` choice. Manual staging deploys
must be dispatched from the `staging` branch/ref; the workflow rejects a
`Staging` deploy from any other branch and a `Production` deploy from any branch
other than `main`.

Required GitHub Actions variables:

- `GCP_PROJECT_ID`
- `GCP_REGION`
- `CLOUD_RUN_SERVICE`
- `ARTIFACT_REGISTRY_REPOSITORY`
- `CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT`
- `JINA_DASHBOARD_URL`
- `JINA_API_BASE_URL`
- `JINA_GITHUB_APP_ID`
- `JINA_GITHUB_APP_SLUG` or `JINA_GITHUB_APP_INSTALL_URL`
- `JINA_GITHUB_OAUTH_CLIENT_ID`
- `JINA_GITHUB_OAUTH_SCOPES`
- `JINA_TRIGGER_API_URL`

Optional variables:

- `JINA_DASHBOARD_ORIGIN`: extra comma-separated dashboard origins. `JINA_DASHBOARD_URL` is always allowed. Wildcard origins are rejected because dashboard requests are credentialed.
- `JINA_BILLING_ENFORCE`: `off`/`shadow`/`on`. When set, the deploy also mounts the Autumn secret.
- `JINA_GRAPH_API_URL`: HTTPS origin of the V2 Context API. Set this with `GRAPH_API_TOKEN_SECRET_NAME` to enable Context.
- `JINA_GRAPH_REQUEST_TIMEOUT_MS`: optional timeout for V2 API requests and webhook relay; defaults to 20,000 ms.

### V2 Context integration

When `JINA_GRAPH_API_URL` is set, the API deploy workflow mounts the static
`JINA_GRAPH_API_TOKEN` from the Secret Manager secret named by
`GRAPH_API_TOKEN_SECRET_NAME` (production defaults to
`jina-graph-api-token`; staging must use a staging-scoped name). The API still
requires both the URL and static token, even when delegated tokens are enabled.

Provide V2's `INTERNAL_API_TOKEN` to the API runtime as
`JINA_GRAPH_INTERNAL_TOKEN`. The API mints and caches a dashboard token per tenant,
renews it before expiry, and revokes the old token after replacement. For a review,
it requests a separate exact-repository token and returns the direct V2 `/mcp` URL
to Trigger; V1 does not proxy MCP. `JINA_GRAPH_DELEGATED_TOKEN_TTL_MINUTES` controls
only the dashboard token and defaults to 15 minutes with a 5-minute floor.

The deploy workflow wires the graph URL, request timeout, and static graph
token unconditionally. It also mounts `JINA_GRAPH_INTERNAL_TOKEN` and the
delegated TTL, but only when the `GRAPH_INTERNAL_TOKEN_SECRET_NAME` repository
variable names a Secret Manager secret. Production review MCP requires that variable;
without it dashboard reads may use the static fallback, but review access fails closed.

The production GitHub App webhook remains `https://api.usejina.com/webhooks/github`.
V1 relays the exact raw body and GitHub signature to V2
`/context/webhooks/github`; deploy V2 before V1 so the relay endpoint exists at
cutover.

Non-production environments must set GitHub Environment variables that override
the production Secret Manager and Cloud SQL defaults so a staging deploy can
never touch production resources. The workflow rejects staging deploys that omit
these or point at production names. Staging service names, runtime service
accounts, public origins, the Cloud SQL instance, and every Secret Manager name
must contain `staging`:

- `CLOUD_SQL_INSTANCE` (production default `jina-db`)
- `WEBHOOK_SECRET_NAME` (production default `jina-github-webhook-secret`)
- `INTERNAL_API_TOKEN_SECRET_NAME` (production default `jina-internal-api-token`)
- `TRIGGER_SECRET_KEY_SECRET_NAME` (production default `jina-trigger-secret-key`)
- `OAUTH_CLIENT_SECRET_NAME` (production default `jina-github-oauth-client-secret`)
- `DATABASE_URL_SECRET_NAME` (production default `jina-database-url`)
- `ENCRYPTION_KEY_SECRET_NAME` (production default `jina-secrets-encryption-key`)
- `GITHUB_APP_PRIVATE_KEY_SECRET_NAME` (production default `jina-github-app-private-key`)
- `AUTUMN_SECRET_KEY_SECRET_NAME` (production default `jina-autumn-secret-key`; required only when billing is enabled)
- `GRAPH_API_TOKEN_SECRET_NAME` (production default `jina-graph-api-token` when Context integration is enabled; staging must use a distinct staging-scoped value)
- `GRAPH_INTERNAL_TOKEN_SECRET_NAME` (Secret Manager name for V2's internal token when delegated dashboard tokens or review MCP are enabled; staging must use a staging-scoped value)
- `ALLOW_DEV_TRIGGER_SECRET_IN_DEPLOY` (default `false`; set `true` only to intentionally deploy against a `tr_dev_*` Trigger key)

`JINA_API_BASE_URL` and `JINA_DASHBOARD_URL` must both be HTTPS origins in production because OAuth callbacks and cross-site Secure cookies depend on them.

Required GitHub Actions secrets:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_SERVICE_ACCOUNT`

Required Secret Manager secrets:

- `jina-github-webhook-secret`
- `jina-github-app-private-key` — mounted into the API for collaborator checks
  and PR lookups used by manual review commands.
- `jina-internal-api-token`
- `jina-trigger-secret-key`
- `jina-github-oauth-client-secret`
- `jina-database-url`
- `jina-secrets-encryption-key` — REQUIRED: the API refuses to boot in
  production without it (provider keys and OAuth bindings are AES-256-GCM
  encrypted with it). Base64-encoded 32 bytes (`openssl rand -base64 32`).
  The deploy workflow validates its presence and shape before deploying.
  Never rotate it casually — stored secrets become undecryptable.
- `jina-autumn-secret-key` — optional; mounted only when the
  `JINA_BILLING_ENFORCE` repo variable is set (off|shadow|on). Currently
  holds the Autumn sandbox (test-mode) key; replace with the live key before
  production billing.
- `jina-graph-api-token` — required only when `JINA_GRAPH_API_URL` is set;
  mounted as `JINA_GRAPH_API_TOKEN` for the static Context dashboard fallback.
  Staging must use a distinct Context secret.

V2 Context's internal credential is optional for the static dashboard fallback.
To enable delegated dashboard tokens or direct review MCP access, store V2's
`INTERNAL_API_TOKEN` in Secret Manager and set the
`GRAPH_INTERNAL_TOKEN_SECRET_NAME` repository variable to its name; the deploy
workflow then mounts it as `JINA_GRAPH_INTERNAL_TOKEN`.

`jina-trigger-secret-key` must be a production Trigger.dev secret key in production. A `tr_dev_*` key creates development runs that require `trigger dev`.

## Trigger.dev Workers

The Trigger deploy workflow is `.github/workflows/deploy-trigger.yml`.

Like the API workflow, it runs on `main` (`Production`) and `staging`
(`Staging`) and supports `workflow_dispatch` with a `target_environment` choice
that must match the branch. Staging deploys read only `JINA_*` GitHub
Environment values; generic repository-level fallback names (e.g.
`TRIGGER_ACCESS_TOKEN`, `OPENROUTER_API_KEY`) are ignored so staging cannot
pick up a production credential. Staging additionally requires `API_BASE_URL`
and `DASHBOARD_URL` to contain `staging`.

Required Trigger deployment config:

- `TRIGGER_ACCESS_TOKEN` for production, or `JINA_TRIGGER_ACCESS_TOKEN` for staging
- `TRIGGER_PROJECT_REF`
- `API_BASE_URL`
- `DASHBOARD_URL`
- `DAYTONA_API_KEY`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `INTERNAL_API_TOKEN`
- `OPENROUTER_API_KEY` (GitHub secret `JINA_OPENROUTER_API_KEY`) — the model
  gateway credential for managed reviews. Required. Optional attribution
  vars: `JINA_OPENROUTER_APP_URL`, `JINA_OPENROUTER_APP_TITLE`.

The deployed worker environment syncs `OPENROUTER_API_KEY`; the legacy
direct-OpenAI path (`OPENAI_API_KEY`/`CODEX_API_KEY`/`JINA_LEGACY_OPENAI_KEYS`)
was removed after all workers moved to OpenRouter.

`trigger/trigger.config.ts` controls which runtime variables are synced into Trigger.dev. Keep that list small and limited to values used by active tasks.

## Daytona

The current review flow creates Daytona sandboxes for `review-context` and `runtime-review`.

Default sandbox settings:

- Image: `node:22-bookworm`
- CPU: `4`
- Memory: `8`
- Disk: `10`

Optional controls:

- `DAYTONA_SNAPSHOT`
- `DAYTONA_SANDBOX_IMAGE`
- `DAYTONA_SANDBOX_CPU`
- `DAYTONA_SANDBOX_MEMORY`
- `DAYTONA_SANDBOX_DISK`
- `DAYTONA_SKIP_INSTALL`
- `DAYTONA_SETUP_TIMEOUT_SECONDS`
- `DAYTONA_RUN_TIMEOUT_SECONDS`
- `DAYTONA_RESULT_DOWNLOAD_TIMEOUT_SECONDS`

Higher configured resource values are capped before sandbox creation.

## Dashboard

Production dashboard env:

```text
NEXT_PUBLIC_API_BASE_URL=https://api.usejina.com
```

The API must separately know the dashboard URL:

```text
DASHBOARD_URL=https://app.usejina.com
DASHBOARD_COOKIE_SAMESITE=None
DASHBOARD_COOKIE_SECURE=true
```

## Troubleshooting

Quick checks:

```bash
curl http://localhost:8080/healthz
cd api && npm run typecheck && npm test
cd trigger && npm run typecheck
cd dashboard && npm run build
```

Webhook accepted but no review starts:

- Confirm the PR event is `opened`, `synchronize`, `reopened`, or `ready_for_review`.
- Draft PRs are ignored until `ready_for_review`.
- Keep `reviewTaskTriggerControl.enabled` disabled during staged rollout and add only explicit test repositories to `reviewTaskTriggerControl.allowedRepositories`.
- Normal PR reviews always use task ID `review`.

Trigger run queues but does not execute:

- Production API must use a production `TRIGGER_SECRET_KEY`, not `tr_dev_*`.
- Trigger workers must be deployed to the same environment receiving the run.
- For local testing, run `cd trigger && npm run dev`.

Internal callback failures:

- `INTERNAL_API_TOKEN` must match between API and Trigger.
- `API_BASE_URL` in Trigger must point to the public API origin.

Daytona failures:

- `DAYTONA_API_KEY` must be present in Trigger.
- Custom images or snapshots must include `/usr/bin/bash`.
- Default resources are capped at 4 vCPU, 8 GiB memory, and 10 GiB disk.
- The worker must reach npm and OpenRouter from Daytona.

Model failures:

- Configure `OPENROUTER_API_KEY`.
- Check `REVIEW_CODEX_MODEL`, `REVIEW_CODEX_EFFORT`, `RUNTIME_PLANNER_MODEL`, `RUNTIME_AGENT_MODEL`, and `RUNTIME_MENTAL_TRACE_MODEL` — all values are OpenRouter slugs (e.g. `openai/gpt-5.4-mini`).

Dashboard cookie or sign-in issues:

- GitHub OAuth callback should be `https://api.usejina.com/auth/github/callback`.
- `API_BASE_URL` should be the public HTTPS API origin.
- `DASHBOARD_URL` should be the canonical dashboard origin.
- Cross-site deployments need `DASHBOARD_COOKIE_SAMESITE=None` and `DASHBOARD_COOKIE_SECURE=true`.

Codex connection issues:

- The browser reports privacy-safe lifecycle events to the API under the `codex_connect_flow` log prefix.
  A `flow_id` correlates start, resume, OpenAI approval, token exchange, and credential save without
  logging the one-time code, OpenAI device id, response body, credentials, or tokens.
- Query recent production flows with:

  ```bash
  SERVICE_NAME="${CLOUD_RUN_SERVICE:?Set CLOUD_RUN_SERVICE to the deployed Cloud Run service name}"
  gcloud logging read \
    "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICE_NAME}\" AND textPayload:\"codex_connect_flow\"" \
    --project "$GCP_PROJECT_ID" --freshness=24h --limit=200 --order=desc
  ```

- `stage` identifies `ui`, `start`, `poll`, `exchange`, or `save`; failures include a bounded
  `reason` and elapsed time, and may include a poll attempt and upstream HTTP status when one was
  received. Browser visibility transitions explain background-tab throttling without recording
  browsing activity.
- A successful credential write from a tracked device flow emits `codex_harness_connection_saved`
  with that flow's `flow_id`. Manual credential saves and disconnects emit the same event without a
  device-flow ID, so the tracked browser lifecycle can be correlated with the authoritative
  server-side save when applicable.

## Post-Deploy Checks

1. `GET https://api.usejina.com/healthz` returns `status: ok`.
2. GitHub App webhook delivery gets a `200` response.
3. A test PR triggers task `review` when the code-level dispatch switch is enabled.
4. Trigger shows `review-summary` and `review-runtime` child runs.
5. Daytona sandboxes use the expected 4 CPU, 8 GiB memory, 10 GiB disk profile.
6. The PR progress comment and runtime review feedback appear when permissions allow.
7. The dashboard shows the review run and findings.
