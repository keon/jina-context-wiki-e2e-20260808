# Staging Environment

Staging is isolated from production by GCP project, GitHub Environment, Cloud
Run services, Cloud SQL instance, service accounts, Workload Identity pool,
Artifact Registry repositories, Secret Manager values, Trigger.dev project,
dashboard project/origin, GitHub App, OAuth credentials, and webhook secret.
The isolated GCP project shares the Om Labs billing account only; it does not
share runtime resources or identities with production.

## GitHub Environment

Create a GitHub Actions environment named `Staging`. Restrict it to the
`staging` branch when possible. The deploy workflows select environments as:

- `main` branch -> `Production`
- `staging` branch -> `Staging`
- manual workflow dispatch -> selected `target_environment`

Manual staging deploys must be dispatched from the `staging` branch/ref. The
workflows reject `target_environment=Staging` from any other branch so staging
cannot silently deploy code or configuration from `main`.

## Required Staging Variables

Save these as GitHub Environment variables on `Staging`:

| Name | Example |
| --- | --- |
| `GCP_PROJECT_ID` | `jina-staging-20260802` |
| `GCP_REGION` | `us-east1` |
| `CLOUD_RUN_SERVICE` | `jina-code-review-api-staging` |
| `CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT` | `jina-api-staging-runtime@jina-staging-20260802.iam.gserviceaccount.com` |
| `CLOUD_SQL_INSTANCE` | `jina-db-staging` |
| `ARTIFACT_REGISTRY_REPOSITORY` | `jina-code-review-staging` |
| `JINA_API_BASE_URL` | `https://jina-code-review-api-staging-679811160186.us-east1.run.app` |
| `JINA_DASHBOARD_ORIGIN` | `https://staging.usejina.com` |
| `JINA_DASHBOARD_URL` | `https://staging.usejina.com` |
| `JINA_GITHUB_APP_ID` | staging GitHub App id |
| `JINA_GITHUB_APP_SLUG` or `JINA_GITHUB_APP_INSTALL_URL` | staging GitHub App slug/install URL |
| `JINA_GITHUB_OAUTH_CLIENT_ID` | staging OAuth App client id |
| `JINA_GITHUB_OAUTH_SCOPES` | `read:user read:org repo` |
| `JINA_TRIGGER_API_URL` | `https://api.trigger.dev` |
| `JINA_TRIGGER_PROJECT_REF` | `proj_rqckjugodcaghbpgggbz` |
| `WEBHOOK_SECRET_NAME` | `jina-staging-github-webhook-secret` |
| `JINA_GITHUB_APP_PRIVATE_KEY_SECRET_NAME` | `jina-staging-github-app-private-key` |
| `INTERNAL_API_TOKEN_SECRET_NAME` | `jina-staging-internal-api-token` |
| `TRIGGER_SECRET_KEY_SECRET_NAME` | `jina-staging-trigger-secret-key` |
| `OAUTH_CLIENT_SECRET_NAME` | `jina-staging-github-oauth-client-secret` |
| `DATABASE_URL_SECRET_NAME` | `jina-staging-database-url` |
| `ENCRYPTION_KEY_SECRET_NAME` | `jina-staging-secrets-encryption-key` |

Optional staging variables:

| Name | Example / notes |
| --- | --- |
| `JINA_DASHBOARD_ORIGIN` | Extra comma-separated dashboard origins; if set, must contain `staging`. |
| `JINA_BILLING_ENFORCE` | `off`, `shadow`, or `on`. `off` never mounts an Autumn secret. |
| `AUTUMN_SECRET_KEY_SECRET_NAME` | `jina-staging-autumn-secret-key`. Required only for `shadow` or `on`. |
| `JINA_GRAPH_API_URL` | Optional staging V2 Context API HTTPS origin; if set, it must contain `staging` and be paired with `GRAPH_API_TOKEN_SECRET_NAME`. |
| `JINA_GRAPH_REQUEST_TIMEOUT_MS` | Optional timeout for staging V2 Context requests and webhook relay; defaults to 20,000 ms. |
| `GRAPH_API_TOKEN_SECRET_NAME` | Staging-scoped Secret Manager name for the static `JINA_GRAPH_API_TOKEN` fallback; required when `JINA_GRAPH_API_URL` is set. |
| `GRAPH_INTERNAL_TOKEN_SECRET_NAME` | Optional staging-scoped Secret Manager name containing V2's `INTERNAL_API_TOKEN`; enables delegated dashboard tokens and review MCP access when Context is configured. |
| `JINA_GRAPH_DELEGATED_TOKEN_TTL_MINUTES` | Optional API runtime setting for delegated dashboard tokens; defaults to 15 minutes and floors values below 5. The deploy workflow passes it when `GRAPH_INTERNAL_TOKEN_SECRET_NAME` is set. |
| `ALLOW_DEV_TRIGGER_SECRET_IN_DEPLOY` | `true` only to intentionally deploy staging against a `tr_dev_*` Trigger key. |
| `JINA_OPENROUTER_APP_URL`, `JINA_OPENROUTER_APP_TITLE` | Optional OpenRouter attribution for staging Trigger workers. |
| `JINA_REVIEW_CODEX_MODEL`, `JINA_REVIEW_CODEX_EFFORT`, `JINA_RUNTIME_PLANNER_MODEL`, `JINA_RUNTIME_AGENT_MODEL`, `JINA_RUNTIME_MENTAL_TRACE_MODEL` | Optional OpenRouter model slugs for staging Trigger workers. |

`SECRETS_ENCRYPTION_KEY` is required at API startup, so `ENCRYPTION_KEY_SECRET_NAME`
must point at a staging Secret Manager value holding base64-encoded 32 bytes. The
API deploy validates its presence and shape before deploying.

Staging deploy targets, public origins, runtime service account names, database
instance names, and Secret Manager names must contain `staging`. The workflows
reject staging deploys that would otherwise inherit production-looking values.

If staging enables delegated dashboard tokens or review MCP, set
`GRAPH_INTERNAL_TOKEN_SECRET_NAME` to a staging-scoped Secret Manager value
containing V2's `INTERNAL_API_TOKEN`. When Context is configured, the API deploy
workflow mounts it as `JINA_GRAPH_INTERNAL_TOKEN`. Without it, dashboard reads
use the static fallback and review MCP access is unavailable.

## Required Staging Secrets

Save these as GitHub Environment secrets on `Staging`:

| Name | Notes |
| --- | --- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Staging-only provider in `github-staging-pool`, restricted to `omxyz/jina`'s `staging` branch. |
| `GCP_SERVICE_ACCOUNT` | `jina-api-staging-deployer@jina-staging-20260802.iam.gserviceaccount.com`. |
| `STAGING_JINA_TRIGGER_ACCESS_TOKEN` | Token for the staging Trigger.dev project. |
| `STAGING_JINA_GITHUB_APP_PRIVATE_KEY` | Private key for the staging GitHub App. |
| `STAGING_JINA_INTERNAL_API_TOKEN` | Must match the staging Secret Manager internal token. |
| `STAGING_JINA_DAYTONA_API_KEY` | Daytona key explicitly approved for staging. |
| `STAGING_JINA_OPENROUTER_API_KEY` | Required model-gateway credential for staging managed reviews. |
| `STAGING_JINA_OPENAI_API_KEY` | Optional native OpenAI route for staging managed reviews. |
| `STAGING_JINA_GITHUB_CLONE_TOKEN` | Optional clone fallback. |

`OPENROUTER_API_KEY` is the only model gateway credential — the legacy direct
OpenAI/Codex/Anthropic/Claude keys were removed once all workers moved to
OpenRouter. The staging Trigger deploy fails if `JINA_OPENROUTER_API_KEY` is
unset.

Staging Trigger deploys read `JINA_*` GitHub Environment variables and the
explicit `STAGING_JINA_*` secret namespace only. Repository-level `JINA_*` and
generic production fallback names are unreachable from staging deploys.

## GCP Resources

Create staging resources with distinct names:

```bash
export GCP_PROJECT_ID=jina-staging-20260802
export GCP_REGION=us-east1

gcloud sql instances create jina-db-staging \
  --project "$GCP_PROJECT_ID" \
  --database-version=POSTGRES_16 \
  --region "$GCP_REGION"
gcloud sql databases create jina_staging \
  --project "$GCP_PROJECT_ID" \
  --instance=jina-db-staging

gcloud secrets create jina-staging-github-webhook-secret \
  --project "$GCP_PROJECT_ID" \
  --replication-policy=automatic
gcloud secrets create jina-staging-github-app-private-key \
  --project "$GCP_PROJECT_ID" \
  --replication-policy=automatic
gcloud secrets create jina-staging-internal-api-token \
  --project "$GCP_PROJECT_ID" \
  --replication-policy=automatic
gcloud secrets create jina-staging-trigger-secret-key \
  --project "$GCP_PROJECT_ID" \
  --replication-policy=automatic
gcloud secrets create jina-staging-github-oauth-client-secret \
  --project "$GCP_PROJECT_ID" \
  --replication-policy=automatic
gcloud secrets create jina-staging-database-url \
  --project "$GCP_PROJECT_ID" \
  --replication-policy=automatic

# Required: the API refuses to boot without SECRETS_ENCRYPTION_KEY. Seed it with
# base64-encoded 32 bytes. Keep it distinct from production and never rotate it
# casually or previously stored provider keys/sessions become undecryptable.
gcloud secrets create jina-staging-secrets-encryption-key \
  --project "$GCP_PROJECT_ID" \
  --replication-policy=automatic
openssl rand -base64 32 | gcloud secrets versions add jina-staging-secrets-encryption-key \
  --project "$GCP_PROJECT_ID" \
  --data-file=-

# Optional: only needed when JINA_BILLING_ENFORCE is set for staging.
gcloud secrets create jina-staging-autumn-secret-key \
  --project "$GCP_PROJECT_ID" \
  --replication-policy=automatic
```

If V2 Context integration is enabled, create a staging-scoped Secret Manager
value for the static dashboard fallback and set `GRAPH_API_TOKEN_SECRET_NAME` to
its name. Do not reuse production `jina-graph-api-token`. If delegated dashboard
tokens or review MCP are enabled, also set `GRAPH_INTERNAL_TOKEN_SECRET_NAME` to
the staging-scoped V2 internal-token secret described above.

Apply migrations before sending webhook traffic:

```bash
cd api
DATABASE_URL='postgres://...' npm run migrate
```

## Trigger.dev

Create a separate Trigger.dev project for staging. Use that project's:

- `JINA_TRIGGER_ACCESS_TOKEN` in the `Staging` GitHub Environment secret
- `JINA_TRIGGER_PROJECT_REF` in the `Staging` GitHub Environment variable
- production-style Trigger secret key in `jina-staging-trigger-secret-key`

The isolated project is `jina-staging-isolated` with ref
`proj_rqckjugodcaghbpgggbz`. The staging workflow rejects the production ref
`proj_gmesnthgwwqledarlfip`.

Do not use a `tr_dev_*` key for deployed staging unless intentionally testing a
locally connected Trigger dev worker. The API deploy rejects a `tr_dev_*` value
in `TRIGGER_SECRET_KEY_SECRET_NAME` unless `ALLOW_DEV_TRIGGER_SECRET_IN_DEPLOY`
is set to `true`.

Staging Trigger workers use OpenRouter as the only model gateway. Provide
`JINA_OPENROUTER_API_KEY` (and optionally the OpenRouter attribution/model
variables) so managed reviews can run.

## GitHub App

Create a separate staging GitHub App:

- Webhook URL: `https://jina-code-review-api-staging-679811160186.us-east1.run.app/webhooks/github`
- Webhook secret: value stored in `jina-staging-github-webhook-secret`
- OAuth callback: `https://jina-code-review-api-staging-679811160186.us-east1.run.app/auth/github/callback`
- Setup URL: `https://staging.usejina.com/integrations`
- Install it only on staging/test repositories.

The production GitHub App is installed organization-wide on `omxyz`. Creating
an `omxyz` test repository therefore does **not** create an isolated staging
acceptance target: GitHub will also deliver its pull requests to production.
Use an account/repository on which the production App is not installed, or use
a synthetic signed webhook plus a non-customer fixture. Verify installation
scope before opening a PR.

## Deploy Order

1. Create GCP database, service account, and Secret Manager values.
2. Create Trigger.dev staging project and configure staging Trigger secrets.
3. Create staging GitHub App and OAuth App.
4. Configure `Staging` GitHub Environment variables/secrets.
5. Deploy or verify the companion V2 Context service and its
   `/context/webhooks/github` endpoint.
6. Push or fast-forward the `staging` branch.
7. Run `Deploy API` from the `staging` branch with `target_environment=Staging`.
8. Run `Deploy Trigger` from the `staging` branch with `target_environment=Staging`.
9. Deploy the dashboard with
   `NEXT_PUBLIC_API_BASE_URL=https://jina-code-review-api-staging-679811160186.us-east1.run.app`.
10. Install the staging GitHub App on a test repository and open a PR.

## Validation

- `GET https://jina-code-review-api-staging-679811160186.us-east1.run.app/v1/healthz`
  returns `status: ok`.
- Staging GitHub App webhook delivery gets HTTP 200.
- A test PR creates a Jina comment/check under the staging app identity.
- Trigger.dev staging run logs and API dashboard records share the same review id.
- Daytona sandboxes created by staging use the expected staging resource profile.
