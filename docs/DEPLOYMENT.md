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
- Primary Cloud SQL: `jina-463721:us-east1:jina-db`, database `jina`
- Retired graph Cloud SQL (cutover audit/rollback only):
  `jina-v2:us-central1:jina-postgres`, database `jina`
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

The migration job runs as `jina-migration`, mounts
`jina-primary-owner-db-password`, and connects to the primary database as the
schema-owning `jina_app` login. The one-shot preflight uses the same non-serving Google
identity but mounts separate `jina-primary-cutover-auditor-db-password` and
`jina-legacy-cutover-auditor-db-password` secrets. Both databases expose a
`jina_cutover_auditor` login with only the exact `SELECT` grants required by preflight.
The retired graph owner's `jina-db-password` is never used against the primary database.

API and workers run as `jina-runtime`, mount `jina-shared-db-password`, and connect as
the non-owning `jina_v2_app` runtime login. The runtime Google service account must not
have Secret Manager access to any owner or cutover-auditor secret; the migration Google
service account must not be assigned to a network-facing service. Do not swap or reuse
these identities or credentials.

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
`Permission denied on secret: ... for Revision service account ...` from
`gcloud run services update-traffic`. Because the migration has already run by that point,
the traffic restore leaves the prior release serving a forward-migrated database, so
recover by fixing the binding and rolling forward rather than by retrying the rollback.

`INTERNAL_API_TOKEN` authorizes board, worker, and administration traffic. It is also the
only service credential accepted by `POST /internal/context/access/sync`.
`CONTEXT_API_TOKEN` is deliberately narrower: it is accepted only by
`POST /context/query`, `POST /mcp`, and the read-only context projections
`GET /context/generations`, `GET /context/documents`, `GET /context/structure`, and a
single generation or document by id. Answering a question is not useful without the reads
that let a caller find what to ask about, and those reads carry the same protection as the
query route: the credential is bound server-side to one tenant and principal, and every
route is repository-filtered by that principal's access. Writes, administration, board
traffic, and metrics stay with `INTERNAL_API_TOKEN`, and the method is checked so a write
cannot reach a read path.

Per-principal tokens are issued rather than configured. A token is
`jina_atk_<43 chars base64url>`, stored only as a SHA-256 hash in
`jina_context.api_tokens`, and verified on every request by the `jina_context_tokens`
capability role — the one role in this schema that reads across tenants, because
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

Public `POST /context/query` and `POST /mcp` bodies are capped at 128 KiB. Every raw
target category accepts at most 100 array entries before deduplication. Values are
trimmed, empty strings dropped, accepted values deduplicated, and each non-empty value is
limited to 1,000 characters. A request containing 101 duplicates is intentionally
rejected as amplification rather than reduced below the raw-entry limit.

| Cloud Build substitution      | Default | Guidance                                                                     |
| ----------------------------- | ------: | ---------------------------------------------------------------------------- |
| `_JINA_API_MIN_INSTANCES`     |     `1` | Keep at least one warm for interactive reads.                                |
| `_JINA_API_MAX_INSTANCES`     |     `1` | Raise only after enforcing one aggregate budget across all PostgreSQL pools. |
| `_JINA_API_CONCURRENCY`       |    `10` | Production currently overrides this to `4` to bound per-instance contention. |
| `_JINA_API_CPU`               |     `1` | Production currently overrides this to `2`.                                  |
| `_JINA_API_MEMORY`            |   `1Gi` | Production currently overrides this to `2Gi`.                                |
| `_JINA_CONTEXT_WORKER_MEMORY` |   `1Gi` | Memory reserved for repository cloning, evidence parsing, and derivation.    |
| `_JINA_CONTEXT_CUTOVER`       | `false` | Set to `true` only for the first destructive graph-to-context release.       |

The shipped production API uses 2 vCPU, 2 GiB memory, concurrency 4, one warm/maximum
instance, and a 3,600-second Cloud Run request timeout. Its context, state, and shared
identity PostgreSQL pools have configured maxima totaling 18 connections, so increasing
API instances without first imposing a shared pool budget can exhaust the database even
at low request concurrency.

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
JINA_REQUIRE_GITHUB_INSTALLATION=false
CONTEXT_GITHUB_HISTORY_LIMIT=500
CONTEXT_GIT_HISTORY_LIMIT=5000
CONTEXT_MAX_FILE_BYTES=5242880
CONTEXT_MAX_SNAPSHOT_BYTES=8388608
CONTEXT_CODEX_PROVIDER=openrouter
CONTEXT_CODEX_MODEL=openai/gpt-5.4-mini
CONTEXT_CODEX_EFFORT=medium
CONTEXT_CODEX_CONTEXT_TOKENS=16000
CONTEXT_CODEX_COMPACT_TOKENS=12000
CONTEXT_AGENT_ARCHIVE_MAX_BYTES=134217728
DAYTONA_RUN_TIMEOUT_SECONDS=2400
```

The context window governs how long one derivation runs, and the required
`derive-knowledge` stage fails if it overruns `DAYTONA_RUN_TIMEOUT_SECONDS`. A 64k
window overran the 2400-second ceiling on the acceptance repository and failed
every release; 16k completes the same stage in under two minutes. Override with
`JINA_CONTEXT_CODEX_CONTEXT_TOKENS` and `JINA_CONTEXT_CODEX_COMPACT_TOKENS`, and
raise them only together with the Daytona ceiling.

Keep `CONTEXT_CODEX_EXECUTION_ATTEMPTS` (default 2) multiplied by
`DAYTONA_RUN_TIMEOUT_SECONDS` below the `deploy-backend` step timeout in
`cloudbuild.yaml`, currently 4200 seconds. At the default ceiling two attempts
reach 4800 seconds, so one retry outlives the build waiting on it.

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
`CONTEXT_GIT_HISTORY_LIMIT` commits and parents, materializes up to 500 recent commits for
derivation, and includes changed paths on the checkpoint commit. It paginates repository
metadata, PRs, issues, issue comments, PR review comments, and commit discussion comments
up to `CONTEXT_GITHUB_HISTORY_LIMIT`. It preserves every manifest entry when binary or
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

`ingest-evidence`, baseline `index-context`, and `derive-knowledge` are required. The
coordinator queues only ingestion, then baseline indexing, then derivation; baseline
completion is the gate that queues derivation. This prevents distinct workers from
racing knowledge projection-input changes against baseline materialization. Invalid
derivation output receives one bounded repair. A failed repair or executor fails the
root build; the baseline remains available only for diagnosis/retry. Successful
derivation publishes the required enriched successor. The worker fetches the exact
checkpoint SHA, creates a bounded Git archive, and supplies Codex a read-only repository,
immutable evidence catalog, exact manifest, and eligible prior knowledge. Codex ignores
user configuration and repository instructions. Its shell is read-only and has no login
shell, inherited environment, repository credential, or network. Shell snapshots,
unified execution, multi-agent, apps, plugins, remote plugins, hooks, browser/in-app
browser, computer use, image generation, the code-mode host, workspace dependencies,
skill MCP dependency installation, and web search are disabled.

The result must match `knowledge-documents-v4`. Full initialization organizes a supported
knowledge catalog; incremental commit/PR/issue builds must re-emit every still-valid prior
logical document or explicitly retire it. The host validates body markers, structured
facts/questions/diagnostics, citation ordinals, exact claim excerpts, identities, and
scope. Only revisions whose every citation identity/digest is present in the exact
generation checkpoint are selectable; matching ref+commit history is not enough.
Equivalent-evidence derivation cache reuse remains safe because indexing performs that
checkpoint-membership check. One invalid result receives one repair; a second invalid
result fails closed. Worker writes are fenced by the current board lease.

The API Cloud Run request timeout is 60 minutes. The context worker operation client
allows 62 minutes and terminal completion has a separate 10-minute deadline. The
context-only lease is 75 minutes, exceeding both worker deadlines combined; deployment
validation rejects inconsistent values. Ordinary task timing is unchanged.

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
API/worker-only split build files for this coordinated context-engine cutover:
`cloudbuild.deploy.yaml` hard-codes `JINA_CONTEXT_CUTOVER=false`, and destructive mode
rejects any image tag other than the current full-build `$BUILD_ID`.

## Pre-deployment backup

The deploy script does not create production backups. The release operator must back up
both the identity/runtime database and the separate retired graph database before the
clean cutover:

```sh
gcloud sql backups create \
  --project=jina-463721 \
  --instance=jina-db \
  --description="pre-context-engine-primary-${release_sha}"

gcloud sql backups list \
  --project=jina-463721 \
  --instance=jina-db \
  --limit=5

gcloud sql backups create \
  --project=jina-v2 \
  --instance=jina-postgres \
  --description="pre-context-engine-legacy-graph-${release_sha}"

gcloud sql backups list \
  --project=jina-v2 \
  --instance=jina-postgres \
  --limit=5
```

Record both backup IDs, release SHA, repository/ref inventory, expected ACL principals,
and timestamp in the release evidence. Verify both backups reach a successful state
before deployment. The first destructive attempt requires both backups to have completed
within six hours. A retry after either legacy service has already been removed reuses the
same successful backup IDs and exact SHA-bound descriptions; do not take a replacement
"pre-cutover" backup from partially migrated state.

The first destructive release must run from the connected repository so Cloud Build
provides an authoritative `COMMIT_SHA`. Create a manual-only release trigger once:

```sh
gcloud builds triggers create github \
  --name=jina-context-release \
  --project=jina-v2 \
  --region=us-central1 \
  --repository=projects/jina-v2/locations/us-central1/connections/jina-github/repositories/jina \
  --branch-pattern='^__manual_context_release__$' \
  --build-config=cloudbuild.yaml \
  --service-account=projects/jina-v2/serviceAccounts/jina-cloud-build-deployer@jina-v2.iam.gserviceaccount.com
```

Run that trigger at the exact pushed SHA with both verified backup IDs and the complete
active-tenant inventory:

```sh
gcloud builds triggers run jina-context-release \
  --project=jina-v2 \
  --region=us-central1 \
  --sha="${release_sha}" \
  --substitutions="^~^_JINA_CONTEXT_CUTOVER=true~_JINA_CONTEXT_CUTOVER_BACKUP_ID=${primary_backup_id}~_JINA_CONTEXT_CUTOVER_LEGACY_BACKUP_ID=${legacy_graph_backup_id}~_JINA_LEGACY_CUTOVER_TENANT_IDS=${tenant_ids_pipe_delimited}~_JINA_RELEASE_SHA=${release_sha}"
```

When either retired service exists, normal deployment fails closed. Destructive mode
always requires and revalidates the source-bound SHA, current-build image tag, both
backups, fixed trusted production database identities, and tenant inventory, including
on a retry after the old services were already removed. Before first shutdown it also
requires the trusted graph connection and owner-secret reference to match the deployed
legacy API. It verifies both Cloud SQL backups are `SUCCESSFUL`, deletes the old graph
worker and old API, and verifies both services are absent. If both APIs are absent, a
normal deployment is rejected: an interrupted first cutover must resume in destructive
mode until the new context-engine API exists.

With all legacy claims and intake durably fenced,
`jina-context-cutover-preflight` runs as the non-serving `jina-migration` identity. It
uses dedicated SELECT-only database logins to read `jina_runtime.api_state` and the
active shared-tenant identity tables from the primary database, then directly audits
`jina_board.workflows`, `jina_board.tasks`, and `jina_context_graph.outbox` in the
separate retired graph database. It fails if an expected relation is missing, a workflow
or task is nonterminal, any lease metadata remains, any projection outbox row is
unprocessed, or the declared inventory differs from the authoritative active shared
tenants. Cloud Build also compares the submitted release SHA with its resolved repository
source provenance. Only then does migration start. Deleting the old API closes both
explicit graph-build and webhook intake during the incompatible schema boundary, and
auditing afterward avoids a preflight-to-shutdown race. Subsequent context-engine releases leave
`_JINA_CONTEXT_CUTOVER=false`; destructive mode also refuses to run when a context-engine
API already exists.

Both supplied backups must be `SUCCESSFUL`, must have completed within the prior six
hours, and must use the exact descriptions
`pre-context-engine-primary-${release_sha}` and
`pre-context-engine-legacy-graph-${release_sha}`. A successful but stale or
differently labeled backup is rejected.

The tenant list does not infer repository/ref scope. The separately recorded
repository/ref/install inventory remains the authority for the mandatory post-deploy
full reingestion, and every inventory row must end with a published baseline generation.

## Deploy

The coordinated `cloudbuild.yaml` invocation above calls
`scripts/cloud-build-deploy.sh`, which:

1. on the first destructive release, binds the release SHA to Cloud Build source,
   verifies both backups and the authoritative tenant/database inventory, removes the old
   worker and API, then rejects nonterminal or leased SQL graph work and unprocessed graph
   outbox rows before migration;
2. deploys and executes `jina-context-migrate` as the dedicated `jina-migration` Google
   service account with the migration-owner credential, including capability-role
   installation and runtime-login grants;
3. for an ordinary non-destructive release, snapshots the exact serving traffic
   assignments for all five services and creates each new revision with `--no-traffic`;
4. routes the ready `jina-api` revision, with schema management disabled, and checks
   `/health`;
5. routes `jina-context-worker` and verifies the exact three topics;
6. routes `jina-task-worker`, `jina-dashboard`, and `jina-admin` using the exact images
   built in this release and verifies the worker topics;
7. deploys and executes `jina-acceptance`;
8. fails the Cloud Build if preflight, migration, health, topic, or acceptance checks
   fail. For an ordinary release, the exit trap restores every captured traffic
   assignment before the build reports failure.

This traffic restoration protects a routine forward-compatible application release; it
is not a schema down-migration or a compatibility promise. The first destructive
graph-to-context cutover deliberately follows the isolated recovery procedure below
instead.

Restoration is therefore skipped once the migration has advanced the schema. Past that
point the previous revision predates the schema it would have to serve, so restoring it
reports `ok=false` and Cloud Run kills the instances on liveness — an outage caused by the
recovery rather than by the failure. A release that fails after the migration leaves the
traffic assignments alone and prints the roll-forward command instead. Recovery is to route
traffic to the newest ready revision, resolve the failure, and re-run the release:

```bash
gcloud run services update-traffic jina-api \
  --project=jina-v2 --region=us-central1 \
  --to-revisions=<newest-ready-revision>=100
```

A failure before the migration still restores every captured assignment, because the
previous revision can serve that schema.

The migration installs `jina_context` and its capability roles from scratch with
`--install-roles`. It requires `CONTEXT_RUNTIME_DB_USER`, ensures that login is
`NOINHERIT` and outside `cloudsqlsuperuser`, revokes any `jina_context_admin`
membership, and grants the remaining focused NOLOGIN roles. Tenant administration uses
`jina_context_tenant_admin`, whose RLS never accepts the wildcard system scope. The
migration login therefore needs schema ownership and `CREATEROLE`; runtime services
start with schema management disabled and activate a capability per transaction with
`SET LOCAL ROLE`. The migration does not copy or translate prior semantic indexes.
Active repositories must be reingested.

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
gcloud secrets get-iam-policy jina-primary-cutover-auditor-db-password --project=jina-v2
gcloud secrets get-iam-policy jina-legacy-cutover-auditor-db-password --project=jina-v2
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

The primary Cloud SQL instance is in the separate `jina-463721` project, while the
retired graph instance is in `jina-v2`. The migration Google service account requires
`roles/cloudsql.client` in both projects. The deployer requires
`roles/cloudsql.viewer` in both projects to verify both backup IDs. The migration-owner
and cutover-auditor password secrets remain in `jina-v2` and grant direct secret access
only to `jina-migration`. Project-level Cloud SQL IAM does not imply secret access, and
secret access does not imply Cloud SQL connectivity. The exact commands and
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
3. waits through the strict three-stage order, where baseline indexing gates required
   agentic derivation and enriched indexing, and rejects failed/blocked work;
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

For release-candidate quality checks beyond the deployment smoke query, run the checked-in
fixture evaluator and the real-question corpus evaluator:

```sh
pnpm evaluate:context

JINA_API_URL="${JINA_API_URL}" \
JINA_CONTEXT_REPOSITORY=owner/repository \
JINA_CONTEXT_REF=main \
CONTEXT_QUESTION_FILE=/absolute/path/questions.md \
CONTEXT_API_TOKEN='<bound context query token>' \
CONTEXT_QUESTION_MIN_ANSWERED_RATE=0.8 \
pnpm evaluate:questions > /tmp/context-question-report.json
```

The question file uses Markdown headings plus bullet questions. The JSON report records
every answered/partial/unanswered/error result, original citation source IDs, coverage
gaps, retrievers, trace ID, and latency. Do not put the report or a query token in
repository source. See [AGENTIC_DERIVATION.md](AGENTIC_DERIVATION.md) and
[CONTEXT_ENGINE_EVALUATION.md](CONTEXT_ENGINE_EVALUATION.md).

Release evidence also records the build ID, stage IDs, repository/ref/commit,
`refSequence`, generation ID and projection-input fingerprint, document/citation counts,
duration, outbox depth, both backup IDs, immutable image/source SHA, deployed service accounts,
and owner-secret IAM inspection.

### Current accepted release

Source `050623ce17df30caf14fbc5e798baea6ff3fee30` was deployed by Cloud Build
`b1e03ff3-89ba-44f5-8e7a-a775aaf4a9e6` to API revision
`jina-api-00021-pps` and context-worker revision
`jina-context-worker-00020-tzl`. Production acceptance passed with 7 indexed documents,
16 verified HTTP citations, and 16 verified MCP citations.

An isolated larger PostgreSQL candidate in `us-central1` completed the Alliance
repository's exact-release build in 3 minutes 54 seconds with 2 documents and 16 HTTP
plus 16 MCP citations.

On 2026-07-27, a two-query concurrency audit exposed the production connection-budget
limit: up to three API instances, each owning three pools with maxima totaling 18
connections, exhausted the 25-connection `db-f1-micro` instance. The audit was stopped,
an on-demand backup was taken, API scale was capped at one, and the shared database
`jina-463721:us-east1:jina-db` was resized in place to `db-custom-1-3840`. PostgreSQL now
reports `max_connections=100`. Traffic was moved to recovery revision
`jina-api-conn-drain`; six consecutive database-backed health checks passed, subsequent
worker claims returned 204, and the legacy application remained healthy. The database
was resized but not migrated to another region or instance.

The same recovery review enabled automated backups at 08:00 UTC with seven retained
backups and enabled point-in-time recovery with seven days of transaction logs. The
`jina_app` database password was rotated after an audit transcript exposed the previous
credential. Legacy API revision `jina-code-review-api-00107-zmk` serves 100% of traffic
using `jina-database-url` version 8; every older version is disabled. A direct connection
through the Cloud SQL Auth Proxy verified version 8 as `jina_app` against the `jina`
database after the rotation.

The legacy code-review application remains deployed for its dashboard, OAuth, webhook,
and review responsibilities, but its stale `JINA_GRAPH_API_URL` and
`JINA_GRAPH_API_TOKEN` settings are removed. The old
`/internal/graph/mcp-access` bridge is intentionally retired; restoring it or routing it
to a compatibility graph API would violate the clean cutover. New consumers use `/mcp`
and `query_context` with a bound tenant and principal.

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
3. restore the matching primary and graph backups into separate isolated recovery
   instances and validate their schemas, tenant inventory, ACLs, queue state, and
   timestamps;
4. deploy the complete prior image set as no-traffic recovery services configured only
   for those isolated database targets;
5. validate identity, ACL, board, graph reads, and worker no-claim behavior through the
   recovery services;
6. shift traffic and enable the recovered worker only after validation, then reconcile
   any accepted writes before attempting cutover again.

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
