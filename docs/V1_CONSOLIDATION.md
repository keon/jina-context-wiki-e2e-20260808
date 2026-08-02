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
| Product API        | Cloud Run `jina-code-review-api-staging` in `jina-staging-20260802/us-east1`                                                              |
| Product database   | PostgreSQL 16 `jina-db-staging` in `jina-staging-20260802`, database `jina_staging`, staging-only logins and encryption key               |
| Context stack      | `jina-api-staging`, `jina-context-worker-staging`, `jina-task-worker-staging`, migration job, registry, and bucket in the staging project |
| Trigger workers    | Trigger.dev project `jina-staging-isolated` (`proj_rqckjugodcaghbpgggbz`) and staging-only keys                                           |
| Dashboard          | Vercel project `omlabs/jina-staging-dashboard`, rooted at `apps/dashboard`, serving `https://staging.usejina.com`                         |
| GitHub identity    | Separate staging GitHub App/OAuth identity installed only on test repositories                                                            |
| Secrets            | Names and values containing/owned by staging; no production database URL, webhook secret, internal token, OAuth secret, or encryption key |

## Staging provisioning state (2026-08-02)

The consolidation created `omxyz/jina`'s real `Staging` GitHub Environment and restricts
it to the `staging` branch. Resource variables use staging-scoped Cloud Run, Cloud SQL,
dashboard, Context, and Secret Manager names. The Trigger workflow requires explicit
`STAGING_JINA_*` environment secrets; it cannot resolve repository-level production
provider keys.

Provisioned platform resources:

- `jina-staging-20260802`: PostgreSQL 16 instance `jina-db-staging` (Enterprise
  shared-core, zonal), both registries, all V1/V2 Cloud Run services/jobs and
  service accounts, staging-only secrets, and the private
  `gs://jina-staging-20260802-context-artifacts-us-east1` bucket. The Om Labs
  billing account is shared; resource identities and data planes are not.
- The `jina_staging` database has an isolated V1 login, a hardened V2 runtime
  login with no role-administration flags, all V1 migrations, and the Context
  schema/roles. The V2 runtime can read only the four shared identity tables
  outside its own schema.
- A staging-only Workload Identity provider accepts only
  `omxyz/jina@refs/heads/staging`; the deploy workflows additionally reject the
  production GCP and Trigger project identifiers.
- Explicit staging aliases of the existing Daytona, OpenRouter, OpenAI, and clone
  credentials. These share vendor accounts and billing, but are stored under staging
  names and cannot be selected through a production-secret fallback. Replace them with
  dedicated vendor-account keys if hard provider-account isolation is required.
- Vercel project `omlabs/jina-staging-dashboard`, served at
  `https://staging.usejina.com`. HTTP Basic Auth is removed; GitHub OAuth is the
  dashboard identity boundary. All product and operational routes return `200`.
- Dedicated operations tenant `ba699695-dc9f-431e-a89c-4dc98220f53e`, shared by the
  staging dashboard and v2 API configuration. The deployment script rejects labels and
  malformed identifiers in this database identity boundary.
- Healthy Cloud Run `jina-code-review-api-staging`, `jina-api-staging`,
  `jina-context-worker-staging`, and `jina-task-worker-staging` services. The
  dashboard proxy reaches the empty staging Board through the bound operations
  tenant.
- Staging GitHub App `jina-staging-gcloud-omxyz` (App ID `4461130`) uses only
  the new V1 webhook/OAuth callback and `staging.usejina.com` setup/homepage
  URLs. GitHub OAuth sign-in and the installation callback are verified. A
  staging-only PR under the personal `keon` account completed the real webhook,
  Trigger, Daytona, GitHub publication, API persistence, and dashboard-detail
  flow under review id `b587d680-8451-4752-befc-c44248edfa6b`. Its temporary
  App installation was then removed and the staging App returned to private
  visibility.
- A production-sized Context build for `omxyz/jina-context-graph-e2e` commit
  `54d9f8aabe93870ed7f25a6fee0942da171dbee4` completed all 47 stages under build
  id `task_0bd2398154723b90a2e7cbf082b5207e`. Release
  `cr_8d93f1d7e1f207acff05aaa88cb00df9` published seven documents. Catalog,
  full-document read, search, all four MCP tools, scoped token minting, and
  immediate revocation were exercised against the staging API. The selected
  document contained 12,231 Markdown characters and 32 immutable citations.
- That live Context exercise found and fixed a deadline-edge retry defect: a
  tenant administrator may now extend and retry the exact dispatchable task
  that failed as the build deadline expired. The permission does not broaden
  to sibling tasks. The clean staging build was
  `5de04fa5-11a3-4c8b-96e0-b5024229fe6b`; the accepted Cloud Run revisions are
  `jina-api-staging-00002-7wd`, `jina-context-worker-staging-00002-wxn`, and
  `jina-task-worker-staging-00002-jfq`.

Repository automation:

- `scripts/check-staging-readiness.sh` reports every missing GitHub, GCP, Cloud Run, and
  Vercel prerequisite without reading secret values.
- `scripts/deploy-staging-v2.sh` applies the v2 schema/roles and deploys only
  staging-suffixed API and worker services from immutable `staging` image tags.
- `.github/workflows/deploy-v1-api.yml` supports the first isolated staging service
  bootstrap and retains the canary/rollback path for every subsequent revision.

Billing enforcement remains `off`; no Autumn production credential is mounted.
Billing read/empty-state routes are accepted, while checkout/top-up writes remain
outside staging acceptance until a dedicated test-mode Autumn key is provided.
Live provider connect/disconnect also remains a credentialed acceptance item: its
forms, routing, persistence contract, and automated tests pass, but no user's vendor
key was modified during staging acceptance.

The production GitHub App currently has organization-wide access to `omxyz`.
Consequently, an `omxyz` repository cannot be used as an isolated staging PR
target even when it is newly created: GitHub will deliver the PR to both Apps.
Use a repository/account without the production installation or a synthetic
signed-webhook fixture, and verify App installation scope before opening a PR.

## Verification gates

1. The imported baseline must pass 409 API tests, 216 Trigger tests, 112 v1 dashboard
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
