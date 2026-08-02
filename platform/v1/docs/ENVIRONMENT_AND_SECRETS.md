# Environment Variables and Secrets

This repo has six configuration surfaces:

- Local development: root `.env` plus `dashboard/.env.local`.
- GitHub Actions: repository or environment variables and secrets used by deploy workflows.
- GCP: Secret Manager, Cloud Run environment variables, Cloud SQL, Artifact Registry, and Workload Identity Federation.
- Trigger.dev: deployed worker environment synced during `trigger deploy`.
- Daytona: short-lived review sandboxes created by Trigger.dev workers.
- Vercel: dashboard build/runtime environment for the Next.js app.

Keep the source of truth explicit. Do not copy production secrets into examples, docs, PR comments, logs, screenshots, or issue descriptions.

## Source Of Truth

| Value type | Production source of truth | Consumed by | Notes |
| --- | --- | --- | --- |
| GCP deploy identity | GitHub Actions secrets `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT` | `.github/workflows/deploy-api.yml` | Used with GitHub OIDC. No GCP service account key file should be stored in this repo or `.env`. |
| Cloud Run non-secret config | GitHub Actions repository/environment variables | API Cloud Run service | The deploy workflow passes these through `--set-env-vars`. `Production` and `Staging` can use different GitHub Environment values. |
| Cloud Run secrets | GCP Secret Manager | API Cloud Run service | The deploy workflow maps Secret Manager secrets to env vars with `--set-secrets`. Staging must use distinct secret names. |
| Database connection string | GCP Secret Manager secret, production default `jina-database-url` | API Cloud Run service and migrations | Contains credentials. Treat as highly sensitive. Staging must use a distinct secret such as `jina-staging-database-url`. |
| Trigger worker deploy auth | GitHub Actions secret `TRIGGER_ACCESS_TOKEN` for production or `JINA_TRIGGER_ACCESS_TOKEN` for staging | `.github/workflows/deploy-trigger.yml` | Used only to deploy to Trigger.dev. It is not the same as `TRIGGER_SECRET_KEY`. |
| Trigger worker runtime secrets/config | GitHub Actions vars/secrets, then Trigger.dev environment via `trigger deploy` | Trigger.dev workers | `trigger/trigger.config.ts` controls which env vars are synced into Trigger.dev. |
| Daytona sandbox runtime | Trigger.dev worker code builds per-run env | Daytona sandboxes | Sandboxes receive GitHub/model tokens and review config. `DAYTONA_API_KEY` itself stays in Trigger.dev. |
| Dashboard browser config | Vercel env var `NEXT_PUBLIC_API_BASE_URL` | Next.js dashboard | `NEXT_PUBLIC_*` values are public in browser bundles. Never put secrets behind this prefix. |
| Local development | `.env` and `dashboard/.env.local` | Local API, Trigger dev, dashboard, migrations | Local files must remain uncommitted and may use development credentials. |

## Variable Inventory

This is the production save location for each known env var or secret. Local development can mirror these names in `.env` or `dashboard/.env.local`, but local files are not the production source of truth.

### API / Cloud Run

| Name | Secret? | Saved in production | Consumed by |
| --- | --- | --- | --- |
| `GOOGLE_CLOUD_PROJECT` | No | GitHub Actions variable `GCP_PROJECT_ID`; deployed as a Cloud Run env var | API runtime |
| `PORT` | No | Cloud Run platform default or service config | API runtime |
| `GITHUB_WEBHOOK_SECRET` | Yes | GCP Secret Manager `jina-github-webhook-secret`; deployed to Cloud Run with `--set-secrets` | API webhook verification |
| `INTERNAL_API_TOKEN` | Yes | GCP Secret Manager `jina-internal-api-token`; deployed to Cloud Run with `--set-secrets` | API internal route auth; must match Trigger worker value |
| `TRIGGER_SECRET_KEY` | Yes | GCP Secret Manager `jina-trigger-secret-key`; deployed to Cloud Run with `--set-secrets` | API calls to Trigger.dev |
| `DATABASE_URL` | Yes | GCP Secret Manager `jina-database-url`; deployed to Cloud Run with `--set-secrets` | API Postgres persistence and migrations |
| `GITHUB_OAUTH_CLIENT_SECRET` | Yes | GCP Secret Manager `jina-github-oauth-client-secret`; deployed to Cloud Run with `--set-secrets` | API dashboard OAuth |
| `GITHUB_APP_ID` | No | GitHub Actions variable `JINA_GITHUB_APP_ID`; deployed as a Cloud Run env var | API GitHub App display/install flows |
| `GITHUB_APP_INSTALL_URL` | No | GitHub Actions variable `JINA_GITHUB_APP_INSTALL_URL`; deployed as a Cloud Run env var | API/dashboard install links |
| `GITHUB_APP_SLUG` | No | Local `.env` only unless explicitly added to deploy config | Optional alternative for building install URL |
| `GITHUB_OAUTH_CLIENT_ID` | No | GitHub Actions variable `JINA_GITHUB_OAUTH_CLIENT_ID`; deployed as a Cloud Run env var | API dashboard OAuth |
| `GITHUB_OAUTH_SCOPES` | No | GitHub Actions variable `JINA_GITHUB_OAUTH_SCOPES`; deployed as a Cloud Run env var | API dashboard OAuth |
| `DASHBOARD_AUTH_MODE` | No | Literal value in `.github/workflows/deploy-api.yml` (`github`) | API auth mode |
| `DASHBOARD_ORIGIN` | No | GitHub Actions variable `JINA_DASHBOARD_ORIGIN`; deployed as a Cloud Run env var | API CORS/cookie origin checks |
| `DASHBOARD_URL` | No | GitHub Actions variable `JINA_DASHBOARD_URL`; deployed as a Cloud Run env var | API redirects and links |
| `DASHBOARD_SESSION_COOKIE` | No | Optional Cloud Run env var; local `.env.example` has default | API dashboard session cookie name |
| `DASHBOARD_OAUTH_STATE_COOKIE` | No | Optional Cloud Run env var; code has default | API OAuth state cookie name |
| `DASHBOARD_SESSION_TTL_SECONDS` | No | Optional Cloud Run env var; local `.env.example` has default | API session lifetime |
| `DASHBOARD_COOKIE_SAMESITE` | No | Literal value in `.github/workflows/deploy-api.yml` (`None`) | API cookies |
| `DASHBOARD_COOKIE_SECURE` | No | Literal value in `.github/workflows/deploy-api.yml` (`true`) | API cookies |
| `TRIGGER_API_URL` | No | GitHub Actions variable `JINA_TRIGGER_API_URL`; deployed as a Cloud Run env var | API Trigger.dev client |
| `TRIGGER_PREVIEW_BRANCH` | No | Optional Cloud Run env var | API Trigger.dev preview branch routing |
| `TRIGGER_ALLOW_DEV_SECRET_IN_PRODUCTION` | No | Avoid in production except emergency override | API startup validation |
| `API_BASE_URL` | No | GitHub Actions variable `JINA_API_BASE_URL` or `API_BASE_URL`; deployed as a Cloud Run env var | API callback/link construction; required for production OAuth |
| `SECRETS_ENCRYPTION_KEY` | Yes | GCP Secret Manager `jina-secrets-encryption-key` (staging: staging-scoped); mapped to Cloud Run with `--set-secrets` | API encryption for stored provider keys and sessions. REQUIRED: the API refuses to boot without it. The deploy validates it is base64-encoded 32 bytes. |
| `AUTUMN_SECRET_KEY` | Yes | GCP Secret Manager `jina-autumn-secret-key` (staging: staging-scoped); mounted only when `JINA_BILLING_ENFORCE` is set | API Autumn billing calls |
| `JINA_BILLING_ENFORCE` | No | GitHub Actions variable; `off`/`shadow`/`on`; deployed as a Cloud Run env var when set | API billing enforcement mode; enabling it also mounts `AUTUMN_SECRET_KEY` |
| `JINA_GRAPH_API_URL` | No | GitHub Actions variable; deployed only when configured | V2 Context API origin |
| `JINA_GRAPH_API_TOKEN` | Yes | Operator-managed GCP Secret Manager `jina-graph-api-token`; mounted only when `JINA_GRAPH_API_URL` is configured | Static dashboard fallback; never exposed to GitHub Actions, the browser, or review agents |
| `JINA_GRAPH_REQUEST_TIMEOUT_MS` | No | Optional GitHub Actions variable; deployed with Context integration; defaults to 20,000 ms | Maximum duration for V2 API requests and signed webhook relay |
| `JINA_GRAPH_INTERNAL_TOKEN` | Yes | API runtime secret containing V2's `INTERNAL_API_TOKEN`; mounted by the deploy workflow when Context and `GRAPH_INTERNAL_TOKEN_SECRET_NAME` are configured | Mints delegated dashboard tokens and exact-repository review MCP tokens; required for review MCP |
| `JINA_GRAPH_DELEGATED_TOKEN_TTL_MINUTES` | No | Optional API runtime variable; defaults to 15 minutes and floors values below 5; passed by the deploy workflow when `GRAPH_INTERNAL_TOKEN_SECRET_NAME` is set | Lifetime requested for the per-tenant delegated dashboard token; renewal starts one minute before expiry, while V2 controls review MCP token lifetime |
| `CLOUD_SQL_INSTANCE` | No | GitHub Actions environment variable; production defaults to `jina-db` in the deploy workflow; staging must set a non-production value | Cloud SQL attachment for API deploy |
| `WEBHOOK_SECRET_NAME` | No | GitHub Actions environment variable; production defaults to `jina-github-webhook-secret`; staging must set a non-production value | Secret Manager name used by API deploy |
| `INTERNAL_API_TOKEN_SECRET_NAME` | No | GitHub Actions environment variable; production defaults to `jina-internal-api-token`; staging must set a non-production value | Secret Manager name used by API deploy |
| `TRIGGER_SECRET_KEY_SECRET_NAME` | No | GitHub Actions environment variable; production defaults to `jina-trigger-secret-key`; staging must set a non-production value | Secret Manager name used by API deploy |
| `OAUTH_CLIENT_SECRET_NAME` | No | GitHub Actions environment variable; production defaults to `jina-github-oauth-client-secret`; staging must set a non-production value | Secret Manager name used by API deploy |
| `DATABASE_URL_SECRET_NAME` | No | GitHub Actions environment variable; production defaults to `jina-database-url`; staging must set a non-production value | Secret Manager name used by API deploy |
| `ENCRYPTION_KEY_SECRET_NAME` | No | GitHub Actions environment variable; production defaults to `jina-secrets-encryption-key`; staging must set a non-production value | Secret Manager name used by API deploy for `SECRETS_ENCRYPTION_KEY` |
| `AUTUMN_SECRET_KEY_SECRET_NAME` | No | GitHub Actions environment variable; production defaults to `jina-autumn-secret-key`; staging must set a non-production value when billing is enabled | Secret Manager name used by API deploy for `AUTUMN_SECRET_KEY` |
| `GRAPH_API_TOKEN_SECRET_NAME` | No | GitHub Actions environment variable; production defaults to `jina-graph-api-token` when Context integration is enabled; staging must use a distinct staging-scoped value | Secret Manager name used by API deploy for the static `JINA_GRAPH_API_TOKEN` dashboard fallback |
| `GRAPH_INTERNAL_TOKEN_SECRET_NAME` | No | GitHub Actions environment variable; set when delegated dashboard tokens or review MCP are enabled; staging must use a staging-scoped value | Secret Manager name used by API deploy for `JINA_GRAPH_INTERNAL_TOKEN` |
| `ALLOW_DEV_TRIGGER_SECRET_IN_DEPLOY` | No | GitHub Actions environment variable; default `false` | Emergency override for deploying an API wired to a `tr_dev_*` Trigger secret |

`JINA_GRAPH_API_URL` and `JINA_GRAPH_API_TOKEN` remain a required pair for the
Context dashboard fallback. Set `JINA_GRAPH_INTERNAL_TOKEN` to V2's
`INTERNAL_API_TOKEN` to enable delegated dashboard tokens and direct review MCP
access; without it review access fails closed. The webhook relay itself carries
no service bearer: V2 re-verifies GitHub's original signature.

### Trigger.dev Workers

| Name | Secret? | Saved in production | Consumed by |
| --- | --- | --- | --- |
| `TRIGGER_ACCESS_TOKEN` | Yes | GitHub Actions secret `TRIGGER_ACCESS_TOKEN` for production, or `JINA_TRIGGER_ACCESS_TOKEN` for staging | GitHub Actions deploy only |
| `TRIGGER_API_URL` | No | GitHub Actions variable `JINA_TRIGGER_API_URL` or `TRIGGER_API_URL`; synced into Trigger.dev | Trigger deploy and worker runtime |
| `TRIGGER_PROJECT_REF` | No | GitHub Actions variable `JINA_TRIGGER_PROJECT_REF` or `TRIGGER_PROJECT_REF`; used during deploy | Trigger project selection |
| `API_BASE_URL` | No | GitHub Actions variable `JINA_API_BASE_URL` or `API_BASE_URL`; synced into Trigger.dev | Worker calls to API |
| `DASHBOARD_ORIGIN` | No | GitHub Actions variable `JINA_DASHBOARD_ORIGIN` or `DASHBOARD_ORIGIN`; synced into Trigger.dev | Worker links/metadata |
| `DASHBOARD_URL` | No | GitHub Actions variable `JINA_DASHBOARD_URL` or `DASHBOARD_URL`; synced into Trigger.dev | Worker links/metadata |
| `GITHUB_APP_ID` | No | GitHub Actions variable `JINA_GITHUB_APP_ID`; synced into Trigger.dev | Worker GitHub App auth |
| `GITHUB_APP_PRIVATE_KEY` | Yes | GitHub Actions secret `JINA_GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY`; synced into Trigger.dev | Worker GitHub App auth |
| `GITHUB_CLONE_TOKEN` | Yes | Optional GitHub Actions secret `JINA_GITHUB_CLONE_TOKEN` or `GITHUB_CLONE_TOKEN`; synced into Trigger.dev | Optional clone fallback |
| `INTERNAL_API_TOKEN` | Yes | GitHub Actions secret `JINA_INTERNAL_API_TOKEN` or `INTERNAL_API_TOKEN`; synced into Trigger.dev | Worker calls to API internal routes |
| `JINA_GRAPH_MCP_ENABLED` | No | GitHub Actions variable of the same name; defaults to `true` and is synced into Trigger.dev | Emergency kill switch for V2 Context MCP attachment; does not control local CodeGraph |
| `DAYTONA_API_KEY` | Yes | GitHub Actions secret `JINA_DAYTONA_API_KEY` or `DAYTONA_API_KEY`; synced into Trigger.dev | Worker creates Daytona sandboxes |
| `OPENROUTER_API_KEY` | Yes | GitHub Actions secret `JINA_OPENROUTER_API_KEY` or `OPENROUTER_API_KEY`; synced into Trigger.dev | The only model gateway credential for managed reviews and Daytona worker env. Required. |
| `OPENROUTER_APP_URL` | No | GitHub Actions variable `JINA_OPENROUTER_APP_URL` or `OPENROUTER_APP_URL`; synced into Trigger.dev | Optional OpenRouter attribution |
| `OPENROUTER_APP_TITLE` | No | GitHub Actions variable `JINA_OPENROUTER_APP_TITLE` or `OPENROUTER_APP_TITLE`; synced into Trigger.dev | Optional OpenRouter attribution |
| `CODEGRAPH_TIMEOUT_MS` | No | GitHub Actions variable `JINA_CODEGRAPH_TIMEOUT_MS` or `CODEGRAPH_TIMEOUT_MS`; synced into Trigger.dev | Worker and Daytona timeout config |
| `CODEX_REVIEW_TIMEOUT_MS` | No | GitHub Actions variable `JINA_CODEX_REVIEW_TIMEOUT_MS` or `CODEX_REVIEW_TIMEOUT_MS`; synced into Trigger.dev | Worker and Daytona timeout config |
| `REVIEW_CODEX_MODEL` | No | GitHub Actions variable `JINA_REVIEW_CODEX_MODEL` or `REVIEW_CODEX_MODEL`; synced into Trigger.dev | Review model selection (OpenRouter slug) |
| `REVIEW_CODEX_EFFORT` | No | GitHub Actions variable `JINA_REVIEW_CODEX_EFFORT` or `REVIEW_CODEX_EFFORT`; synced into Trigger.dev | Review reasoning effort |
| `RUNTIME_PLANNER_MODEL` | No | GitHub Actions variable `JINA_RUNTIME_PLANNER_MODEL` or `RUNTIME_PLANNER_MODEL`; synced into Trigger.dev | Runtime review planner model (OpenRouter slug) |
| `RUNTIME_AGENT_MODEL` | No | GitHub Actions variable `JINA_RUNTIME_AGENT_MODEL` or `RUNTIME_AGENT_MODEL`; synced into Trigger.dev | Runtime review agent model (OpenRouter slug) |
| `RUNTIME_MENTAL_TRACE_MODEL` | No | GitHub Actions variable `JINA_RUNTIME_MENTAL_TRACE_MODEL` or `RUNTIME_MENTAL_TRACE_MODEL`; synced into Trigger.dev | Runtime review mental-trace model (OpenRouter slug) |
| `DAYTONA_RUN_TIMEOUT_SECONDS` | No | GitHub Actions variable `JINA_DAYTONA_RUN_TIMEOUT_SECONDS` or `DAYTONA_RUN_TIMEOUT_SECONDS`; synced into Trigger.dev | Daytona run timeout |
| `DAYTONA_SETUP_TIMEOUT_SECONDS` | No | GitHub Actions variable `JINA_DAYTONA_SETUP_TIMEOUT_SECONDS` or `DAYTONA_SETUP_TIMEOUT_SECONDS`; synced into Trigger.dev | Daytona setup timeout |
| `DAYTONA_RESULT_DOWNLOAD_TIMEOUT_SECONDS` | No | GitHub Actions variable `JINA_DAYTONA_RESULT_DOWNLOAD_TIMEOUT_SECONDS` or `DAYTONA_RESULT_DOWNLOAD_TIMEOUT_SECONDS`; synced into Trigger.dev | Daytona result download timeout |
| `DAYTONA_SNAPSHOT` | No | GitHub Actions variable `JINA_DAYTONA_SNAPSHOT` or `DAYTONA_SNAPSHOT` if configured; synced into Trigger.dev | Daytona sandbox creation |
| `DAYTONA_SANDBOX_IMAGE` | No | GitHub Actions variable `JINA_DAYTONA_SANDBOX_IMAGE` or `DAYTONA_SANDBOX_IMAGE` if configured; synced into Trigger.dev | Daytona sandbox creation |
| `DAYTONA_SANDBOX_CPU` | No | GitHub Actions variable `JINA_DAYTONA_SANDBOX_CPU` or `DAYTONA_SANDBOX_CPU` if configured; synced into Trigger.dev | Daytona sandbox resources |
| `DAYTONA_SANDBOX_MEMORY` | No | GitHub Actions variable `JINA_DAYTONA_SANDBOX_MEMORY` or `DAYTONA_SANDBOX_MEMORY` if configured; synced into Trigger.dev | Daytona sandbox resources |
| `DAYTONA_SANDBOX_DISK` | No | GitHub Actions variable `JINA_DAYTONA_SANDBOX_DISK` or `DAYTONA_SANDBOX_DISK` if configured; synced into Trigger.dev | Daytona sandbox resources |
| `DAYTONA_SKIP_INSTALL` | No | GitHub Actions variable `JINA_DAYTONA_SKIP_INSTALL` or `DAYTONA_SKIP_INSTALL` if configured; synced into Trigger.dev | Daytona setup behavior |

The legacy direct-provider keys (`OPENAI_API_KEY`, `CODEX_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`), their `*_ARGS`/`*_BIN` companions, `JUDGE_PROVIDER`, `MODEL_TIMEOUT_MS`, and all `SCENARIO_*` simulation vars were removed once workers moved to OpenRouter and the scenario-simulation flow was retired. `trigger/trigger.config.ts` `syncedEnvVars` is the authoritative list of synced worker variables.

### Daytona Worker Process

These values are not saved directly in Daytona as the source of truth. The Trigger worker builds them per review and passes them into the sandboxed `npx tsx runner.ts` process.

| Name | Secret? | Saved in production | Consumed by |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | Yes | Minted at runtime from the GitHub App installation token | Daytona worker process |
| `GITHUB_CLONE_TOKEN` | Yes | Trigger worker env fallback or runtime installation token | Daytona worker git clone/read operations |
| `OPENROUTER_API_KEY` | Yes | Stored dashboard integration key, or Trigger worker env fallback | Daytona worker model calls (the only gateway credential) |
| `OPENROUTER_APP_URL`, `OPENROUTER_APP_TITLE` | No | Copied from Trigger worker env when set | Daytona worker OpenRouter attribution |
| `CODEX_BIN`, `CODEGRAPH_BIN` | No | Built by Trigger worker code from defaults/config | Daytona worker CLI execution |
| `JINA_GRAPH_ACCESS_TOKEN` | Yes | Minted by V2 per review after an exact repository release is found | Daytona Codex access directly to V2 `/mcp`; unrelated to local CodeGraph |
| Model and timeout vars | No | Copied from Trigger worker env or code defaults | Daytona worker review stages |

V2 Context workers additionally receive `JINA_V1_API_URL` and the secret
`JINA_V1_INTERNAL_API_TOKEN`. They use these only to resolve a write-once,
tenant/build-scoped execution profile. The profile credential is injected into an
ephemeral private Daytona sandbox and is included in the worker's redaction set; it
is never stored in Board metadata or Context artifacts.

### Dashboard / Vercel

| Name | Secret? | Saved in production | Consumed by |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_API_BASE_URL` | No | Vercel project env var | Browser dashboard bundle |

No backend secrets should be saved in Vercel for the dashboard. Anything prefixed with `NEXT_PUBLIC_` is public.

## GCP

Production API deploys to Cloud Run and currently uses Cloud SQL for Postgres.

The API deploy workflow authenticates to GCP with Workload Identity Federation:

- `permissions.id-token: write` in `.github/workflows/deploy-api.yml`
- GitHub Actions secret `GCP_WORKLOAD_IDENTITY_PROVIDER`
- GitHub Actions secret `GCP_SERVICE_ACCOUNT`
- `google-github-actions/auth@v2`

Do not create or commit long-lived GCP JSON key files unless there is a specific break-glass operational reason and an explicit rotation plan.

### Secret Manager

Cloud Run runtime secrets expected by the deploy workflow:

- `jina-github-webhook-secret` -> `GITHUB_WEBHOOK_SECRET`
- `jina-internal-api-token` -> `INTERNAL_API_TOKEN`
- `jina-trigger-secret-key` -> `TRIGGER_SECRET_KEY`
- `jina-github-oauth-client-secret` -> `GITHUB_OAUTH_CLIENT_SECRET`
- `jina-database-url` -> `DATABASE_URL`
- `jina-secrets-encryption-key` -> `SECRETS_ENCRYPTION_KEY` (REQUIRED; base64-encoded 32 bytes)
- `jina-autumn-secret-key` -> `AUTUMN_SECRET_KEY` (mounted only when `JINA_BILLING_ENFORCE` is set)
- `jina-graph-api-token` -> `JINA_GRAPH_API_TOKEN` (mounted only when `JINA_GRAPH_API_URL` is set)

The V2 Context internal credential is optional for the static dashboard fallback.
To enable delegated dashboard tokens or direct review MCP access, store V2's
`INTERNAL_API_TOKEN` in Secret Manager and set the
`GRAPH_INTERNAL_TOKEN_SECRET_NAME` repository variable to its name. The deploy
workflow mounts it as `JINA_GRAPH_INTERNAL_TOKEN`; use a staging-scoped value for
staging.

Each secret name is overridable per environment through the `*_SECRET_NAME`
GitHub Environment variables (see the API / Cloud Run table). Production falls
back to the names above; staging must supply distinct staging-scoped names.

Create a missing secret once:

```bash
gcloud secrets create jina-database-url \
  --project "$GCP_PROJECT_ID" \
  --replication-policy=automatic
```

Add or rotate a value through stdin so it does not appear in shell history:

```bash
read -rs DATABASE_URL
printf '%s' "$DATABASE_URL" | gcloud secrets versions add jina-database-url \
  --project "$GCP_PROJECT_ID" \
  --data-file=-
unset DATABASE_URL
```

Cloud Run reads secret environment variables when instances start. After rotating a Secret Manager value, redeploy the service or otherwise force new instances/revisions before assuming all traffic uses the new value.

### Database URL

`DATABASE_URL` is a normal Postgres connection string. It is not a GCP token.

For Cloud Run attached to Cloud SQL, use the Cloud SQL Unix socket host:

```text
postgresql://DB_USER:URL_ENCODED_PASSWORD@localhost/DB_NAME?host=/cloudsql/PROJECT_ID:REGION:jina-db
```

For local development through Cloud SQL Auth Proxy:

```text
postgresql://DB_USER:DB_PASSWORD@127.0.0.1:5432/DB_NAME
```

Be careful with database URLs:

- URL-encode special characters in the password.
- Do not paste full connection strings into chat, logs, or docs.
- Use separate users/passwords for production, staging, and local development.
- Apply migrations before real webhook traffic reaches a new database.
- Make sure the API and workers are referring to the same environment; workers call the API, and the API owns DB writes.

Run migrations with:

```bash
cd api
DATABASE_URL="postgresql://..." npm run migrate
```

The migration runner also loads `../.env` and `api/.env` when present.

## API

The API reads runtime env vars directly from `process.env`.

Required for normal API operation:

- `GITHUB_WEBHOOK_SECRET`
- `INTERNAL_API_TOKEN`
- `TRIGGER_SECRET_KEY`

Required when dashboard auth is enabled:

- `DASHBOARD_AUTH_MODE=github`
- `GITHUB_OAUTH_CLIENT_ID`
- `GITHUB_OAUTH_CLIENT_SECRET`
- `GITHUB_OAUTH_SCOPES`

Required for full persistence flows:

- `DATABASE_URL`

Important API config:

- `PORT`: local or container port. Defaults to `8080`.
- `DASHBOARD_ORIGIN`: allowed browser origins for CORS. Comma-separated. Do not use `*` with credentialed production dashboard traffic.
- `DASHBOARD_URL`: canonical dashboard URL used for redirects and links.
- `API_BASE_URL`: public API base URL used when the API constructs callbacks or links. Production must use the HTTPS API origin.
- `DASHBOARD_COOKIE_SAMESITE`: use `None` for cross-site production dashboard/API deployments.
- `DASHBOARD_COOKIE_SECURE`: use `true` for HTTPS production.
- `SECRETS_ENCRYPTION_KEY`: base64-encoded 32-byte key used to encrypt provider keys and session tokens at rest. REQUIRED in every deployed environment — the API refuses to boot without it, and the deploy workflow validates its presence and shape. Leaving it empty is acceptable only for local development.

The API stores GitHub session access tokens and provider keys. Every deployed environment (production and staging) must configure `SECRETS_ENCRYPTION_KEY` before it can boot. Do not rotate it casually: previously stored provider keys and OAuth bindings become undecryptable.

## Trigger.dev

There are two different Trigger secrets:

- `TRIGGER_ACCESS_TOKEN`: production deploy credential used by GitHub Actions to run `trigger deploy`. Staging uses `JINA_TRIGGER_ACCESS_TOKEN`.
- `TRIGGER_SECRET_KEY`: API runtime secret used by the API to call Trigger.dev.

The Trigger deploy workflow reads GitHub Actions variables/secrets, validates them, runs `npm run typecheck`, then runs `npm run deploy` from `trigger/`.

Required Trigger deployment inputs:

- `TRIGGER_ACCESS_TOKEN` for production, or `JINA_TRIGGER_ACCESS_TOKEN` for staging
- `TRIGGER_PROJECT_REF`
- `API_BASE_URL`
- `DAYTONA_API_KEY`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `INTERNAL_API_TOKEN`
- `OPENROUTER_API_KEY` (GitHub secret `JINA_OPENROUTER_API_KEY`; the only model gateway credential)

`trigger/trigger.config.ts` defines `syncedEnvVars`. Only variables listed there are copied into the deployed Trigger.dev worker environment. When adding worker runtime config, add it to `syncedEnvVars` and verify the deploy workflow supplies it.

Careful points:

- `INTERNAL_API_TOKEN` must match between the API and Trigger workers. Workers use it when calling API internal routes.
- `GITHUB_CLONE_TOKEN` is optional. It should only be a fallback when GitHub App installation tokens cannot clone the repository.
- A `tr_dev_*` `TRIGGER_SECRET_KEY` targets Trigger.dev development behavior. Production API should use a production Trigger secret key.
- Provider API keys are available to worker code and Daytona sandboxes. Do not log env dumps.
- Review model/concurrency knobs can increase cost and provider rate-limit pressure.

## Daytona

Daytona is used by Trigger workers to run the review stages in short-lived sandboxes. The Trigger worker needs `DAYTONA_API_KEY` to create and manage sandboxes, but that key is not intentionally passed into the sandbox worker env.

Sandbox creation and execution are controlled by `trigger/src/daytona/review-session.ts`.

Trigger worker inputs used for Daytona:

- `DAYTONA_API_KEY`: required in Trigger.dev worker env to create sandboxes.
- `DAYTONA_SNAPSHOT`: optional pre-baked Daytona snapshot. If set, it must include `/usr/bin/bash`.
- `DAYTONA_SANDBOX_IMAGE`: optional custom image. Defaults to `node:22-bookworm` when unset so Daytona command execution has `/usr/bin/bash`.
- `DAYTONA_SANDBOX_CPU`, `DAYTONA_SANDBOX_MEMORY`, `DAYTONA_SANDBOX_DISK`: optional resource sizing when using an image. Defaults to the maximum supported Daytona profile for this account: 4 CPU, 8 GiB memory, and 10 GiB disk. Higher configured values are capped before sandbox creation.
- `DAYTONA_SKIP_INSTALL`: optional flag to skip dependency install when the image/snapshot already contains worker dependencies.
- `DAYTONA_SETUP_TIMEOUT_SECONDS`: setup/install timeout.
- `DAYTONA_RUN_TIMEOUT_SECONDS`: per-phase runtime timeout.

The Trigger worker builds a per-review `workerEnv` object and passes it as the environment argument to `sandbox.process.executeCommand("npx tsx runner.ts", workDir, workerEnv, ...)`. That means the sandboxed worker process receives:

- `GITHUB_TOKEN`: GitHub App installation token for the reviewed repo.
- `GITHUB_CLONE_TOKEN`: clone fallback token, or the installation token when no fallback is configured.
- `OPENROUTER_API_KEY`: the model gateway credential. A stored dashboard integration key wins when present; otherwise the worker env key is used.
- `OPENROUTER_APP_URL`, `OPENROUTER_APP_TITLE`: optional OpenRouter attribution.
- `CODEX_BIN`, `CODEGRAPH_BIN`: tool CLI config.
- Review/runtime model, effort, and timeout config.

The sandbox filesystem also receives JSON input for the current phase and copied worker sources. The worker process clones or reads the target repository using the GitHub token values above, emits a structured result, and the sandbox is deleted after the review session finishes.

Careful points:

- Daytona is an external execution environment. Treat every env var passed into the sandbox as exposed to that sandbox process.
- Do not pass `DATABASE_URL`, GCP credentials, `TRIGGER_ACCESS_TOKEN`, `TRIGGER_SECRET_KEY`, or `INTERNAL_API_TOKEN` into Daytona unless a future design explicitly requires it.
- Do not log full sandbox stdout/stderr, process env, command lines with secrets, or raw provider errors. The code redacts known secret values before surfacing some failures, but operators should not rely on redaction as the primary control.
- Custom images and snapshots must not bake in secrets. Use them for tools/dependencies and resource sizing, not credentials.
- `GITHUB_CLONE_TOKEN` should remain a temporary fallback. Prefer installation tokens with the minimum GitHub App permissions required.
- Larger sandbox resources and higher model concurrency can increase cost and provider rate-limit pressure.
- Sandbox deletion is best-effort. Avoid writing durable secrets into files inside the sandbox.

## GitHub Actions

Use GitHub Actions variables for non-secret deploy config and GitHub Actions secrets for credentials.

API deploy variables:

- `GCP_PROJECT_ID`
- `GCP_REGION`
- `CLOUD_RUN_SERVICE`
- `ARTIFACT_REGISTRY_REPOSITORY`
- `CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT`
- `JINA_DASHBOARD_ORIGIN` (optional extra origins)
- `JINA_DASHBOARD_URL`
- `JINA_API_BASE_URL`
- `JINA_GITHUB_APP_ID`
- `JINA_GITHUB_APP_SLUG` or `JINA_GITHUB_APP_INSTALL_URL`
- `JINA_GITHUB_OAUTH_CLIENT_ID`
- `JINA_GITHUB_OAUTH_SCOPES`
- `JINA_TRIGGER_API_URL`
- `JINA_BILLING_ENFORCE` (optional; `off`/`shadow`/`on`)

The PR review and backfill tasks are code constants (`review`,
`github-installation-backfill`) and are no longer configured through env vars.

Per-environment Secret Manager name overrides (`CLOUD_SQL_INSTANCE`,
`WEBHOOK_SECRET_NAME`, `INTERNAL_API_TOKEN_SECRET_NAME`,
`TRIGGER_SECRET_KEY_SECRET_NAME`, `OAUTH_CLIENT_SECRET_NAME`,
`DATABASE_URL_SECRET_NAME`, `ENCRYPTION_KEY_SECRET_NAME`,
`AUTUMN_SECRET_KEY_SECRET_NAME`, `ALLOW_DEV_TRIGGER_SECRET_IN_DEPLOY`) are read
from GitHub Environment variables. Production falls back to the default names;
staging must supply staging-scoped names. See [Staging Environment](./STAGING.md).

API deploy secrets:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_SERVICE_ACCOUNT`

Trigger deploy variables and secrets are read in `.github/workflows/deploy-trigger.yml`. Prefer the `JINA_*` names used by that workflow when setting repo-level values. Staging Trigger deploys read `JINA_*` values only; generic fallbacks are ignored.

Careful points:

- GitHub masks exact secret values, not every transformed value. Avoid printing derived tokens, full URLs with passwords, private keys, or env dumps.
- GitHub Actions variables are not secret. Do not put credentials there.
- Environment-specific Actions environments are safer than one shared repo-level namespace when staging and production both exist.
- Keep `INTERNAL_API_TOKEN` synchronized wherever the API and Trigger worker pair for the same environment are configured.
- Do not store GCP service account JSON in GitHub secrets for this workflow; use WIF/OIDC instead.

## Vercel Dashboard

The dashboard is a standalone Next.js app. It should not receive backend secrets.

Production dashboard env:

```text
NEXT_PUBLIC_API_BASE_URL=https://api.usejina.com
```

The `NEXT_PUBLIC_` prefix means the value is embedded in browser-visible JavaScript. Only put public, non-secret values in Vercel dashboard env vars with this prefix.

The API must separately allow the Vercel dashboard origin:

```text
DASHBOARD_ORIGIN=https://app.usejina.com
DASHBOARD_URL=https://app.usejina.com
DASHBOARD_COOKIE_SAMESITE=None
DASHBOARD_COOKIE_SECURE=true
```

Set the GitHub OAuth callback URL to the API origin, not the dashboard origin:

```text
https://api.usejina.com/auth/github/callback
```

## Local Development

Local setup uses two files:

- Root `.env`: API, Trigger dev, database, GitHub App, provider keys, Daytona, and local dashboard/API coordination.
- `dashboard/.env.local`: Next.js dashboard variables, normally copied from `dashboard/.env.example`.

Start from examples:

```bash
cp .env.example .env
cd dashboard
cp .env.example .env.local
```

Load root env vars before running local API or Trigger dev:

```bash
set -a
source .env
set +a
```

Typical local commands:

```bash
cd api
npm run dev
```

```bash
cd trigger
npm run dev
```

```bash
cd dashboard
npm run dev
```

Local safety rules:

- Keep `.env` and `dashboard/.env.local` out of git.
- Use development Trigger keys locally, production Trigger keys only in production.
- Use a local or staging database for development. Do not point local tests at production unless explicitly doing an operational repair.
- `SECRETS_ENCRYPTION_KEY` may be empty only for local development. If set locally and then changed, encrypted local rows may no longer decrypt.
- Local GitHub webhooks need a tunnel URL and a matching `GITHUB_WEBHOOK_SECRET`.
- Dashboard auth can be disabled locally with `DASHBOARD_AUTH_MODE=disabled`; production should use GitHub auth.

## Rotation Checklist

When rotating any shared secret:

1. Identify every consumer: API, Trigger workers, Daytona sandboxes, GitHub Actions, Vercel, local operators, and GCP Secret Manager.
2. Add the new value in the source of truth first.
3. Deploy or restart every consumer that reads the value at startup.
4. Verify one end-to-end path with fresh logs that do not print the secret.
5. Revoke or disable the old value.
6. Update runbooks and examples if the variable name or ownership changed.

For `INTERNAL_API_TOKEN`, rotate API and Trigger together because both sides must agree. For `DATABASE_URL`, apply migrations and verify the API and dashboard are using the intended database before sending production webhook traffic.
