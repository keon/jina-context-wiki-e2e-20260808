# Deployment

The unified API lives in `apps/api`; product/review, Board, Context, causal graph,
and MCP routes ship in one backend image. Production and staging use the relational
one-task Board review path, with the task worker dispatching the pinned Trigger.dev
workflow. Context and causal-graph workflows use the generic snapshot Board and durable
outbox while their releases and projections are relational. All are executed by
`apps/worker`. The portable Daytona review runtime lives in `packages/review-agent`.
The customer dashboard deploys from `apps/dashboard`.

Every push to `staging` starts the `jina-staging-deploy` Cloud Build trigger in the
isolated `jina-staging-20260802` project. The trigger follows the same source-bound model
as production: it checks out the event SHA, runs `cloudbuild.staging.yaml`, validates the
repository, builds immutable API/worker images tagged `staging-<full merge SHA>`, and
passes that tag plus its UUID-valued `_JINA_CONTEXT_TENANT_ID` substitution to
`scripts/deploy-staging.sh`. The build waits for any older active invocation of the same
trigger before deployment, so overlapping pushes cannot interleave cutovers. The script
is fail-closed on any resource, service account, secret, database, tenant, bucket, URL,
or image tag that is not explicitly staging-scoped. If a post-cutover step fails, it
restores the exact prior API, Context, task, and causal revisions and reactivates the
prior causal release credential. The coordinated staging deploy also invokes the isolated
`scripts/deploy-staging-causal-graph.sh` lane with that same image tag, preventing the
unified API and causal worker from drifting across an artifact-protocol change. The
staging deploy installs the Board-recorded 15-minute billing retry schedule and the
OpenTelemetry sidecars, including the causal worker's release-gated sidecar. Production continues to use the
coordinated `cloudbuild.yaml` path below.

Staging dashboard auth defaults to Clerk and fails closed when its configured
publishable/secret key pair is unavailable.

The staging Context artifact bucket remains a platform prerequisite for legacy
Context artifacts. It must remain regional in `us-east1`, use uniform bucket-level
access, have no lifecycle rules or public IAM principals, and retain any object while
the legacy database references it. Each routine staging deploy performs only read-only
bucket shape checks before migrations or revision mutation; its build identity does not
need permission to read or change bucket IAM. The privileged
`scripts/check-staging-readiness.sh` audit separately verifies that the platform-owned
policy has no public principals. The app deploy does not create the bucket or change its
IAM policy.

New Trigger-backed wiki artifacts do not use this bucket in staging. The API revision
sets `JINA_WIKI_ARTIFACT_STORE=postgres` and stores their immutable bytes in the
tenant-scoped `jina_context.context_wiki_artifacts` table through
`PostgresWikiArtifactStore`. Stage artifacts and receipts, canonical content bundles,
and audit reports keep their existing `context/...` object keys and digest/generation
references, but the opaque positive `objectGeneration` now identifies an append-only
PostgreSQL row. The normal wiki read/query path still uses the compact published
document, search, citation, hierarchy, and release-pointer projections; it never scans
artifact `bytea`. `scripts/check-staging-readiness.sh` verifies this exact revision
environment contract. Production remains on the GCS wiki adapter until a separate,
explicitly reviewed cutover.

For an operator rerun, invoke the source-bound trigger with the exact audited staging SHA:

```sh
release_sha="$(git rev-parse origin/staging)"
gcloud builds triggers run jina-staging-deploy \
  --project=jina-staging-20260802 \
  --region=us-central1 \
  --sha="${release_sha}"
```

The core Cloud Run build and deployment identity is
`jina-cloud-build-staging@jina-staging-20260802.iam.gserviceaccount.com`; staging does not
use a GitHub Actions identity for Cloud Run deployment. The separate Context Trigger.dev
deployment described below uses its own GitHub environment credentials and cannot mutate
the Cloud Run lane. The Cloud Build account has
the project deployment roles checked by `scripts/check-staging-readiness.sh`, plus
`roles/secretmanager.secretVersionAdder` only on
`jina-staging-causal-graph-worker-release-credential`; only the staging project's Cloud
Build service agent can mint its short-lived build credentials. Cloud Scheduler is a
platform prerequisite; application deployment verifies that its API is enabled but does
not grant itself service-usage administration.

Before a staging deploy, run `scripts/check-staging-readiness.sh`. It verifies the
staging-only Cloud Build trigger, Cloud SQL runtime state, migration job, secrets,
services, domain mappings, dashboard projects, and causal-worker sidecar contract.
After deploy, follow `docs/STAGING_PR_E2E.md`; a green health check or review alone
is not sufficient acceptance because the exact-head Context release and its PageIndex
attachment are part of the pull-request contract.
The v2 database transition is complete: routine staging deploys use the unified
`jina-v2-migrate-staging` job, and the retired one-time cutover job and legacy database
credentials must remain absent.

## Context wiki Trigger.dev deployment

Wiki generation and non-gating audit run in the isolated
`services/context-trigger` Trigger.dev project. They do not run in the review project,
and Trigger tasks receive no database URL, Cloud SQL credential, GCS key, GitHub App key,
or bucket-wide permission. Every data operation uses a short-lived, operation-scoped
grant against the Context API. The Context worker only dispatches `run-wiki-build`; the
single Board task is completed later by the storage-attested Trigger callback.

Create these staging Secret Manager secrets before the first deploy:

```sh
staging_project=jina-staging-20260802
for secret_name in \
  jina-staging-context-trigger-secret-key \
  jina-staging-context-trigger-service-token \
  jina-staging-context-execution-grant-secret \
  jina-staging-context-trigger-dispatch-secret; do
  gcloud secrets describe "$secret_name" --project="$staging_project" >/dev/null 2>&1 || \
    gcloud secrets create "$secret_name" --project="$staging_project" \
      --replication-policy=automatic
done
```

The service token must have the same value in Secret Manager and the GitHub `Staging`
environment. Store independently generated 32-byte values for the service token,
execution-grant HMAC key, and dispatch HMAC key; put the isolated Context Trigger runtime
secret key only in `jina-staging-context-trigger-secret-key`. Grant the API service
account access to the service-token and two HMAC secrets. Grant the Context worker
service account access only to the Context Trigger runtime key.

Configure the GitHub `Staging` environment with:

- secret `STAGING_JINA_CONTEXT_TRIGGER_ACCESS_TOKEN`: deploy token for the isolated
  Context Trigger project;
- secret `STAGING_JINA_CONTEXT_TRIGGER_SERVICE_TOKEN`: the same bootstrap token mounted
  on the API;
- variables `JINA_CONTEXT_TRIGGER_PROJECT_REF`, `JINA_TRIGGER_PROJECT_REF`,
  `JINA_CONTEXT_INTERNAL_API_URL=https://api.staging.usejina.com`,
  `JINA_CONTEXT_TRIGGER_API_URL=https://api.trigger.dev`,
  `JINA_WIKI_AUDIT_POLICY_VERSION=audit.v1`, and a lowercase SHA-256
  `JINA_WIKI_AUDITOR_CONFIG_DIGEST`.

`JINA_CONTEXT_TRIGGER_PROJECT_REF` must differ from both the staging review project and
the production review project. Deploy the Trigger project from the exact staging SHA:

```sh
gh workflow run deploy-context-trigger.yml \
  --repo=omxyz/jina --ref=staging -f target_environment=Staging
gh run watch --repo=omxyz/jina --exit-status
```

The ordinary source-bound staging Cloud Build deploy then mounts
`JINA_WIKI_PIPELINE_MODE=trigger`, `JINA_WIKI_ARTIFACT_STORE=postgres`, and the three
API authority secrets, and adds
`run-wiki-build` to the Context worker. Existing four-stage Context topics remain during
the compatibility window so already-admitted work can drain; new wiki admissions always
create exactly one Board task. `scripts/check-staging-readiness.sh` verifies the four
Context Trigger secrets, while `scripts/cloud-build-deploy.test.mjs` statically verifies
the runtime isolation and environment contract. The staging validation step keeps its
complete log inside the Cloud Build step, emits up to 400 terminal lines capped at
48,000 bytes on failure, and emits only a bounded success record. This keeps the
actionable failure or deployment diagnostics visible in GitHub's size-limited Cloud
Build check. Successful staging image builds and pushes also use Docker's quiet mode;
Docker errors remain fatal and visible, while routine layer and package progress cannot
displace the serialized deployment result.

Cloud Build validates, builds, and deploys one coordinated release to
`jina-v2/us-east1`. API, worker, dashboard, and admin images are built from the same
exact source revision, receive the same unique Cloud Build release identity, and are
deployed to Cloud Run before production acceptance runs.

## Resources

- Artifact Registry: `us-east1-docker.pkg.dev/jina-v2/jina`
- Cloud Run services: `jina-api`, `jina-context-worker`, `jina-causal-graph-worker`,
  `jina-task-worker`, `jina-dashboard`, `jina-admin`
- Cloud Run jobs: `jina-context-daytona-preflight`, one short-lived
  `jina-context-release-<short-build-id>` control job per coordinated release,
  `jina-context-migrate`, `jina-acceptance`,
  and operator-run `jina-context-production-trigger-acceptance`
- Primary Cloud SQL: `jina-463721:us-east1:jina-db`, database `jina`
- Context artifact bucket: `gs://jina-v2-jina-context-artifacts-us-east1`
- API service account: `jina-api-runtime@jina-v2.iam.gserviceaccount.com`
- Context-worker service account: `jina-context-worker@jina-v2.iam.gserviceaccount.com`
- Causal-graph-worker service account:
  `jina-causal-graph-worker@jina-v2.iam.gserviceaccount.com`
- Task-worker service account: `jina-task-worker@jina-v2.iam.gserviceaccount.com`
- Dashboard service account: `jina-dashboard@jina-v2.iam.gserviceaccount.com`
- Admin service account: `jina-admin@jina-v2.iam.gserviceaccount.com`
- Acceptance service account: `jina-acceptance@jina-v2.iam.gserviceaccount.com`
- Trigger-acceptance service account:
  `jina-trigger-acceptance@jina-v2.iam.gserviceaccount.com`
- Migration-only service account: `jina-migration@jina-v2.iam.gserviceaccount.com`
- Build/deploy service account:
  `jina-cloud-build-deployer@jina-v2.iam.gserviceaccount.com`
- Pull-request validator: `jina-cloud-build-ci@jina-v2.iam.gserviceaccount.com`

No Google service-account key is stored in GitHub or the web applications.

The causal graph uses the generic Board storage and command framework, but it is not a
Context build stage. Its four task types and three topics are disjoint, only
`jina-causal-graph-worker` may claim them, and its worker generation is selected in
`jina_runtime.causal_graph_release_control`. Context workers continue to use
`jina_runtime.release_control`; neither release row can authorize the other service.

## Platform bootstrap prerequisites

Cloud Build deliberately does not bootstrap shared infrastructure. A platform operator
must create the Context artifact bucket and grant the build identity its narrowly scoped
Cloud SQL backup and bucket permissions before the first release. The deploy script
validates the bucket at the start of its deploy stage, before Daytona, Cloud SQL, GCS, or
serving services are mutated, and fails with a bootstrap-specific error when the contract
is incomplete.

Create the cross-project custom Cloud SQL role with only the permissions needed to create
and verify the release backup, then bind it to the build service account:

```sh
if gcloud iam roles describe jinaContextBackupOperator \
  --project=jina-463721 >/dev/null 2>&1; then
  gcloud iam roles update jinaContextBackupOperator \
    --project=jina-463721 \
    --title="Jina Context Backup Operator" \
    --permissions=cloudsql.backupRuns.create,cloudsql.backupRuns.get,cloudsql.backupRuns.list,cloudsql.instances.get \
    --stage=GA
else
  gcloud iam roles create jinaContextBackupOperator \
    --project=jina-463721 \
    --title="Jina Context Backup Operator" \
    --permissions=cloudsql.backupRuns.create,cloudsql.backupRuns.get,cloudsql.backupRuns.list,cloudsql.instances.get \
    --stage=GA
fi

gcloud projects add-iam-policy-binding jina-463721 \
  --member=serviceAccount:jina-cloud-build-deployer@jina-v2.iam.gserviceaccount.com \
  --role=projects/jina-463721/roles/jinaContextBackupOperator
```

Do not substitute `roles/cloudsql.editor` or `roles/cloudsql.admin`. The build identity
does not migrate the schema itself; the dedicated migration service account owns that
boundary.

Create the artifact bucket with uniform bucket-level access and public access prevention,
then grant storage administration to the build identity on this bucket only:

```sh
gcloud storage buckets create gs://jina-v2-jina-context-artifacts-us-east1 \
  --project=jina-v2 \
  --location=us-east1 \
  --uniform-bucket-level-access \
  --public-access-prevention

gcloud storage buckets add-iam-policy-binding gs://jina-v2-jina-context-artifacts-us-east1 \
  --member=serviceAccount:jina-cloud-build-deployer@jina-v2.iam.gserviceaccount.com \
  --role=roles/storage.admin
```

Never grant `roles/storage.admin` to the build service account at project scope. Its
bucket-scoped grant permits the coordinated deploy to maintain the API runtime's
`roles/storage.objectUser` binding without granting control over unrelated buckets.
Do not add an age-based lifecycle rule: certified `context-release` objects seed later
incremental builds and PageIndex trees remain referenced by release history.

As verified on 2026-07-30, the custom role is GA with exactly the four permissions above
and is bound unconditionally in `jina-463721`. The production bucket exists as a regional
`US-EAST1` STANDARD bucket with uniform bucket-level access, no lifecycle rule, no
public IAM principal, and an unconditional bucket-scoped `roles/storage.admin` binding
for the build identity. That identity has no project-wide storage-administrator binding.
Public access prevention is explicitly enforced, and anonymous access returns HTTP 403.
Changing that setting remains a platform operation, not part of an application
deployment.

Create the release-scoped credential secret once. Cloud Build adds two independent
numbered versions per release: a short-lived deployment-control credential and a
worker-generation credential. Control and migration jobs mount only the first;
the exact candidate worker revisions mount only the second, while the release-control
row stores the worker credential's SHA-256 digest:

```sh
gcloud secrets create jina-worker-release-credential \
  --project=jina-v2 \
  --replication-policy=automatic

gcloud secrets add-iam-policy-binding jina-worker-release-credential \
  --project=jina-v2 \
  --member=serviceAccount:jina-cloud-build-deployer@jina-v2.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretVersionManager

for account in jina-context-worker jina-task-worker jina-migration; do
  gcloud secrets add-iam-policy-binding jina-worker-release-credential \
    --project=jina-v2 \
    --member="serviceAccount:${account}@jina-v2.iam.gserviceaccount.com" \
    --role=roles/secretmanager.secretAccessor
done
```

Do not mount `latest`. The deploy writes the worker-generation version into both
candidate worker revisions, retains that version after acceptance so future scale-out
can start, and always destroys the independent control version after releasing its
lease. It destroys an unaccepted worker version only after claims are paused, candidate
revisions are removed, and Board leases are independently proven empty.

Create the causal graph worker identity and release secret once. Its secret is separate
because a causal worker rollout must not rotate a credential used by either Context or
review work:

```sh
gcloud iam service-accounts create jina-causal-graph-worker \
  --project=jina-v2 \
  --display-name="Jina causal graph worker"

gcloud secrets create jina-causal-graph-worker-release-credential \
  --project=jina-v2 \
  --replication-policy=automatic

gcloud secrets add-iam-policy-binding jina-causal-graph-worker-release-credential \
  --project=jina-v2 \
  --member=serviceAccount:jina-cloud-build-deployer@jina-v2.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretVersionManager

for secret in \
  jina-causal-graph-worker-release-credential \
  jina-internal-api-token \
  jina-daytona-api-key \
  jina-github-app-id \
  jina-github-app-private-key \
  jina-github-clone-token; do
  gcloud secrets add-iam-policy-binding "${secret}" \
    --project=jina-v2 \
    --member=serviceAccount:jina-causal-graph-worker@jina-v2.iam.gserviceaccount.com \
    --role=roles/secretmanager.secretAccessor
done

gcloud iam service-accounts add-iam-policy-binding \
  jina-causal-graph-worker@jina-v2.iam.gserviceaccount.com \
  --project=jina-v2 \
  --member=serviceAccount:jina-cloud-build-deployer@jina-v2.iam.gserviceaccount.com \
  --role=roles/iam.serviceAccountUser
```

Create the production-trigger acceptance identity and its fixture-App secrets once.
The fixture App must be installed only on `omxyz/jina-context-graph-e2e`; its current
App ID is `4434994` and installation ID is `150069172`. Store the App ID and PEM private
key in `jina-trigger-acceptance-github-app-id` and
`jina-trigger-acceptance-github-app-private-key`. Grant the dedicated service account
access only to those two secrets plus the internal token and the two operational
GitHub-App secrets:

```sh
gcloud iam service-accounts create jina-trigger-acceptance \
  --project=jina-v2 \
  --display-name="Jina production trigger acceptance"

for secret in \
  jina-internal-api-token \
  jina-github-app-id \
  jina-github-app-private-key \
  jina-trigger-acceptance-github-app-id \
  jina-trigger-acceptance-github-app-private-key; do
  gcloud secrets add-iam-policy-binding "${secret}" \
    --project=jina-v2 \
    --member=serviceAccount:jina-trigger-acceptance@jina-v2.iam.gserviceaccount.com \
    --role=roles/secretmanager.secretAccessor
done

gcloud iam service-accounts add-iam-policy-binding \
  jina-trigger-acceptance@jina-v2.iam.gserviceaccount.com \
  --project=jina-v2 \
  --member=serviceAccount:jina-cloud-build-deployer@jina-v2.iam.gserviceaccount.com \
  --role=roles/iam.serviceAccountUser
```

The deploy validates that the service account and both secrets exist. It never grants
these IAM bindings, mounts the fixture credentials into a serving worker, or executes
the trigger-acceptance job.

## Runtime credentials and identity

The API mounts:

- `jina-shared-db-password` as `DB_PASS`;
- `jina-github-webhook-secret` as `GITHUB_WEBHOOK_SECRET`;
- `jina-internal-api-token` as `INTERNAL_API_TOKEN`;
- `jina-context-api-token` as `CONTEXT_API_TOKEN`;
- `jina-context-private-checkpoint-key` as
  `CONTEXT_PRIVATE_CHECKPOINT_KEY`.

`jina-context-private-checkpoint-key` in Google Secret Manager must exist before release.
The name supplied by `_JINA_CONTEXT_DAYTONA_MODEL_SECRET` must also exist in Daytona when
the managed provider or managed fallback is enabled. That Secret is created through a
Daytona user session with organization Secret permission; the deployment API key may use
it to create sandboxes even when it cannot list or create organization Secrets. Neither
prerequisite is auto-created by Cloud Build.

Before any Cloud SQL mutation, every coordinated release creates a network-blocked,
ephemeral Daytona sandbox from the configured immutable snapshot or image, executes a
bounded filesystem command, and deletes it. This probe verifies Daytona access and the
sandbox runtime without coupling deployment availability to one model provider. A full
release then verifies the tenant-selected model and credential through the real Context
acceptance build. Mechanical releases deliberately make no model-health claim.

The migration job runs as `jina-migration`, mounts
`jina-primary-owner-db-password`, and connects to the primary database as the
schema-owning `jina_app` login.

The API uses its dedicated service account, mounts `jina-shared-db-password`, and
connects as the non-owning `jina_v2_app` runtime login. The Context and review workers
use their own service accounts and call the API; they have no Cloud SQL attachment and
do not mount a database credential. No runtime service account may access the owner
secret, and the migration service account must not be assigned to a network-facing
service. Do not swap or reuse these identities or credentials.

Each runtime service account must hold `roles/secretmanager.secretAccessor` on every secret
its service mounts. The deployment does not grant these bindings, and it cannot detect a
missing one until Cloud Run rejects the revision, which happens after every image has been
built and pushed. `jina-context-worker` mounts `jina-github-clone-token` for the manual and
public-repository build fallback, so that binding is required in addition to the ones it
already held:

```bash
gcloud secrets add-iam-policy-binding jina-github-clone-token \
  --project=jina-v2 \
  --member=serviceAccount:jina-context-worker@jina-v2.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor
```

A missing binding surfaces as
`Permission denied on secret: ... for Revision service account ...` while
`gcloud run deploy` or `gcloud run jobs deploy` creates the candidate. Candidate
deployment does not route serving traffic, although the coordinated schema transition
may already have advanced by that point. Fix the exact secret binding and roll the same
coordinated release forward; do not attempt a mixed-version rollback.

`INTERNAL_API_TOKEN` authorizes board, worker, and administration traffic. It is also the
only service credential accepted by `POST /internal/context/access/sync`.
`CONTEXT_API_TOKEN` is deliberately narrower: it is accepted only by
`POST /wiki/search`, `POST /mcp`, and the read-only context routes
`GET /wiki/releases`, `GET /wiki/list`, `GET /wiki/read`, and
`GET /wiki/diff`. These routes return citation-grounded derived context, never a
generated answer. The credential is bound server-side to one tenant and principal, and
every route is repository-filtered by that principal's access. Writes, administration,
board traffic, and metrics stay with `INTERNAL_API_TOKEN`, and the method is checked so a
write cannot reach a read path.

Per-principal tokens are issued rather than configured. A token is
`jina_atk_<43 chars base64url>`, stored only as a SHA-256 hash in
`public.api_tokens` (promoted from `jina_context` so product features can share the
same credentials), and verified on every request by the `jina_context_tokens`
capability role — the one capability role that reads across tenants, because
verification resolves the tenant from the token it is looking up. Mint with
`POST /internal/context/tokens` (body: `principalId`, `name`, `scopes`,
`expiresInMinutes`, optionally `administrator: true`); the secret is returned once and is
not retrievable afterwards. List with `GET /internal/context/tokens` and revoke with
`POST /internal/context/tokens/{id}/revoke`, which takes effect immediately.

Neither `INTERNAL_API_TOKEN` nor `CONTEXT_API_TOKEN` may begin with `jina_atk_`. The
verification branch runs first and would shadow them; `createApiServer` refuses such a
configuration at startup rather than at the first request.

Deploying this needs the roles reinstalled, not just the schema applied: the table arrives
with `CONTEXT_SCHEMA_SQL` at boot, but `jina_context_tokens` reaches the runtime login only
when the migration runs with `--install-roles`. Until it does, every `jina_atk_` bearer is
a 401 and nothing else changes.

Every production API revision with a context credential must also set
`JINA_CONTEXT_TENANT_ID` and `JINA_CONTEXT_PRINCIPAL_ID`. Those values
server-side bind the query bearer and the access-synchronization mutation target to one
identity; tenant/principal headers may be omitted or repeat the configured values but
cannot select different ones. Other internal-token routes send `x-jina-principal-id`;
shared-database callers also send `x-jina-tenant-id`. Browser MCP origins, when present,
must exactly match `JINA_MCP_ALLOWED_ORIGINS`.

Public `POST /wiki/search` and `POST /mcp` bodies are capped at 128 KiB. A search
query is limited to 4,000 characters and may select at most 25 tree nodes. MCP applies
the same limits through `search_context`; `list_context`, `read_context`, and
`diff_context` are read-only release operations.

| Cloud Build substitution                                 |                                          Default | Guidance                                                                                                                                                                                                                           |
| -------------------------------------------------------- | -----------------------------------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_JINA_API_MIN_INSTANCES`                                |                                              `1` | Keeps one API container warm.                                                                                                                                                                                                      |
| `_JINA_API_MAX_INSTANCES`                                |                                              `4` | Allows bounded API scale-out during worker and dashboard request bursts.                                                                                                                                                           |
| `_JINA_API_CONCURRENCY`                                  |                                             `10` | Maximum concurrent API requests per instance.                                                                                                                                                                                      |
| `_JINA_API_DB_POOL_MAX`                                  |                                              `3` | Maximum connections in the shared Context/product pool and shared-identity pool. Context checkout is bounded at ten seconds; JSON Board state owns a dedicated two-connection pool with thirty-second checkout and idle deadlines. |
| `_JINA_API_CPU`                                          |                                              `1` | API CPU allocation.                                                                                                                                                                                                                |
| `_JINA_API_MEMORY`                                       |                                            `1Gi` | API memory allocation.                                                                                                                                                                                                             |
| `_JINA_CONTEXT_WORKER_MEMORY`                            |                                            `1Gi` | Memory reserved for repository cloning, evidence parsing, and derivation.                                                                                                                                                          |
| `_JINA_CONTEXT_WORKER_MIN_INSTANCES`                     |                                             `20` | Warm polling executors; Board queue depth does not trigger Cloud Run request autoscaling.                                                                                                                                          |
| `_JINA_CONTEXT_WORKER_MAX_INSTANCES`                     |                                            `100` | Hard ceiling for concurrency-one Context workers. Twenty are kept warm by default.                                                                                                                                                 |
| `_JINA_TASK_WORKER_MAX_INSTANCES`                        |                                              `5` | Maximum concurrency-one generic task workers.                                                                                                                                                                                      |
| `_JINA_CONTEXT_DAYTONA_SNAPSHOT`                         |      `jina-context-board-codex-0-145-0-bwrap-v2` | Audited immutable Codex-and-bubblewrap-ready snapshot.                                                                                                                                                                             |
| `_JINA_CONTEXT_DAYTONA_IMAGE`                            |                                            empty | Required unless the snapshot substitution is set; pin an image by digest.                                                                                                                                                          |
| `_JINA_CONTEXT_DAYTONA_MODEL_SECRET`                     |                            `jina-context-openai` | Daytona organization Secret containing the model credential.                                                                                                                                                                       |
| `_JINA_CONTEXT_DAYTONA_MODEL_SECRET_ENV`                 |                                 `OPENAI_API_KEY` | Environment variable populated from the Daytona Secret.                                                                                                                                                                            |
| `_JINA_CONTEXT_DAYTONA_MODEL_DOMAINS`                    |                                 `api.openai.com` | Comma-separated sandbox model-provider allowlist.                                                                                                                                                                                  |
| `_JINA_WORKER_RELEASE_SECRET`                            |                 `jina-worker-release-credential` | Precreated Secret Manager secret receiving independent control and worker-generation versions per release.                                                                                                                         |
| `_JINA_ACCEPTANCE_REPOSITORY`                            |                   `omxyz/jina-context-graph-e2e` | Registered purpose-built repository used by production acceptance.                                                                                                                                                                 |
| `_JINA_ACCEPTANCE_GITHUB_INSTALLATION_ID`                |                                      `140435029` | Operational read-only App installation used for build metadata and webhook audit.                                                                                                                                                  |
| `_JINA_TRIGGER_ACCEPTANCE_GITHUB_APP_ID_SECRET`          |          `jina-trigger-acceptance-github-app-id` | Secret containing the fixture-mutation App ID.                                                                                                                                                                                     |
| `_JINA_TRIGGER_ACCEPTANCE_GITHUB_APP_PRIVATE_KEY_SECRET` | `jina-trigger-acceptance-github-app-private-key` | Secret containing the fixture-mutation App PEM key.                                                                                                                                                                                |
| `_JINA_TRIGGER_ACCEPTANCE_GITHUB_INSTALLATION_ID`        |                                      `150069172` | Fixture-only mutation App installation; must differ from the operational installation.                                                                                                                                             |
| `_JINA_ACCEPTANCE_DERIVATION_BUDGET_SECONDS`             |                                          `10800` | Three-hour agent-stage budget for the measured 2.5-hour full build.                                                                                                                                                                |
| `_JINA_ACCEPTANCE_DERIVATION_TOKEN_BUDGET`               |                                       `24000000` | Hard input-plus-output model-token ceiling for the acceptance build.                                                                                                                                                               |
| `_JINA_ACCEPTANCE_TIMEOUT_MS`                            |                                       `10800000` | Three-hour acceptance polling window.                                                                                                                                                                                              |
| `_JINA_ACCEPTANCE_JOB_TIMEOUT_SECONDS`                   |                                          `11700` | Three hours fifteen minutes, leaving cleanup/logging time.                                                                                                                                                                         |
| `_JINA_DEPLOYMENT_ACCEPTANCE_MODE`                       |                                     `mechanical` | Nonblocking release gate; explicit `full` also runs the multi-hour candidate Context build before cutover.                                                                                                                         |

The API request timeout is 3,600 seconds. Each instance has a shared Context/product
pool capped at three connections with a ten-second checkout deadline, a dedicated
Board-state pool capped at two with thirty-second checkout and idle
deadlines, and a shared-identity pool capped at three. With four live instances, their
configured maxima total 32 connections; raise a configurable limit only while
preserving an explicit aggregate database connection budget.

Dashboard/admin values are server-side Cloud Run environment variables and secrets:
`JINA_API_URL`, `INTERNAL_API_TOKEN`, `JINA_WEB_AUTH_USERNAME`,
`JINA_WEB_AUTH_PASSWORD`, `JINA_TENANT_ID`, and `JINA_WEB_PRINCIPAL_ID`. The coordinated
deployment binds both apps to the acceptance tenant/principal and mounts
`jina-web-auth-password` plus `jina-internal-api-token`. The admin may instead derive
`tenant:<JINA_TENANT_ID>` when only a tenant ID is configured. One principal binding is
required whenever the app has `INTERNAL_API_TOKEN`. Never use a `NEXT_PUBLIC_` prefix for
a credential.

## Worker configuration

The context service keeps twenty one-concurrency polling instances warm by default,
with continuous CPU and a hard ceiling of one hundred. Every instance claims the same
Board topic set, which lets independent page builds execute in parallel while the Board
keeps their dependencies and checkpoints durable:

```text
WORKER_TOPICS=run-context-input-snapshot|run-context-page-plan|run-context-page-build|run-context-publication
JINA_REQUIRE_GITHUB_INSTALLATION=false
CONTEXT_GITHUB_HISTORY_LIMIT=500
CONTEXT_GIT_HISTORY_LIMIT=5000
CONTEXT_MAX_FILE_BYTES=5242880
CONTEXT_MAX_SNAPSHOT_BYTES=8388608
CONTEXT_BOARD_EXECUTOR=daytona
CONTEXT_DAYTONA_SNAPSHOT=<immutable Daytona snapshot containing Codex>
CONTEXT_DAYTONA_MODEL_SECRET=<Daytona organization Secret name>
CONTEXT_DAYTONA_MODEL_SECRET_ENV=OPENAI_API_KEY
CONTEXT_DAYTONA_MODEL_DOMAINS=api.openai.com
# Optional Secret Manager-mounted managed credential. When present, this is
# injected into the private ephemeral sandbox instead of the Daytona Secret.
JINA_MANAGED_MODEL_API_KEY=<managed provider credential>
CONTEXT_CODEX_MODEL=gpt-5.6-terra
CONTEXT_CODEX_EFFORT=low
CONTEXT_CODEX_VERBOSITY=high
CONTEXT_CODEX_CONTEXT_TOKENS=128000
CONTEXT_CODEX_COMPACT_TOKENS=96000
CONTEXT_PAGEINDEX_PYTHON=/opt/pageindex-venv/bin/python
CONTEXT_PAGEINDEX_WORKER=/opt/pageindex-worker/worker.py
PAGEINDEX_SOURCE_ROOT=/opt/PageIndex
```

Production refuses to infer local execution: a Board agent worker exits during
startup unless `CONTEXT_BOARD_EXECUTOR=daytona`. Exactly one
`CONTEXT_DAYTONA_SNAPSHOT` or `CONTEXT_DAYTONA_IMAGE` is required. Prefer an
immutable snapshot; if an image is used, pin it by digest. The selected sandbox
must contain a compatible `codex` executable. The coordinated build defaults to
`jina-context-board-codex-0-145-0-bwrap-v2`. The snapshot must contain both the
Codex CLI and a working `bubblewrap` binary; the preflight requires Codex to
write and verify a sandboxed sentinel rather than accepting `codex --version`
alone. Before any database, bucket, or serving-service
mutation, `jina-context-daytona-preflight` creates a private ephemeral sandbox, mounts
the named organization Secret, requires `codex --version`, and sends a non-private,
schema-constrained `AUTH_OK` request to `gpt-5.6-terra` at low effort. This bounded probe
uses the explicit `openai_direct` provider configuration required for Daytona's opaque
Secret placeholder, and verifies egress substitution and actual model authentication
rather than only the binary. A missing snapshot, missing/inaccessible Secret,
incompatible toolchain, or failed model request fails the release closed.

Context workers use the unified `JINA_API_URL` and additionally require
`JINA_PRODUCT_INTERNAL_API_TOKEN` when tenant model routing is enabled. For every build,
the worker resolves the write-once profile created by the unified API and honors its Context model,
reasoning effort, credential revision, and fallback policy. Credential/configuration,
quota, and unknown-model failures are terminal and remain visible on the task board;
only transient provider/sandbox failures consume bounded automatic retries.
Production stores the latter under the current
`jina-product-internal-api-token` secret name. Review and Context workers intentionally
use different service-internal tokens. Rotate this mirror whenever the review
internal token rotates; only the Context worker
service account receives accessor permission.

`CONTEXT_DAYTONA_MODEL_SECRET` is the Jina-managed fallback's Daytona organization
Secret name, never its credential value. Production may instead mount
`JINA_MANAGED_MODEL_API_KEY` from Secret Manager when Daytona opaque-placeholder
substitution is unavailable; the worker treats it as a protected value and passes it
only to the build's private, provider-domain-restricted ephemeral sandbox. Tenant BYOK or Codex credentials arrive
through the authenticated execution-profile endpoint, are added to redaction, and
are injected only into the build's private ephemeral sandbox. They are not mounted as
static Cloud Run configuration or persisted by the Context service. The sandbox receives only the exact
repository archive and declared stage inputs and may reach only the selected
model-provider domain.

The context worker mounts read-only `GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY`, `GITHUB_CLONE_TOKEN`, and `DAYTONA_API_KEY`.
Snapshot work mints a short-lived installation token whenever a build carries
`githubInstallationId`. The mint is restricted to the build's exact repository
and read-only `contents`, `issues`, `pull_requests`, and `metadata`; the returned
scope is validated before checkout. This remains true when the controlled
production-trigger fixture also has a separate write-capable mutation App; that
fixture identity is mounted only into the operator-run trigger-acceptance job.
`GITHUB_CLONE_TOKEN` is the manual-build fallback. Production and staging run only the
one-task relational review bridge. There is no review-pipeline compatibility mode or
legacy queue-drain lane.

The worker image embeds the pinned PageIndex OSS source, isolated Python
environment, and bridge. The pin is commit
`982514ab40fe42a169ea087c13819cf87c87724f` with expected source digest
`b96135e27a2f725971a90ada1c8979d9110d640778bcbdae57b1587f97ffc0a5`;
the image build probes both. The `run-context-publication` task invokes that local
bridge as part of atomic publication; private context is never sent to PageIndex Cloud. The API image
contains neither Codex nor model credentials and does not contain PageIndex source or
Python. It performs bounded deterministic lexical search over the published tree.

Production API configuration is:

```text
CONTEXT_GCS_BUCKET=<project>-jina-context-artifacts
CONTEXT_PRIVATE_CHECKPOINT_KEY=<Secret Manager: base64 key or versioned JSON keyring>
JINA_WIKI_ARTIFACT_STORE=gcs # current default; staging alone selects postgres
```

The precreated artifact bucket is a platform prerequisite. The deployment verifies its
region, uniform access, absent lifecycle rules, lack of direct public bucket principals,
and the build identity's bucket-scoped administration; it does not create or reconfigure
the bucket. After validation it grants the API runtime `roles/storage.objectUser` and
mounts `OPENAI_API_KEY` plus `jina-context-private-checkpoint-key`. Certified
`context-release` objects are immutable inputs to later incremental builds, and
published `pageindex-tree` objects remain referenced by release history, so deleting
every object after a fixed age would make valid database releases unreadable.
Intermediate/private cleanup must be a reference-aware garbage collector or a separate
artifact-class bucket; until one exists, production retains every object. Generate the
initial checkpoint secret with `openssl rand -base64 32`. For rotation,
replace the secret value with a JSON keyring whose `activeKeyId` names the new key and
whose `keys` object retains the previous key until its live checkpoints expire, then
deploy a new API revision so new instances resolve that Secret Manager version:

```json
{ "activeKeyId": "2026-07", "keys": { "2026-06": "<old-base64-key>", "2026-07": "<new-base64-key>" } }
```

New private envelopes carry the authenticated key ID, while pre-key-ID envelopes are
tried against the bounded retained ring. The private archive is fetched separately from
the JSON preparation bundle over a lease-scoped, no-store, 20 MiB-bounded internal
endpoint. Local development instead
uses `CONTEXT_CODEX_AUTH=session` and the current signed-in Codex session. Private context
is never sent to PageIndex Cloud.

The API always receives Cloud SQL configuration in the coordinated deployment.
Consequently quota mutations use the PostgreSQL `jina_context_quota` capability
and tenant-scoped `context_quota_ledgers`, never the single-process in-memory
development adapter. Query/build rate limits, active build/model-task limits,
artifact-storage accounting, and monthly model request/token accounting use the
versioned application defaults. There is currently no production environment
override for those limits; changing them is an application/configuration
release, not an unreviewed deployment flag.

Model-backed Board tasks reserve tenant capacity when claimed. Local and Daytona
executors parse exact Codex `turn.completed` input, cached-input, and output
counts; the worker aggregates multiple calls made under one lease, and
successful completion is rejected if exact usage is absent. The API commits
that usage idempotently by task and rejects a replay whose counts change. These
are tenant-level quota records, not per-token billing records; see
[API_TOKENS.md](API_TOKENS.md) for the remaining attribution and reporting work.

Cloud Run CLI treats commas as environment separators, so deployed topic lists use pipes.
Local processes may use commas.

### Authoritative remote head and failure behavior

A build accepts an optional full `commitSha`; push-triggered builds carry the event head
SHA. The worker performs a full blob-filtered clone (no shallow depth), explicitly fetches
the branch to `refs/remotes/origin/<ref>`, resolves the fetched remote head, and checks it
out detached. The optional SHA is an expected-head fence, not permission to index a
historical commit as current: a mismatch means the ref moved and fails ingestion. A
manual build without `commitSha` selects the fetched head. The worker persists up to
`CONTEXT_GIT_HISTORY_LIMIT` commits and parents, materializes up to 500 recent commits for
derivation, and includes changed paths on the checkpoint commit. It paginates repository
metadata, PRs, issues, issue comments, PR review comments, and commit discussion comments
up to `CONTEXT_GITHUB_HISTORY_LIMIT`. It preserves every manifest entry when binary or
oversized file bodies are omitted.

The checkpoint is `complete` only when Git history reaches its root, every optional
GitHub source reaches a final page, and no body is omitted. Reaching a configured bound,
receiving an optional GitHub 403/404, or omitting a body produces `partial`, with exact
counts/reasons/paths recorded in the observation frontier. Unverified commit identity or
an invalid tree still fails closed. Releases expose source completeness explicitly.

At request admission, the API allocates a monotonic `refSequence` for the exact
tenant/repository/ref under the same advisory lock used by ref-sensitive canonical
writes, and records it on the build and ingest stage. The checkpoint retains that
sequence. If an earlier accepted push finishes after a later accepted push, the earlier
checkpoint remains stored for audit but cannot commit derived context, become current,
or publish a release over the higher
admitted sequence. Pull-request heads are freshness-first: a new head cancels the older
preview immediately, retires its leases, and releases its quota. Unstarted default-ref
builds are also cheap to replace. Once a push-, issue-, or manually-triggered build has
invested work, however, the Board records later admissions as immutable
`context.build_followup_requested` events instead of canceling it. The history remains
immutable, but only the newest follow-up is eligible for promotion. A recoverable failed
build retains that follow-up while an operator retry resumes its failed stage from the
same immutable checkpoints; admitting the successor first would strand that invested
work behind a newer ref sequence. After the predecessor publishes, its release becomes
the incremental seed and the API automatically admits the newest follow-up at the next
ref sequence. An unrecoverable terminal predecessor may still yield to the follow-up.
Worker claims also reconcile pending follow-ups, so process loss between completion and
promotion cannot strand them. Request-key redelivery reuses either the existing build or
the same deferred follow-up.

The Board is the only production scheduler. The active page-oriented graph has
four claimable topics: input snapshot, page planning, per-page construction, and
publication. Research planning, bounded subject research, and publication
planning are checkpointed phases inside the planner lease. Writing, citation
audit, and at most one repair/replacement-audit cycle are checkpointed inside
each page lease. Page tasks can fan out after planning; subject research is
currently sequential inside the planner. Publication resolves every page
disposition, builds PageIndex, and atomically advances the release. Completed
phase artifacts are immutable GCS checkpoints, so a fenced retry can reuse them
without making partial work queryable.

Only classified transient provider, sandbox, model, or API-transport failures
request an automatic retry. The Board atomically records a bounded diagnostic,
retires the old delivery and quota reservation, increments the attempt, and
queues the same task with a fresh lease/fence while preserving completed sibling
tasks and immutable artifacts. Deterministic contract/validation failures remain
terminal. `CONTEXT_BOARD_MAX_ATTEMPTS` defaults to and may not exceed the hard
limit of four; exhaustion fails the task and root without publication. A
lease-scoped completion request is idempotent, so a lost response cannot
schedule two retries.

An administrator may resume a deterministic failure after its contract or
implementation has been fixed without discarding completed checkpoints:

```bash
curl -X POST \
  "$JINA_API_URL/wiki/builds/$BUILD_TASK_ID/tasks/$FAILED_TASK_ID/retry" \
  -H "Authorization: Bearer $CONTEXT_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"requestKey":"operator:incident-123:planner-v2","reason":"publication-plan dependency contract fixed"}'
```

The issued token needs `context:admin`, its principal must be a tenant
administrator, and both IDs are tenant scoped. The request is accepted only for
one failed, unpublished Context build whose selected task is a failed
dispatchable task below the four-attempt hard limit with completed
prerequisites. The Board rejects completed roots, concurrent or ambiguous
branches, another independent failure, and reopening work behind an already
published release. A failed publication task may replay through the
authoritative idempotent publication transaction, including PageIndex
construction. Side-effect retries are rejected when a newer ref sequence has
been admitted, and the transaction revalidates the live Board fence and
immutable release identity. The Board retires old delivery fences, reopens only
the selected task plus its failed/canceled required dependent chain, retains
completed siblings and artifacts, and queues a fresh attempt. The same
`requestKey` returns the original result without adding another attempt; reuse
for a different task is rejected.
`task.operator_reopened` and `task.operator_retry_scheduled` events record the
actor, reason, request key, attempts, and affected tasks. Before the Board update
commits, the API reactivates that completed build's quota reservation under the
active-build limit without consuming another build-rate token; a Board conflict
compensates the reservation back to completed. Only the selected current task and its
required failed/canceled dependent chain are reopened.

The worker fetches the exact checkpoint SHA, creates a bounded Git archive, and
supplies Codex a read-only repository plus only the stage inputs declared by
the Board task. Server tokens, GitHub credentials, database credentials, GCS
credentials, other tenant artifacts, and unrelated process environment are not
sandbox inputs. Results return through bounded declared files and the
lease/fence-scoped API. A source-aware citation audit checks every public core
evidence binding, deterministic validation requires a grounded lead and every
substantive section to contain a usable anchor, and writers normally spend one
decisive evidence link per substantive section, increasing to two or at most
three only for distinct high-impact claims rather than citing every sentence.
Publication remains unavailable until every planned page has a valid explicit
disposition and the complete derived catalog and PageIndex tree validate.

The snapshot worker must allowlist GitHub provider response fields before artifact
upload. Temporary clone tokens, authorization material, clone endpoints, and nested
provider credentials are neither retained in GCS nor materialized into agent
workspaces; the worker snapshot regression test is the release gate for this boundary.

The result must match the versioned context-document contract. Full initialization
organizes a supported context catalog; incremental commit/PR/issue builds start from the
prior release, update affected logical documents, add newly supported documents, and
explicitly retire documents whose support disappeared. The host validates body markers,
structured facts/questions/diagnostics, citation ordinals, exact claim excerpts, identities, and
scope. Only revisions whose every citation identity/digest is present in the exact
generation checkpoint are selectable; matching ref+commit history is not enough.
Equivalent-evidence derivation cache reuse remains safe because publication performs
that checkpoint-membership check. Each page has at most one repair/replacement-audit
cycle; a still-unsupported new page is omitted and a still-unsupported revision retains
the prior validated bytes. Worker writes are fenced by the current Board lease.

The API Cloud Run request timeout is 60 minutes. A Context operation may run longer in
its sandbox and terminal completion has a separate deadline, but its Board authority is
a five-minute renewable lease. The worker heartbeats every minute, so a healthy long
operation keeps its authority while a terminated process becomes reclaimable within
five minutes. Deployment validation requires the lease to cover at least three heartbeat
intervals. Checkpointed model phases then resume without replaying completed work.

The pinned PageIndex Markdown hierarchy and deterministic bounded lexical tree search
are active. Retrieval returns context packs and citations without invoking a model or
synthesizing an answer.

## CI and image build

Pull-request Cloud Build runs `cloudbuild.ci.yaml` with a validation-only service account.
The shared CI script runs:

```sh
node --test scripts/cloud-build-deploy.test.mjs
pnpm typecheck
pnpm lint
pnpm test
pnpm audit --prod --audit-level=high
pnpm --filter @jina/dashboard build
pnpm --filter @jina/admin build
```

Database integration tests receive an ephemeral PostgreSQL 16 service through
`TEST_DATABASE_URL`.

The release race gate is mandatory and must not be skipped. `pnpm test` plus retained
release evidence must cover monotonic per-ref build allocation, delayed completion of
a lower-sequence push, rejection of stale prior-release seeds, live Board lease checks
for publication and attachment, one-time attachment immutability, direct repository
authorization, and causal-release sequence fencing. No stale release may become
query-visible.

The supported production path is the approval-gated `jina-main-deploy` trigger over
`cloudbuild.yaml`. It builds all four images, deploys all five services, and runs
migration plus acceptance in one build. Start it from a clean checkout of the exact
audited SHA:

```sh
release_sha="$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
gcloud builds triggers run jina-main-deploy \
  --project=jina-v2 \
  --region=us-east1 \
  --sha="${release_sha}"
```

Record both `release_sha` and the returned Cloud Build ID. Before approval, describe that
exact build and verify its source revision, deployer service account, 21,600-second
timeout, and `PENDING` approval state:

```sh
gcloud builds describe "<build-id>" \
  --project=jina-v2 \
  --region=us-east1 \
  --format='yaml(id,status,source,serviceAccount,timeout,substitutions,approval)'
gcloud beta builds approve "<build-id>" \
  --project=jina-v2 \
  --region=us-east1
```

If the main-branch event also created another pending build for the same SHA, inspect and
cancel only that exact duplicate before approval. Never approve two coordinated releases
for the same source revision.

The build uses its unique ID
for the deployed API, worker, dashboard, and admin image tags, so every service resolves
to the exact artifact produced from that audited source. `latest` is also pushed for API
and worker convenience, but the deploy script does not select it. API/worker-only split
build files are unsupported; deployments use the current
full-build `$BUILD_ID`.

### Independent causal graph release

The causal graph is the one supported split lane. Run `cloudbuild.causal-graph.yaml`
instead of `cloudbuild.yaml`; it does not deploy, pause, drain, or delete either Context
worker or the review worker, it never acquires the Context deployment lease, and it
cannot deploy or route the shared `jina-api` service. The coordinated main release is
the only release train that owns shared API traffic. When a causal change adds or
changes an API/Board contract, deploy that backward-compatible contract with
`cloudbuild.yaml` first. The causal lane then performs three bounded changes:

1. install the additive causal release tables and causal-only release-control table;
2. verify and consume the stable shared API identity without mutating it; and
3. activate and route an exact `jina-causal-graph-worker` revision whose allowlist is
   exactly `run-causal-graph-history|run-causal-graph-derive|run-causal-graph-publication`.

Submit the audited SHA directly:

```sh
release_sha="$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
gcloud builds submit \
  --project=jina-v2 \
  --region=us-east1 \
  --config=cloudbuild.causal-graph.yaml \
  --substitutions=_JINA_CAUSAL_GRAPH_DAYTONA_SNAPSHOT='<immutable-snapshot>',_JINA_CAUSAL_GRAPH_DAYTONA_MODEL_SECRET='<organization-secret-name>' \
  "https://github.com/omxyz/jina.git#${release_sha}"
```

An immutable Daytona image digest may be supplied with
`_JINA_CAUSAL_GRAPH_DAYTONA_IMAGE` instead of a snapshot. Never set both. The causal
worker has one reserved instance, concurrency one, and its own maximum-instance limit,
so causal writes and agent runs cannot consume Context worker capacity. The API/Board
database transaction remains the shared consistency boundary; graph publication writes
one immutable artifact metadata row and one current-pointer row regardless of graph
cardinality. The API image built by this lane is used only by its migration and
activation jobs; it is never deployed as the shared API service.

Context derivation keeps twenty polling workers warm by default so independent page
tasks and builds can execute in parallel. Planner-internal subject research and
page-internal write/audit/repair phases remain sequential inside their respective
leases. These workers pull from the Board without inbound requests, so Cloud Run request
autoscaling cannot observe queue depth. Override the actual pool with
`JINA_CONTEXT_WORKER_MIN_INSTANCES` and `JINA_CONTEXT_WORKER_MAX_INSTANCES`. The generic
task service keeps one warm worker and may scale to five. Model provider limits and
tenant token budgets remain the authoritative cost bounds. Each tenant may hold twenty
active model-task reservations; the 100-worker service ceiling provides shared headroom
across tenants and repositories.

The production transition program is copied into both immutable backend images at
`/opt/jina/context-production-preflight.mjs` and executed from that path by the Daytona,
and release-control jobs. Do not encode it into an environment variable: Cloud
Run limits one environment-variable value to 32 KB, while this audited program is larger.

## Pre-deployment backup

The coordinated deploy reuses a successful backup from the same release attempt or
creates an on-demand primary backup after all non-mutating preflights and before owner
DDL. It looks up the exact backup by the unique coordinated release description,
describes that backup ID, and proceeds only when Cloud SQL reports `SUCCESSFUL`. The deployer
therefore needs the `jinaContextBackupOperator` binding documented in
[Platform bootstrap prerequisites](#platform-bootstrap-prerequisites). To inspect the
resulting release backup as an operator:

```sh
gcloud sql backups list \
  --project=jina-463721 \
  --instance=jina-db \
  --limit=5
```

The deploy summary and release evidence record the backup ID, release SHA,
repository/ref inventory, expected ACL principals, and timestamp. A manually supplied
or merely scheduled backup is not accepted as a substitute for the coordinated backup.

## Deploy

The coordinated `cloudbuild.yaml` invocation above calls
`scripts/cloud-build-deploy.sh`, which:

1. verifies the precreated GCS bucket's location, uniform access, absent lifecycle and
   direct public-principal bindings, and bucket-scoped build identity before any cloud
   mutation;
2. resolves every coordinated image to an immutable digest, verifies all referenced
   Google secrets/service accounts, and runs the Daytona snapshot/organization-Secret/Codex
   toolchain probe;
3. derives a short `c-<64-bit build prefix>` traffic tag, proves the tagged DNS label
   fits all five live Cloud Run service identifiers, creates independent
   deployment-control and worker-generation credentials, and acquires a renewable lease
   in `jina_runtime.release_control`; an overlapping release fails before worker mutation;
4. under that lease, runs the exact schema-layout preflight and creates and verifies an
   on-demand Cloud SQL backup while the serving workers remain untouched;
5. deploys claim-disabled Context and task-worker drain revisions from the exact pinned
   worker image with a revision-level minimum of zero, closes only new-claim admission
   for the serving generation, and waits up to 30 minutes for its existing lease holders
   to renew and complete normally; the zero minimum keeps the routing fence from running
   background Board reconciliation while owner DDL waits for the state-store lock;
6. in the same locked transaction that proves the durable Board contains zero active
   leases, fences the old generation, then routes each worker service to its drain, removes every
   traffic tag, synchronously deletes every prior worker revision, and proves that only
   its drain revision remains. If the bounded wait fails, claim admission is restored
   without changing production worker traffic;
7. rechecks the exact schema under the still-live deployment lease immediately before
   owner DDL;
8. executes `jina-context-migrate` as the dedicated `jina-migration` identity with
   capability-role installation and runtime-login grants; the migration mounts the
   deployment-control credential, verifies the live deployment lease, and holds the
   Board advisory lock for its full DDL/role critical section;
9. verifies that the migration produced exactly the current seven-table Context
   schema and no compatibility views before any candidate starts;
10. enables only the exact candidate generation in the database and deploys all five
    services as short-tagged candidate revisions with
    `--no-traffic` and exact revision suffixes, then proves that each worker service
    contains exactly its paused drain and its claim-enabled candidate, both use the
    coordinated image digest, and only the candidate targets the tagged candidate API;
11. by default, performs the mechanical candidate gate and cuts over after all five
    candidates are healthy and worker isolation is proven. This keeps a multi-hour
    repository build out of the deployment lease and avoids pausing the production
    worker generation while Context work is queued. An operator may explicitly set
    `_JINA_DEPLOYMENT_ACCEPTANCE_MODE=full` for a blocking release that also executes the
    candidate-only production acceptance job. That job requires health attestations and
    Board completion receipts naming the exact release and worker revision; an eligible
    failed branch may resume its retained checkpoints with at most four recoveries;
12. only after the selected acceptance gate succeeds, routes all five exact candidate
    revisions to 100%, replaces every older traffic tag with the one accepted release
    tag, deletes both paused drains, proves that each worker service contains only its
    accepted candidate revision, releases the deployment lease, destroys the independent
    control credential, and deletes and verifies absence of the short-lived control job.
13. after that cleanup succeeds, deploys
    `jina-context-production-trigger-acceptance` against the stable API with its
    dedicated service account and split operational/fixture App credentials, but does
    not execute it. This job is an auxiliary operator tool: a reconciliation failure is
    reported separately and does not invalidate an already accepted, serving release.

Foreground API, dashboard, and admin traffic stays on the prior release until cutover.
Background worker traffic changes only after the serving generation has drained to zero
leases: it is then placed on the paused drains and prior worker revisions are deleted.
An unaccepted failure after generation fencing first
closes the database claim gate, removes enabled candidates, returns both services to the
paused drains, fences residual leases, independently verifies zero, destroys the
unaccepted worker-generation credential and verifies its Secret Manager state is
`DESTROYED`, restores the serving API's Board DML grant without enabling worker claims,
and only then releases the deployment lease. This keeps intake, cancellation, and
webhooks operational while rejected workers remain fenced. Lease renewal stays active
through that destruction, grant restoration, and zero-lease proof. Secret destruction
and control-job deletion use bounded retries and explicit state/absence verification. If
any fail-closed proof before lease release fails, the release extends its lease for
twelve hours and leaves the drains paused for operator repair. Cleanup failure after an
accepted cutover fails the build and reports only the control artifacts whose absence
was not verified, but never invokes candidate cleanup or attempts a mixed-version
rollback. A failure after both cleanup proofs instead reports the exact later phase and
explicitly states that no release-control repair is needed.

`mechanical` is the default release policy. It still runs
validation, the model-free Daytona infrastructure preflight, backup, worker drain, lease
fencing, migration, candidate health/readiness, worker-generation isolation, coordinated
cutover, and control-artifact cleanup. It skips only `jina-acceptance`, so it does not claim that derived Context,
retrieval, token isolation, or web rendering has passed end to end. Verify those as an
ordinary post-cutover Context build without holding the deployment lease or pausing the
serving worker generation. Use `full` only when a blocking candidate-only acceptance is
specifically required.
Prior worker revisions are not rollback candidates.
Once cutover begins there is likewise no supported mixed-version rollback; if a traffic
update fails, finish routing the exact already-accepted revisions and repeat the
retrieval/surface checks:

```bash
gcloud run services update-traffic jina-api \
  --project=jina-v2 --region=us-east1 \
  --to-revisions=jina-api-<cloud-build-id>=100
```

After a coordinated release is serving, explicitly execute the deployed
[production trigger acceptance](CONTEXT_PRODUCTION_TRIGGER_ACCEPTANCE.md). The
candidate `jina-acceptance` job proves manual full generation and retrieval before
cutover; the post-deploy gate then proves actual GitHub issue, comment, commit, PR-open,
and PR-synchronize delivery, idempotency, completed incremental frontiers, and fixture
cleanup against the stable webhook target. Its final marker update deliberately admits
the branch and PR-preview frontiers together, and its 24-hour task envelope reflects
that this is a comprehensive operator-run check rather than a release gate.

The migration installs `jina_context` and its capability roles from scratch with
`--install-roles`. It requires `CONTEXT_RUNTIME_DB_USER`, ensures that login is
`NOINHERIT` and outside `cloudsqlsuperuser`, revokes any `jina_context_admin`
membership, and grants the remaining focused NOLOGIN roles. Tenant administration uses
`jina_context_tenant_admin`, whose RLS never accepts the wildcard system scope. The
migration login therefore needs schema ownership and `CREATEROLE`; runtime services
start with schema management disabled and activate a capability per transaction with
`SET LOCAL ROLE`. The migration does not copy or translate prior semantic indexes.
Active repositories must be reingested.

### Worker release isolation

Cloud Run traffic isolation alone is not sufficient for these services. A worker polls
the Board in the background with CPU throttling disabled; an instance does not need an
incoming request to claim. Therefore a no-traffic candidate does not isolate it from a
previous serving revision.

Every release first acquires a renewable database deployment lease. The lease is renewed
every five minutes through acceptance; a second build cannot replace revisions, fence
leases, migrate, or cut over while it is live. The release then deploys
`jina-context-worker-drain-<Cloud Build ID>` and
`jina-task-worker-drain-<Cloud Build ID>` with
`JINA_WORKER_CLAIM_MODE=paused`. Paused mode serves a healthy status endpoint but never
calls `/internal/worker/claim` and does not initialize a model-backed executor.

The release-control row has two distinct gates. `worker_claims_enabled` authorizes the
ordinary Context/task generation to mutate existing leases; its generation identity is
independent from the causal worker's release-control row. `worker_accepts_claims` is the
shared admission gate for new Context, task, and causal claims. The control job first
sets it to false under the Board advisory lock. New claims fail closed, while each exact
serving generation remains authorized to renew, complete, or release leases. A bounded
control job observes the durable lease inventory until it reaches zero. If it times out
or the release otherwise fails in this phase, `worker-resume` reopens claim admission
and production traffic is left untouched. Claim admission also reopens when the
renewable deployment lease expires, so a terminated release controller cannot strand
otherwise valid worker generations in drain mode.

The drain waiter clears the generation identity and temporarily revokes runtime writes
to `jina_runtime.api_state` in the same locked transaction that observes zero leases.
The deployment then routes
each worker service 100% to its exact paused drain, clears all revision tags,
synchronously deletes every other revision, and checks the resulting inventory. Every
drain and candidate explicitly restores automatic scaling, preventing a stale manual
instance count from multiplying Board pollers across later releases. Paused drains use
a zero revision-level minimum; accepted candidates restore their configured warm
minimum. Deletion is
deliberate: routing an old polling revision to zero percent does not by itself prove its
minimum instances have terminated. A final zero-lease check precedes schema mutation.
The standalone `worker-pause` recovery action applies the same locked zero-lease guard.
The atomic waiter closes the race between observation and fencing even during the first
rollout from an API revision that does not yet understand the shared claim-admission gate.
Schema inspection and the verified backup already completed before quiescence; the
schema is checked again under the deployment lease before migration.
Lease renewal intentionally does not take the Board advisory lock: migration holds that
lock across its full critical section, while renewal continues to serialize
on the release-control row and release-control advisory lock. All gate-changing actions
still take the Board lock before the release-control lock.

An accepted candidate restores runtime writes as part of `worker-enable`. A rejected
candidate restores only the runtime table grant after its generation credential is
destroyed and zero leases are verified; the release-control row continues to disable
worker claims.

During acceptance, each worker service may contain exactly two revisions: the paused
drain and `jina-*-worker-<Cloud Build ID>`. The deployment checks the full revision
inventory, image digest, claim mode, release ID, candidate API URL, and candidate traffic
tag before starting the acceptance job. Every claim, renew, release, and complete request
also carries the version-scoped credential and Cloud Run service/revision identity. The
API checks that tuple against `jina_runtime.release_control` inside the same transaction
as the Board mutation; a stale process cannot win a pause race. Acceptance additionally
requires worker health attestations and release-matching completion receipts for every
completed dispatchable Context task. It reads those receipts only through the internal,
tenant- and repository-scoped
`GET /internal/context/builds/{buildId}/worker-completions` view; aggregate and manual
Board tasks are not worker-executed and therefore do not require receipts.

### How the capability split survives a managed runtime login

PostgreSQL 16 and later only let a `CREATEROLE` login alter a role it holds `ADMIN
OPTION` on. The migration login (`JINA_MIGRATION_DB_USER`, `jina_app`) therefore cannot
alter a runtime login that the instance superuser created, which is how a managed Cloud
SQL user is provisioned. The capability split does not depend on altering it.

Each capability is granted `WITH INHERIT FALSE`, so the membership is dormant until a
transaction activates exactly one with `SET LOCAL ROLE`. That needs `ADMIN OPTION` only
on the capability roles the migration just created, never on the runtime login, so
`--install-roles` requires no privileged preparation and stays idempotent. Marking the
runtime login `NOINHERIT` is attempted as well, but is skipped with a notice when this
login may not alter it, because the per-membership grants already carry the guarantee.

This holds regardless of how the runtime login was provisioned. To confirm it after a
release, check that no capability membership inherits (both queries must return `0`):

```sql
SELECT count(*) FROM pg_auth_members m
  JOIN pg_roles u ON u.oid = m.member
  WHERE u.rolname = 'jina_v2_app' AND m.inherit_option;
SELECT count(*) FROM pg_auth_members m
  JOIN pg_roles g ON g.oid = m.roleid
  JOIN pg_roles u ON u.oid = m.member
  WHERE u.rolname = 'jina_v2_app' AND g.rolname = 'jina_context_admin';
```

Because membership grants require `ADMIN OPTION`, the runtime login can neither restore
inheritance on its own membership nor grant itself `jina_context_admin`. Note that
`jina-main-deploy` starts a full release on every push to `main`.

Before approving a release, inspect IAM and the deployed identities:

```sh
gcloud secrets get-iam-policy jina-primary-owner-db-password --project=jina-v2
gcloud run jobs describe jina-context-migrate \
  --project=jina-v2 --region=us-east1 \
  --format='value(spec.template.spec.template.spec.serviceAccountName)'
gcloud run services list \
  --project=jina-v2 --region=us-east1 \
  --format='table(metadata.name,spec.template.spec.serviceAccountName)'
```

The migration job must report `jina-migration@jina-v2.iam.gserviceaccount.com`. Each
service must report the dedicated identity listed under Resources. The owner-secret
policy must grant the migration identity and must not grant any runtime identity, broad
project members, or `allUsers`/`allAuthenticatedUsers`. Failing any of these checks
blocks deployment.

The primary Cloud SQL instance is in the separate `jina-463721` project. The migration
Google service account and database-using runtime service accounts require
`roles/cloudsql.client` there. The migration-owner password secret remains in `jina-v2`
and grants direct secret access only to `jina-migration`. Project-level Cloud SQL IAM
does not imply secret access, and secret access does not imply Cloud SQL connectivity.
The coordinated deploy validates both cross-project Cloud SQL grants and the
migration/runtime database-role boundary before it changes traffic. Treat a failure of
either check as a release blocker; never compensate by granting the migration secret to
a runtime identity.

## Production acceptance

The 3-hour-15-minute `jina-acceptance` job receives the internal API credential and the
app-level web authentication secret from Secret Manager and uses a three-hour
polling/derivation budget. It deliberately does not mount the static
`CONTEXT_API_TOKEN`; after publication it mints a five-minute `jina_atk_` token for the
already ACL-bound query principal, uses that token for every Context HTTP and MCP
assertion, and revokes it during cleanup. The window is based on the measured
approximately 2.5-hour full Board run and leaves fifteen minutes for setup, cleanup,
and log collection. Unless
`ACCEPTANCE_REPOSITORY` and `ACCEPTANCE_REF`
override it, the job uses the existing external fixture
`omxyz/jina-context-graph-e2e@main`. The coordinated Cloud Build exposes the repository
as `_JINA_ACCEPTANCE_REPOSITORY`, so an explicitly registered replacement can be selected
without changing the worker. Production also sets
`ACCEPTANCE_GITHUB_INSTALLATION_ID=140435029`, causing the build to exercise GitHub App
token minting instead of the fallback clone token. The deploy script also sets
`ACCEPTANCE_PRINCIPAL_ID` to the same non-admin identity bound by
`JINA_CONTEXT_PRINCIPAL_ID`, and sets a distinct tenant administrator in
`ACCEPTANCE_ADMIN_PRINCIPAL_ID`. The job:

```text
API: JINA_CONTEXT_TENANT_ID=<acceptance tenant>
API: JINA_CONTEXT_PRINCIPAL_ID=user:context-query@jina.internal
job: ACCEPTANCE_TENANT_ID=<same tenant>
job: ACCEPTANCE_PRINCIPAL_ID=user:context-query@jina.internal
job: ACCEPTANCE_ADMIN_PRINCIPAL_ID=<configured tenant administrator>
job: ACCEPTANCE_CONTEXT_WORKER_URL=<release-tagged candidate URL>
job: ACCEPTANCE_CONTEXT_WORKER_AUDIENCE=<stable Context worker status.url>
job: ACCEPTANCE_TASK_WORKER_URL=<release-tagged candidate URL>
job: ACCEPTANCE_TASK_WORKER_AUDIENCE=<stable task worker status.url>
job: ACCEPTANCE_DASHBOARD_URL=<release-tagged candidate URL>
job: ACCEPTANCE_DASHBOARD_AUDIENCE=<stable dashboard status.url>
job: ACCEPTANCE_ADMIN_URL=<deployed admin>
job: INTERNAL_API_TOKEN=<Secret Manager: internal credential>
job: ACCEPTANCE_WEB_AUTH_PASSWORD=<Secret Manager: app-level password>
job: ACCEPTANCE_GITHUB_INSTALLATION_ID=<fixture installation>
job: ACCEPTANCE_REQUEST_KEY=deploy-<Cloud Build ID>
job: ACCEPTANCE_DERIVATION_BUDGET_SECONDS=10800
job: ACCEPTANCE_DERIVATION_TOKEN_BUDGET=24000000
job: ACCEPTANCE_TIMEOUT_MS=10800000
```

Worker health checks use Cloud Run identity tokens with the stable base service URL
as their audience even though acceptance sends each request to a release-tagged
candidate URL. Dashboard traffic is protected by IAP instead. The acceptance service
account signs a one-hour JWT whose audience is the exact candidate URL plus `/*`, sends
it in `Authorization`, and relies on IAP to inject the verified caller identity. The
dashboard then forwards its configured tenant principal to the API; the IAP identity
proves the caller may cross that deployment boundary. The stable dashboard URL remains
a required guard value so acceptance rejects an untagged target before minting the JWT.

The deploy identity needs `roles/iap.admin` in `jina-v2` and
`roles/iam.serviceAccountAdmin` on the acceptance service account. Each deployment
idempotently grants the acceptance identity `roles/iap.httpsResourceAccessor` on
`jina-dashboard` and `roles/iam.serviceAccountTokenCreator` on itself. Keep the latter
binding on that one service account rather than granting token creation project-wide.

`ACCEPTANCE_PRINCIPAL_ID` must not be a tenant administrator. The administrator may use
the internal credential but must not be substituted for the context-bearer identity; this
ensures production acceptance exercises ordinary query authorization. The API and
dashboard retain their deployed static-token configuration; only the acceptance job is
prevented from receiving that static Context token.

1. uses the internal credential and `mode:"merge"` to add the fixture repository to the
   query principal's ACL without replacing unrelated repositories;
2. uses the distinct administrator to start `POST /wiki/build` with the configured
   GitHub installation ID;
3. follows the page-oriented Board graph through snapshot, planning, parallel
   page construction, bounded repair, PageIndex construction, and atomic
   publication, and
   rejects failed or blocked work. Before querying the release, it requires the
   tenant-scoped worker-completion view to attest that every completed dispatchable
   Context task ran on the exact candidate Context-worker release and revision;
   the polling timeout calls the internal exact-build cancellation route and
   requires a confirmed canceled root, so a failed deployment gate cannot leave
   model work running in the background;
4. requires an immutable context release at one full commit SHA;
5. mints an acceptance token whose `createdAt`/`expiresAt` interval is exactly five
   minutes, with exactly `context:read` and `context:query` scopes for the bound
   non-admin principal, and verifies it cannot start builds, read administrator
   metrics or Board state, cross tenant boundaries, substitute a different
   `x-jina-principal-id`, or administer access tokens;
6. uses only that issued token to call release, list, read, diff, and search HTTP
   routes; requires a complete PageIndex hierarchy, complete document body,
   immutable diff endpoints, no generated answer, and original evidence anchors;
7. uses the same issued token with the real MCP SDK, asserts exactly
   `search_context`, `list_context`, `read_context`, and `diff_context`, calls
   every tool, and verifies their immutable releases, document bodies, hierarchy,
   diff endpoints, and original citations;
8. revokes the issued token during cleanup even if mint response parsing or a query
   assertion fails. Cleanup always lists active tokens and removes every token whose
   name and principal exactly match this build, including a stale token from a crashed
   or replayed acceptance, then verifies no matching token remains. Whenever the
   response included the secret, the job also proves that both HTTP and MCP reject it
   after revocation;
9. uses app-level HTTP authentication plus a Cloud Run identity token to exercise the
   deployed dashboard API proxy, then requires the deployed admin server render to
   contain the same certified repository and release.

The job exits `20` for workflow failures, `21` for release/commit failures, `22` for
context availability, `23` for HTTP/MCP retrieval or citation failures, and `25` for
transport or unexpected failures. Inspect the job execution logs before
retrying with a new request key.

Release evidence also records the build ID, stage IDs, repository/ref/commit,
`refSequence`, release ID, document/citation counts, duration, the backup ID,
immutable image/source SHA, deployed service accounts,
and owner-secret IAM inspection.

## Migrations and roles

For a local or administrative database:

```sh
DATABASE_URL=postgresql://... pnpm --filter @jina/db migrate
CONTEXT_RUNTIME_DB_USER=jina_runtime \
  DATABASE_URL=postgresql://migration-owner:... \
  pnpm --filter @jina/db migrate -- --install-roles
```

Role installation requires `CREATEROLE`. Production runs
`migrate.js,--install-roles` as a separate job; the API starts with
`JINA_DB_MANAGE_SCHEMA=false`. The runtime login must be pre-created, must not own or alter
the schema, and is deliberately `NOINHERIT`. Adapters use `transactionAs`/`queryAs` to
execute `SET LOCAL ROLE` before accessing context tables. See
[DATA_MODELS.md](DATA_MODELS.md) for the capability-role list.

The production job uses the exact release API image and runs
`dist/product/migrate-all.js --install-roles`, applying runtime and product migrations
through one ledgered path. This is the only supported production migration path.

## Rollback

There is no compatibility or mixed-schema rollback. If post-deploy acceptance cannot be
fixed forward:

1. stop context intake and all context workers;
2. capture logs, failed task IDs, release/projection IDs, and the release SHA;
3. restore the matching primary backup into an isolated recovery instance and validate
   its schema, tenant inventory, ACLs, queue state, and timestamp;
4. deploy the complete prior image set as no-traffic recovery services configured only
   for those isolated database targets;
5. validate identity, ACL, board, context reads, and worker no-claim behavior through the
   recovery services;
6. shift traffic and enable the recovered worker only after validation, then reconcile
   any accepted writes before retrying deployment.

Never point old code at `jina_context`, run down-migrations, or delete the backup inside
the recovery window.

## Useful checks

```sh
gcloud run services list --project=jina-v2 --region=us-east1
gcloud run jobs executions list --project=jina-v2 --region=us-east1 --job=jina-acceptance
gcloud builds list --project=jina-v2 --region=us-east1
gcloud sql backups list --project=jina-463721 --instance=jina-db
```

Metrics, logs, alerts, and trace fields are documented in
[OBSERVABILITY.md](OBSERVABILITY.md).
