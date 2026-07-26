# Deployment

Cloud Build validates, builds, and deploys one coordinated release to
`jina-v2/us-central1`. API, worker, dashboard, and admin images are built from the same
exact source revision, receive the same unique Cloud Build release identity, and are
deployed to Cloud Run before production acceptance runs.

## Resources

- Artifact Registry: `us-central1-docker.pkg.dev/jina-v2/jina`
- Cloud Run services: `jina-api`, `jina-context-worker`, `jina-task-worker`,
  `jina-dashboard`, `jina-admin`
- Cloud Run jobs: `jina-context-migrate`, `jina-acceptance`
- Cloud SQL: `jina-463721:us-east1:jina-db`, database `jina`
- Runtime service account: `jina-runtime@jina-v2.iam.gserviceaccount.com`
- Build/deploy service account:
  `jina-cloud-build-deployer@jina-v2.iam.gserviceaccount.com`
- Pull-request validator: `jina-cloud-build-ci@jina-v2.iam.gserviceaccount.com`

No Google service-account key is stored in GitHub or the web applications.

## Runtime credentials and identity

The API mounts:

- `jina-shared-db-password` as `DB_PASS`;
- `jina-github-webhook-secret` as `GITHUB_WEBHOOK_SECRET`;
- `jina-internal-api-token` as `INTERNAL_API_TOKEN`;
- `jina-context-api-token` as `CONTEXT_API_TOKEN`.

The migration job separately mounts `jina-db-password` and connects as the schema-owning
`jina_app` login. API and workers mount `jina-shared-db-password` and connect as the
non-owning `jina_v2_app` runtime login. Do not swap or reuse these credentials.

`INTERNAL_API_TOKEN` authorizes board, worker, and administration traffic.
`CONTEXT_API_TOKEN` is deliberately narrower: it authorizes `/context/*`, `/mcp`, and
`/internal/context/access/sync`. It never removes the principal requirement.

Context HTTP and MCP reads require `x-jina-principal-id`. Shared-database clients also
send `x-jina-tenant-id`, and the API verifies the tenant/principal binding. Browser MCP
origins, when present, must exactly match `JINA_MCP_ALLOWED_ORIGINS`.

Dashboard/admin values are server-side Cloud Run environment variables and secrets:
`JINA_API_URL`, `INTERNAL_API_TOKEN`, `JINA_WEB_AUTH_USERNAME`,
`JINA_WEB_AUTH_PASSWORD`, `JINA_TENANT_ID`, and `JINA_WEB_PRINCIPAL_ID`. The coordinated
deployment binds both apps to the acceptance tenant/principal and mounts
`jina-dashboard-password` plus `jina-internal-api-token`. The admin may instead derive
`tenant:<JINA_TENANT_ID>` when only a tenant ID is configured. One principal binding is
required whenever the app has `INTERNAL_API_TOKEN`. Never use a `NEXT_PUBLIC_` prefix for
a credential.

## Worker configuration

The context service runs three one-concurrency instances with continuous CPU and:

```text
WORKER_TOPICS=run-ingest-evidence|run-derive-knowledge|run-index-context
CONTEXT_GITHUB_HISTORY_LIMIT=500
CONTEXT_GIT_HISTORY_LIMIT=5000
CONTEXT_MAX_FILE_BYTES=5242880
CONTEXT_MAX_SNAPSHOT_BYTES=25165824
CONTEXT_CODEX_PROVIDER=openrouter
CONTEXT_CODEX_MODEL=openai/gpt-5.4-mini
CONTEXT_CODEX_CONTEXT_TOKENS=16000
CONTEXT_CODEX_COMPACT_TOKENS=12000
DAYTONA_RUN_TIMEOUT_SECONDS=2400
```

It mounts read-only `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_CLONE_TOKEN`,
`DAYTONA_API_KEY`, and `OPENROUTER_API_KEY`. Ingestion mints a short-lived installation
token whenever a build carries `githubInstallationId`; `GITHUB_CLONE_TOKEN` is the
manual-build fallback. The task worker has one instance and handles
`run-review|run-research|run-publish|run-cleanup`.

Cloud Run CLI treats commas as environment separators, so deployed topic lists use pipes.
Local processes may use commas.

### Exact-commit and failure behavior

A build accepts an optional full `commitSha`; push-triggered builds carry the event head
SHA. The worker performs a full blob-filtered clone (no shallow depth), verifies, and
checks out that exact commit. It persists up to `CONTEXT_GIT_HISTORY_LIMIT` commits and
parents and paginates PR/issue observations up to `CONTEXT_GITHUB_HISTORY_LIMIT`. It
preserves every manifest entry when binary or oversized file bodies are omitted.

The checkpoint is `complete` only when Git history reaches its root, every optional
GitHub source reaches a final page, and no body is omitted. Reaching a configured bound,
receiving an optional GitHub 403/404, or omitting a body produces `partial`, with exact
counts/reasons/paths recorded in the observation frontier. Unverified commit identity or
an invalid tree still fails closed. Partial generations are usable, but queries disclose
`source-completeness:partial` in coverage.

`ingest-evidence` and baseline `index-context` are required. `derive-knowledge` is
optional for aggregate availability, uses one bounded repair, and can publish an enriched
successor. Worker writes are fenced by the current board lease.

Dense retrieval is disabled until its evaluation and approved embedding-provider gates
pass. The deterministic hierarchy adapter is active; PageIndex remains an optional,
unconfigured adapter until its long-document gate passes.

## CI and image build

Pull-request Cloud Build runs `cloudbuild.ci.yaml` with a validation-only service account.
The shared CI script runs:

```sh
bash scripts/check-context-cutover.sh
pnpm typecheck
pnpm lint
pnpm test
pnpm evaluate:context
pnpm audit --prod --audit-level=high
pnpm --filter @jina/dashboard build
pnpm --filter @jina/admin build
```

Database integration tests receive an ephemeral PostgreSQL 16 service through
`TEST_DATABASE_URL`.

The supported production path is `cloudbuild.yaml`, which builds all four images, deploys
all five services, and runs migration plus acceptance in one build. Start it from a clean
checkout of the audited SHA:

```sh
release_sha="$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
gcloud builds submit \
  --project=jina-v2 \
  --region=us-central1 \
  --config=cloudbuild.yaml \
  .
```

Record both `release_sha` and the returned Cloud Build ID. The build uses its unique ID
for the deployed API, worker, dashboard, and admin image tags, so every service resolves
to the exact artifact produced from that audited source. `latest` is also pushed for API
and worker convenience, but the deploy script does not select it. Do not use the
API/worker-only split build files for this coordinated context-engine cutover.

## Pre-deployment backup

The deploy script does not create the production backup. The release operator must do so
before the clean cutover:

```sh
gcloud sql backups create \
  --project=jina-463721 \
  --instance=jina-db \
  --description="before context-engine ${release_sha}"

gcloud sql backups list \
  --project=jina-463721 \
  --instance=jina-db \
  --limit=5
```

Record the backup ID, release SHA, repository/ref inventory, expected ACL principals, and
timestamp in the release evidence. Verify the backup reaches a successful state before
deployment.

## Deploy

The coordinated `cloudbuild.yaml` invocation above calls
`scripts/cloud-build-deploy.sh`, which:

1. deploys and executes `jina-context-migrate` with the migration-owner credential,
   including capability-role installation and runtime-login grants;
2. deploys `jina-api` with schema management disabled and checks `/health`;
3. deploys `jina-context-worker` and verifies the exact three topics;
4. removes the retired worker service after the replacement is healthy;
5. deploys `jina-task-worker` and verifies its topics;
6. deploys `jina-dashboard` and `jina-admin` using the exact images built in this release;
7. deploys and executes `jina-acceptance`;
8. fails the Cloud Build if migration, health, topic, or acceptance checks fail.

The migration installs `jina_context` and its capability roles from scratch with
`--install-roles`. It requires `CONTEXT_RUNTIME_DB_USER`, marks that login `NOINHERIT`,
and grants membership in the focused NOLOGIN roles. The migration login therefore needs
schema ownership and `CREATEROLE`; runtime services start with schema management disabled
and activate a capability per transaction with `SET LOCAL ROLE`. The migration does not
copy or translate prior semantic indexes. Active repositories must be reingested.

## Production acceptance

The 55-minute `jina-acceptance` job receives both service credentials from Secret Manager
and uses a 50-minute polling budget. Unless `ACCEPTANCE_REPOSITORY` and `ACCEPTANCE_REF`
override it, the job uses the existing external fixture
`omxyz/jina-context-graph-e2e@main`; that repository name is historical and is not a
runtime compatibility surface. Production also sets
`ACCEPTANCE_GITHUB_INSTALLATION_ID=140435029`, causing the build to exercise GitHub App
token minting instead of the fallback clone token. The job:

1. replaces the fixture principal's repository ACL;
2. starts `POST /context/build` with the configured GitHub installation ID;
3. waits for all three named stages and rejects failed/blocked work;
4. requires a published enriched generation at one full commit SHA;
5. requires a nonempty knowledge-document catalog;
6. calls `/context/query` and verifies original evidence anchors match the repository and
   commit;
7. connects with the real MCP SDK, asserts `query_context` is the only tool, calls it, and
   verifies the same commit and original citations;
8. requires zero context outbox backlog;
9. verifies the retired public route returns 404.

The job exits `20` for workflow failures, `21` for generation/commit failures, `22` for
knowledge availability, `23` for HTTP/MCP answer or citation failures, `24` for backlog,
and `25` for transport or unexpected failures. Inspect the job execution logs before
retrying with a new request key.

## Outbox recovery and rebuild

Outbox consumers own independent delivery rows and leases. If metrics show a backlog,
an internal operator can drain up to 100 pending checkpoints per call:

```sh
curl -X POST "${JINA_API_URL}/internal/context/outbox/drain" \
  -H "Authorization: Bearer ${INTERNAL_API_TOKEN}" \
  -H "X-Jina-Principal-Id: tenant:<uuid>" \
  -H "X-Jina-Tenant-Id: <uuid>" \
  -H "Content-Type: application/json" \
  --data '{"limit":20}'
```

The endpoint selects checkpoint IDs represented by pending evidence, knowledge, ACL, or
retention deliveries and re-runs idempotent `index-context`. Each projector claims and
acknowledges only its own unexpired delivery lease for the exact
tenant/repository/ref/commit scope. The response reports processed checkpoint IDs and the
remaining per-consumer backlog.

A tenant administrator can force a successor generation from the latest checkpoint:

```sh
curl -X POST "${JINA_API_URL}/context/rebuild" \
  -H "Authorization: Bearer ${INTERNAL_API_TOKEN}" \
  -H "X-Jina-Principal-Id: tenant:<uuid>" \
  -H "X-Jina-Tenant-Id: <uuid>" \
  -H "Content-Type: application/json" \
  --data '{"repository":"owner/repository","ref":"main"}'
```

Neither operation mutates canonical evidence or shares a global processed flag. If a
delivery lease is lost, its acknowledgement fails and the delivery remains retryable.

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

Install the pgvector extension/schema only when an approved embedding provider is ready
for evaluation:

```sh
DATABASE_URL=postgresql://... \
  pnpm --filter @jina/db migrate -- --install-pgvector
```

Schema availability alone does not enable dense retrieval.

## Rollback

There is no compatibility or mixed-schema rollback. If post-deploy acceptance cannot be
fixed forward:

1. stop context intake and all context workers;
2. capture logs, failed task IDs, generation IDs, and the release SHA;
3. redeploy the complete prior image set;
4. restore the matching pre-cutover backup into an isolated recovery target;
5. validate identity, ACL, board, and context reads before shifting traffic;
6. reconcile any accepted writes before attempting cutover again.

Never point old code at `jina_context`, run down-migrations, or delete the backup inside
the recovery window.

## Useful checks

```sh
gcloud run services list --project=jina-v2 --region=us-central1
gcloud run jobs executions list --project=jina-v2 --region=us-central1 --job=jina-acceptance
gcloud builds list --project=jina-v2 --region=us-central1
gcloud sql backups list --project=jina-463721 --instance=jina-db
```

Metrics, logs, alerts, and trace fields are documented in
[OBSERVABILITY.md](OBSERVABILITY.md).
