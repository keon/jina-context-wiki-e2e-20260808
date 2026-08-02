# V1 consolidation and staging release plan

## Objective

`omxyz/jina` is the source repository for both the original Jina review product and the
v2 Board/Context platform. The imported source is pinned in `platform/v1` at
`omxyz/jina-simulation@a2b795785e4bc5034052ab1b1bd9e1bd9ad42062`. The active
`apps/dashboard` application compiles the synchronized source at
`apps/dashboard/src/v1` so all routes use one React and Next.js runtime.

The old repository remains a rollback source until production promotion succeeds. Do not
delete it, change its production webhook, or transfer `app.usejina.com` during staging.

## Complete feature inventory

| Surface                         | Features retained in this repository                                                                                                                                                                                                         | Dashboard routes                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Identity and tenancy            | GitHub OAuth session, session refresh/logout, personal and organization workspaces, tenant switching, tenant create/rename, admin/member write fences                                                                                        | `/signin`, `/organization`                                                 |
| Reviews                         | Review feed, review/run detail, PR links, stage status, raw and summarized investigations, findings, publication status, billing attribution, MCP availability/usage telemetry                                                               | `/reviews`, `/reviews/[reviewRunId]`, `/runs`                              |
| Issues and historical artifacts | Cross-run issue feed/detail, finding anchors, legacy scenario lineage, scenario evidence, simulations, artifacts, and event timeline                                                                                                         | `/issues`, `/issues/[id]`, `/reviews/[reviewRunId]/scenarios/[scenarioId]` |
| Context                         | Repository/document tree, search/filtering, Markdown and Mermaid rendering, immutable citations, repository setup, build start, concurrent-build selection, progress/checkpoints, cancellation, and retained partial pages                   | `/context`                                                                 |
| Models and triggers             | Codex/ChatGPT subscription routing, BYOK and managed routing, Codex device/manual connect/reconnect/disconnect, model catalog/search/pricing, per-stage defaults and reasoning effort, fallback policy, automatic/manual review trigger mode | `/models`                                                                  |
| Integrations                    | OpenRouter OAuth/manual key, native OpenAI key, provider disconnect/reconnect, GitHub organization/install connections and repository backfill                                                                                               | `/integrations`                                                            |
| Billing and usage               | Autumn customer/plan state, subscriptions, manual top-up, auto-reload, automatic-review limits, credit and dollar views, billing activity, 7/30/90-day usage, daily usage, and recent runs                                                   | `/billing`, `/usage`                                                       |
| Repository guidance             | `.jina` quick start, runtime defaults, global/per-stage instruction precedence, examples, limits, and copyable setup prompt                                                                                                                  | `/jina`                                                                    |
| Existing v2 operations          | Board filters/task inspector/dependencies, event history, task-type/workflow trees, Context operational catalog and build inspection                                                                                                         | `/board`, `/history`, `/tasks`, `/operations/context`                      |

## Non-dashboard runtime retained

- GitHub webhook verification and relay to v2 Context.
- Pull-request, installation, repository, comment, and scheduled-review intake.
- Trigger.dev `review`, `review-summary`, `review-runtime`, installation-backfill,
  scheduled-scan, and billing-retry tasks.
- Daytona checkout, CodeGraph, Context MCP attachment, execution-first investigation,
  replanning, validation, deduplication, and GitHub review publication.
- OpenRouter capture/usage accounting, native OpenAI routing, Codex subscription harness,
  managed/BYOK billing policy, Autumn checkout, and every migration through `0028`
  (29 SQL files, including the two retained `0001` migrations).
- Historical scenario storage/read compatibility and offline evaluation datasets. Retired
  scenario-generation tasks remain retired exactly as they were upstream; the dashboard
  continues to render existing historical records.

## Source synchronization contract

`platform/v1/dashboard/app` is the vendored upstream source. `apps/dashboard/src/v1` is
the compiled mirror. `apps/dashboard/scripts/check-v1-sync.mjs` compares every file by
SHA-256 before tests, so drift fails CI. Dashboard route wrappers are intentionally thin;
`apps/dashboard/src/lib/dashboard-routes.test.ts` locks the complete v1 and v2 route
inventory.

Deployment workflows live at:

- `.github/workflows/deploy-v1-api.yml`
- `.github/workflows/deploy-v1-trigger.yml`
- `.github/workflows/validate-v1-platform.yml`

They run the vendored API and Trigger packages from their monorepo paths. The dashboard
is built only from `apps/dashboard`.

## Staging topology

Staging must be isolated before any webhook or customer traffic is admitted:

| Resource           | Required staging target                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub environment | `omxyz/jina` environment `Staging`, branch-restricted to `staging`                                                                        |
| Product API        | Cloud Run `jina-code-review-api-staging` in `jina-463721/us-east1`                                                                        |
| Product database   | PostgreSQL 16 `jina-db-staging`, database `jina_staging`, staging-only login and encryption key                                           |
| Context stack      | Staging-suffixed API/workers/jobs and artifact bucket; never the production services or production Context bucket                         |
| Trigger workers    | Separate Trigger.dev staging project and deploy/access keys                                                                               |
| Dashboard          | Separate Vercel staging project rooted at `apps/dashboard`, with `staging.usejina.com` only after smoke verification                      |
| GitHub identity    | Separate staging GitHub App/OAuth identity installed only on test repositories                                                            |
| Secrets            | Names and values containing/owned by staging; no production database URL, webhook secret, internal token, OAuth secret, or encryption key |

The existing `jina-simulation` `Staging` environment is only a partial scaffold: as of
2026-08-01 it has no secrets, no staging Cloud SQL instance, no staging Cloud Run
service, and no Trigger credentials. Copying that environment by name is not a deploy.

## Staging provisioning state (2026-08-01)

The consolidation created `omxyz/jina`'s real `Staging` GitHub Environment and restricts
it to the `staging` branch. Resource variables use staging-scoped Cloud Run, Cloud SQL,
dashboard, Context, and Secret Manager names. The Trigger workflow requires explicit
`STAGING_JINA_*` environment secrets; it cannot resolve repository-level production
provider keys.

Provisioned platform resources:

- `jina-463721`: PostgreSQL 16 instance `jina-db-staging` (Enterprise shared-core,
  zonal), v1 runtime service account, and independent webhook/internal/encryption/
  Context credentials. The `jina_staging` database has isolated v1 owner and hardened
  v2 runtime logins; all 29 v1 migrations and the 51-table Context schema are applied.
- `jina-v2`: v2 API, Context-worker, task-worker, and migration service accounts;
  staging-only internal/Context/checkpoint secrets; and the private
  `gs://jina-v2-jina-context-artifacts-staging-us-east1` bucket.
- Explicit staging aliases of the existing Daytona, OpenRouter, OpenAI, and clone
  credentials. These share vendor accounts and billing, but are stored under staging
  names and cannot be selected through a production-secret fallback. Replace them with
  dedicated vendor-account keys if hard provider-account isolation is required.
- Vercel project `omlabs/jina-staging-dashboard`, served at
  `https://jina-staging-dashboard.vercel.app`. All product routes return `200`; the four
  operational routes return `401` without staging Basic Auth and `200` with it.
- Dedicated operations tenant `ba699695-dc9f-431e-a89c-4dc98220f53e`, shared by the
  staging dashboard and v2 API configuration. The deployment script rejects labels and
  malformed identifiers in this database identity boundary.
- Healthy Cloud Run `jina-api-staging` plus ready `jina-context-worker-staging` and
  `jina-task-worker-staging` services. The dashboard proxy reaches the empty staging
  Board through the bound tenant. Until the staging GitHub App exists, the Context
  worker is limited to its configured clone-token fallback and is not accepted as proof
  of installation-token behavior.

Repository automation:

- `scripts/check-staging-readiness.sh` reports every missing GitHub, GCP, Cloud Run, and
  Vercel prerequisite without reading secret values.
- `scripts/deploy-staging-v2.sh` applies the v2 schema/roles and deploys only
  staging-suffixed API and worker services from immutable `staging` image tags.
- `.github/workflows/deploy-v1-api.yml` supports the first isolated staging service
  bootstrap and retains the canary/rollback path for every subsequent revision.

Account-owner prerequisites still required before any public staging traffic is
accepted:

1. Create a staging GitHub App and OAuth client, installed only on a test repository.
   Configure webhook
   `https://jina-code-review-api-staging-wvupra4l6a-ue.a.run.app/webhooks/github`, OAuth
   callback
   `https://jina-code-review-api-staging-wvupra4l6a-ue.a.run.app/auth/github/callback`,
   and setup URL `https://jina-staging-dashboard.vercel.app/integrations`.
2. Create a separate Trigger.dev staging project and provide its project ref, deploy
   access token, and production-style project secret key.
3. Provide an Autumn test-mode key before the billing write paths can be accepted.

Do not substitute the existing production GitHub App, OAuth client, Trigger project,
or live Autumn key for these three gates. Until they exist, local and database
acceptance is authoritative, but an end-to-end staging PR and billing checkout cannot be
claimed as verified. The merged dashboard, database schemas, v2 API, and fallback-capable
v2 workers are live. The v1 product API, Trigger workers, App-backed repository access,
and billing write paths remain intentionally gated until those credentials exist.

## Verification gates

1. The imported baseline must pass 409 API tests, 215 Trigger tests, 112 v1 dashboard
   tests, API/Trigger typechecks, and all production builds.
2. The merged dashboard must pass its route/synchronization tests and a Next.js
   production build containing every route in the inventory above.
3. Run all 29 product migration files against a fresh PostgreSQL 16 staging database, then
   run the PostgreSQL projection/identity/tenant isolation tests.
4. Verify unauthenticated, member, organization-admin, and cross-tenant denial behavior.
5. Exercise every dashboard read and write: tenant create/rename, GitHub connection,
   provider connect/disconnect, model and trigger settings, Context build/cancel, billing
   settings/checkout in test mode, review feed/detail, and historical pages.
6. Open and update a PR in a test repository. Prove the staging GitHub delivery, Trigger
   parent/child runs, Daytona sandbox, API review ID, Context MCP scope, usage rows,
   dashboard record, and GitHub feedback all agree.
7. Verify `/board`, `/history`, `/tasks`, and `/operations/context` against the staging v2
   API; no route may fall through to a production endpoint.
8. Confirm staging logs contain no secret values, tenant crossover, production database
   host, production Trigger project, or production GitHub App ID.

## Production promotion

Promote the exact accepted commit. Apply additive migrations first, deploy the product
API with zero traffic, deploy Trigger workers, deploy the merged dashboard without moving
the production domain, and run read-only acceptance. Then canary the API, move the
dashboard domain, and finally update the production GitHub App only if its webhook origin
changes. Keep the previous Cloud Run revision, Vercel deployment, Trigger deployment,
database backup, and old repository available for rollback until a full PR review and
billing/usage reconciliation complete in production.
