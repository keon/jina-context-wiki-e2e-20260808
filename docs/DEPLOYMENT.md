# Deployment

Cloud Build validates and deploys backend images to `jina-v2/us-central1`. Dashboard and
admin deploy through the Om Labs Vercel projects `jina-dashboard` and `jina-admin`; both
track `omxyz/jina`, use `apps/dashboard` or `apps/admin` as their root, and deploy
production from `main`.

## Resources

- Artifact Registry: `us-central1-docker.pkg.dev/jina-v2/jina`
- Cloud Run services: `jina-api`, `jina-context-worker`, `jina-task-worker`
- Cloud Run jobs: `jina-context-migrate`, `jina-acceptance`
- Cloud SQL: `jina-463721:us-east1:jina-db`, database `jina`
- Runtime service account: `jina-runtime@jina-v2.iam.gserviceaccount.com`
- Build/deploy service account:
  `jina-cloud-build-deployer@jina-v2.iam.gserviceaccount.com`
- Pull-request validator: `jina-cloud-build-ci@jina-v2.iam.gserviceaccount.com`

No Google service-account key is stored in GitHub or Vercel.

## Runtime credentials and identity

The API mounts:

- `jina-shared-db-password` as `DB_PASS`;
- `jina-github-webhook-secret` as `GITHUB_WEBHOOK_SECRET`;
- `jina-internal-api-token` as `INTERNAL_API_TOKEN`;
- `jina-context-api-token` as `CONTEXT_API_TOKEN`.

`INTERNAL_API_TOKEN` authorizes board, worker, and administration traffic.
`CONTEXT_API_TOKEN` is deliberately narrower: it authorizes `/context/*`, `/mcp`, and
`/internal/context/access/sync`. It never removes the principal requirement.

Context HTTP and MCP reads require `x-jina-principal-id`. Shared-database clients also
send `x-jina-tenant-id`, and the API verifies the tenant/principal binding. Browser MCP
origins, when present, must exactly match `JINA_MCP_ALLOWED_ORIGINS`.

Dashboard/admin values are server-side Vercel environment variables:
`JINA_API_URL`, `INTERNAL_API_TOKEN`, `JINA_WEB_AUTH_USERNAME`,
`JINA_WEB_AUTH_PASSWORD`, and the configured principal/allowlist. Never use a
`NEXT_PUBLIC_` prefix for a credential. Preview deployments intentionally have no
production API secret.

## Worker configuration

The context service runs three one-concurrency instances with continuous CPU and:

```text
WORKER_TOPICS=run-ingest-evidence|run-derive-knowledge|run-index-context
CONTEXT_GITHUB_HISTORY_LIMIT=500
CONTEXT_MAX_FILE_BYTES=5242880
CONTEXT_MAX_SNAPSHOT_BYTES=25165824
CONTEXT_CODEX_PROVIDER=openrouter
CONTEXT_CODEX_MODEL=openai/gpt-5.4-mini
CONTEXT_CODEX_CONTEXT_TOKENS=16000
CONTEXT_CODEX_COMPACT_TOKENS=12000
DAYTONA_RUN_TIMEOUT_SECONDS=2400
```

It mounts read-only `GITHUB_CLONE_TOKEN`, `DAYTONA_API_KEY`, and
`OPENROUTER_API_KEY`. The task worker has one instance and handles
`run-review|run-research|run-publish|run-cleanup`.

Cloud Run CLI treats commas as environment separators, so deployed topic lists use pipes.
Local processes may use commas.

### Exact-commit and failure behavior

A build accepts an optional full `commitSha`; push-triggered builds carry the event head
SHA. The worker clones, verifies, and checks out that exact commit. It paginates bounded
GitHub history, preserves the complete manifest when binary or oversized file bodies are
omitted, and fails closed when source completeness or ref identity cannot be established.

`ingest-evidence` and baseline `index-context` are required. `derive-knowledge` is
optional for aggregate availability, uses one bounded repair, and can publish an enriched
successor. Worker writes are fenced by the current board lease.

Dense retrieval is disabled until its evaluation and approved embedding-provider gates
pass. The deterministic hierarchy adapter is active; PageIndex remains an optional,
disabled adapter until its long-document gate passes.

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

Build immutable API and worker images with a commit SHA:

```sh
release_sha="$(git rev-parse HEAD)"
gcloud builds submit \
  --project=jina-v2 \
  --region=us-central1 \
  --config=cloudbuild.images.yaml \
  --substitutions="_IMAGE_TAG=${release_sha}" \
  .
```

Do not deploy a mutable `latest` tag for a release. The tag must identify the audited
source commit.

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

Deploy the images carrying the same audited SHA:

```sh
gcloud builds submit \
  --project=jina-v2 \
  --region=us-central1 \
  --config=cloudbuild.deploy.yaml \
  --substitutions="_IMAGE_TAG=${release_sha}" \
  .
```

`scripts/cloud-build-deploy.sh` then:

1. deploys and executes `jina-context-migrate`;
2. deploys `jina-api` with schema management disabled and checks `/health`;
3. deploys `jina-context-worker` and verifies the exact three topics;
4. removes the retired worker service after the replacement is healthy;
5. deploys `jina-task-worker` and verifies its topics;
6. deploys and executes `jina-acceptance`;
7. fails the Cloud Build if migration, health, topic, or acceptance checks fail.

The migration installs `jina_context` from scratch. It does not copy or translate prior
semantic indexes. Active repositories must be reingested.

## Production acceptance

The 55-minute `jina-acceptance` job receives both service credentials from Secret Manager
and uses a 50-minute polling budget. It:

1. replaces the fixture principal's repository ACL;
2. starts `POST /context/build`;
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

## Migrations and roles

For a local or administrative database:

```sh
DATABASE_URL=postgresql://... pnpm --filter @jina/db migrate
DATABASE_URL=postgresql://... pnpm --filter @jina/db migrate -- --install-roles
```

Role installation requires `CREATEROLE`. Production runs the migration as a separate job;
the API starts with `JINA_DB_MANAGE_SCHEMA=false`. Runtime logins must not own or alter
the schema. See [DATA_MODELS.md](DATA_MODELS.md) for the capability-role list.

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
