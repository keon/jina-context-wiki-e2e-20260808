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
- Migration-only service account: `jina-migration@jina-v2.iam.gserviceaccount.com`
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

The migration job runs as `jina-migration`, separately mounts `jina-db-password`, and
connects as the schema-owning `jina_app` login. API and workers run as `jina-runtime`,
mount `jina-shared-db-password`, and connect as the non-owning `jina_v2_app` runtime
login. The runtime Google service account must not have Secret Manager access to
`jina-db-password`; the migration Google service account must not be assigned to any
network-facing service. Do not swap or reuse these identities or credentials.

`INTERNAL_API_TOKEN` authorizes board, worker, and administration traffic. It is also the
only service credential accepted by `POST /internal/context/access/sync`.
`CONTEXT_API_TOKEN` is deliberately narrower: it is accepted only by
`POST /context/query` and `POST /mcp`.

Every production API revision with a context credential must also set
`JINA_CONTEXT_TENANT_ID` and `JINA_CONTEXT_PRINCIPAL_ID`. Those values
server-side bind the bearer to one query identity; tenant/principal headers may be omitted
or repeat the configured values but cannot select different ones. Internal-token callers
send `x-jina-principal-id`; shared-database callers also send `x-jina-tenant-id`. Browser
MCP origins, when present, must exactly match `JINA_MCP_ALLOWED_ORIGINS`.

Public `POST /context/query` and `POST /mcp` bodies are capped at 128 KiB. Every raw
target category accepts at most 100 array entries before deduplication. Values are
trimmed, empty strings dropped, accepted values deduplicated, and each non-empty value is
limited to 1,000 characters. A request containing 101 duplicates is intentionally
rejected as amplification rather than reduced below the raw-entry limit.

Dashboard/admin values are server-side Cloud Run environment variables and secrets:
`JINA_API_URL`, `INTERNAL_API_TOKEN`, `JINA_WEB_AUTH_USERNAME`,
`JINA_WEB_AUTH_PASSWORD`, `JINA_TENANT_ID`, and `JINA_WEB_PRINCIPAL_ID`. The coordinated
deployment binds both apps to the acceptance tenant/principal and mounts
`jina-web-auth-password` plus `jina-internal-api-token`. The admin may instead derive
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

### Authoritative remote head and failure behavior

A build accepts an optional full `commitSha`; push-triggered builds carry the event head
SHA. The worker performs a full blob-filtered clone (no shallow depth), explicitly fetches
the branch to `refs/remotes/origin/<ref>`, resolves the fetched remote head, and checks it
out detached. The optional SHA is an expected-head fence, not permission to index a
historical commit as current: a mismatch means the ref moved and fails ingestion. A
manual build without `commitSha` selects the fetched head. The worker persists up to
`CONTEXT_GIT_HISTORY_LIMIT` commits and parents and paginates PR/issue observations up to
`CONTEXT_GITHUB_HISTORY_LIMIT`. It preserves every manifest entry when binary or
oversized file bodies are omitted.

The checkpoint is `complete` only when Git history reaches its root, every optional
GitHub source reaches a final page, and no body is omitted. Reaching a configured bound,
receiving an optional GitHub 403/404, or omitting a body produces `partial`, with exact
counts/reasons/paths recorded in the observation frontier. Unverified commit identity or
an invalid tree still fails closed. Partial generations are usable, but queries disclose
`source-completeness:partial` in coverage.

At request admission, the API allocates a monotonic `refSequence` for the exact
tenant/repository/ref under the same advisory lock used by ref-sensitive canonical
writes, and records it on the build and ingest stage. The checkpoint retains that
sequence. If an earlier accepted push finishes after a later accepted push, the earlier
checkpoint remains stored for audit but cannot advance the projection-input frontier,
commit derived knowledge, become current, or publish a generation over the higher
admitted sequence. Request-key redelivery reuses the existing build and sequence.

`ingest-evidence` and baseline `index-context` are required. The coordinator queues only
ingestion, then baseline indexing, then optional `derive-knowledge`; baseline completion
is the gate that queues derivation. This prevents distinct workers from racing knowledge
projection-input changes against baseline materialization. Derivation uses one bounded
repair and can publish an enriched successor. Codex derivation ignores user configuration and disables shell, shell
snapshots, unified execution, multi-agent, apps, plugins, remote plugins, hooks,
browser/in-app browser, computer use, image generation, the code-mode host, workspace
dependencies, skill MCP dependency installation, and web search; exact claim grounding
and scope validation occur host-side against the exact selected citation excerpts and
intrinsic source identities. Only revisions whose every citation identity/digest is
present in the exact generation checkpoint are selectable; matching ref+commit history is
not enough. Equivalent-evidence derivation cache reuse remains safe because indexing
performs that checkpoint-membership check. Worker writes are fenced by the current board
lease.

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

The release race gate is mandatory and must not be skipped. `pnpm test` plus retained
release evidence must cover, in both the memory contract and real PostgreSQL where
applicable:

- monotonic per-ref build allocation and delayed completion of a lower-sequence push;
- rejection of a superseded checkpoint at generation creation/publication;
- an erasure committed while projectors are materializing;
- projection-input frontier changes before final publication;
- invalidation/rebuild behavior for erasure and terminal knowledge revision events; and
- repository-access mutation during ACL projection/publication.

All cases must prove that no stale generation is published or remains query-visible.

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

1. deploys and executes `jina-context-migrate` as the dedicated `jina-migration` Google
   service account with the migration-owner credential, including capability-role
   installation and runtime-login grants;
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

Before approving a release, inspect IAM and the deployed identities:

```sh
gcloud secrets get-iam-policy jina-db-password --project=jina-v2
gcloud run jobs describe jina-context-migrate \
  --project=jina-v2 --region=us-central1 \
  --format='value(spec.template.spec.template.spec.serviceAccountName)'
gcloud run services list \
  --project=jina-v2 --region=us-central1 \
  --format='table(metadata.name,spec.template.spec.serviceAccountName)'
```

The migration job must report `jina-migration@jina-v2.iam.gserviceaccount.com`; every
network-facing Jina service must report `jina-runtime@jina-v2.iam.gserviceaccount.com`.
The owner-secret policy must grant the migration identity and must not grant the runtime
identity, broad project members, or `allUsers`/`allAuthenticatedUsers`. Failing any of
these checks blocks deployment.

Cloud SQL is in the separate `jina-463721` project. Both the runtime and migration Google
service accounts therefore require `roles/cloudsql.client` in that database-owning
project, while the deployer requires `roles/cloudsql.viewer` there to inspect the
instance. The migration owner's password secret remains in `jina-v2` and grants direct
secret access only to `jina-migration`. Project-level Cloud SQL IAM does not imply secret
access, and secret access does not imply Cloud SQL connectivity. The exact commands and
database-role boundary are in [SHARED_TENANCY.md](SHARED_TENANCY.md).

## Production acceptance

The 55-minute `jina-acceptance` job receives both service credentials from Secret Manager
and uses a 50-minute polling budget. Unless `ACCEPTANCE_REPOSITORY` and `ACCEPTANCE_REF`
override it, the job uses the existing external fixture
`omxyz/jina-context-graph-e2e@main`; that repository name is historical and is not a
runtime compatibility surface. Production also sets
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
job: ACCEPTANCE_GITHUB_INSTALLATION_ID=<fixture installation>
job: ACCEPTANCE_REQUEST_KEY=deploy-<Cloud Build ID>
job: ACCEPTANCE_TIMEOUT_MS=3000000
```

`ACCEPTANCE_PRINCIPAL_ID` must not be a tenant administrator. The administrator may use
the internal credential but must not be substituted for the context-bearer identity; this
ensures production acceptance exercises ordinary query authorization.

1. uses the internal credential and `mode:"merge"` to add the fixture repository to the
   query principal's ACL without replacing unrelated repositories;
2. uses the distinct administrator to start `POST /context/build` with the configured
   GitHub installation ID;
3. waits through the strict three-stage order, where baseline indexing gates derivation,
   and rejects failed/blocked work;
4. requires a published enriched generation at one full commit SHA;
5. uses the administrator to require a nonempty knowledge-document catalog;
6. uses only the bound non-admin context bearer to call `/context/query` and verifies
   original evidence anchors match the repository and commit;
7. uses the same bound non-admin bearer with the real MCP SDK, asserts `query_context` is
   the only tool, calls it, and verifies the same commit and original citations;
8. uses the administrator to require zero context outbox backlog;
9. verifies the retired public route returns 404.

The job exits `20` for workflow failures, `21` for generation/commit failures, `22` for
knowledge availability, `23` for HTTP/MCP answer or citation failures, `24` for backlog,
and `25` for transport or unexpected failures. Inspect the job execution logs before
retrying with a new request key.

Release evidence also records the build ID, stage IDs, repository/ref/commit,
`refSequence`, generation ID and projection-input fingerprint, document/citation counts,
duration, outbox depth, backup ID, immutable image/source SHA, deployed service accounts,
and owner-secret IAM inspection.

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

Before selecting checkpoints, the store terminally completes pending evidence and
knowledge deliveries whose source sequence is below a newer admitted or committed
sequence for the same ref. They are recorded with
`superseded by a newer admitted ref sequence` and no longer count toward backlog. This
does not wait for the newer build to finish ingestion or publish, so a failed newer build
cannot strand obsolete older deliveries.

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
