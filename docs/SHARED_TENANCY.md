# Shared identity with an isolated ContextGraph database

Jina v2 remains deployed in `jina-v2/us-central1` and uses a two-database
layout:

- Original identity and GitHub App data remain owned by the original service in
  `public` on `jina-463721:us-east1:jina-db`.
- Jina v2's lightweight runtime and board state remain in `jina_runtime` and
  `jina_board` on that original database.
- The graph store and graph pipeline coordinator own `jina_context_graph` on
  `jina-v2:us-central1:jina-postgres`.
- Webhooks resolve their tenant and GitHub account from each repository's exact
  `public.installations` row before creating work.
- Workers receive the resolved original tenant UUID with each task and send it on subsequent API calls.
- No Cloud Run service moves regions. Workers never receive a database credential.

The original application remains the single identity authority; there is no
second identity cache. The physical graph boundary isolates high-volume
ingestion, indexes, vacuum, and connection pressure from dashboard persistence.
Cross-region access remains only for identity and lightweight control-plane
state.

## Identity resolution and propagation

The original Jina webhook intake resolves an enabled repository to exactly one
original tenant using the GitHub repository ID, installation ID, and
`owner/repository` name. Resolution requires the repository's linked
installation to be active and to match the webhook installation exactly. This
allows one Jina tenant to contain repositories from multiple GitHub
organizations without confusing their credentials or provenance. After
accepting an automatic or `@usejina` review, it submits an idempotent v2 build
for the PR head with the original tenant UUID. V2 direct webhook intake is
disabled in production and never becomes a second source of review work.

The resolved values flow through the system as follows:

```text
public.tenants/repositories/installations
  -> original tenant UUID + GitHub account identity
  -> original Jina review intake
  -> tenant-scoped v2 graph build
  -> graph tasks, events, and outbox messages
  -> context graph observations and projections
  -> dashboard and original-app work overview
```

The Jina tenant name is the workspace label and billing boundary.
`githubAccountId` and `githubAccountType` identify the exact GitHub installation
that owns the repository; they do not define the tenant. Verified webhook
payload fields add `authorGithubUserId`, `authorLogin`, `authorAccountType`,
`senderGithubUserId`, `senderLogin`, and `senderAccountType`. The dashboard
displays and searches workspace and author labels. These are external identity
references and provenance, not duplicated user rows.

The global admin operations projection reads tenant name, kind, GitHub
connections, and enabled repository counts from these authoritative identity
tables. The admin UI never derives a Jina tenant name from a graph repository
owner, because a tenant can have no graphs or can span several GitHub
organizations.

Shared-mode workers claim across the active tenant UUIDs returned by the original tables. After a claim, every worker request carries the concrete tenant header; workers do not receive a database credential.

## Original application integration

The original application remains responsible for login, sessions, and tenant membership. Its member-only endpoint:

```text
GET /v1/dashboard/tenants/:tenantId/work-overview
```

authorizes the caller through the original application, then calls the v2 overview API with `x-jina-tenant-id: <tenantId>` and `x-jina-principal-id: tenant:<tenantId>`. This keeps the original user boundary in one place while returning the shared board and event history associated with that organization.

## Runtime configuration

The checked-in production substitutions select:

```text
CLOUD_SQL_INSTANCE=jina-463721:us-east1:jina-db
JINA_TENANCY_MODE=shared-db
JINA_DB_NAME=jina
JINA_DB_USER=jina_v2_app
JINA_DB_PASS_SECRET=jina-shared-db-password:latest
GRAPH_CLOUD_SQL_INSTANCE=jina-v2:us-central1:jina-postgres
JINA_GRAPH_DB_NAME=jina
JINA_GRAPH_DB_USER=jina_app
JINA_GRAPH_DB_PASS_SECRET=jina-db-password:latest
```

`JINA_TENANT_ID` must be unset in shared mode. The API attaches both Cloud SQL
instances and creates separate connection pools. Local environments may omit
all `GRAPH_*` variables to retain a single-database setup.

## One-time IAM

The v2 runtime needs Cloud SQL Client in the project that owns the database:

```sh
gcloud projects add-iam-policy-binding jina-463721 \
  --member='serviceAccount:jina-runtime@jina-v2.iam.gserviceaccount.com' \
  --role='roles/cloudsql.client'
```

Grant the v2 deployer read-only instance metadata access if Cloud Run deployment validation requires it:

```sh
gcloud projects add-iam-policy-binding jina-463721 \
  --member='serviceAccount:jina-cloud-build-deployer@jina-v2.iam.gserviceaccount.com' \
  --role='roles/cloudsql.viewer'
```

## Database role and schema boundary

Create `jina_v2_app` as a separate login on the original database. It may read
the original identity tables and own only `jina_runtime` and `jina_board`; it
must not read session/OAuth secret tables, mutate original application tables,
or own ContextGraph data. The dedicated graph database uses `jina_app` (or the
least-privilege ContextGraph roles) and a separate secret.

Prefer creating this PostgreSQL role with SQL. Cloud SQL's `gcloud sql users create` grants `cloudsqlsuperuser` membership to PostgreSQL users; if that command is used, revoke that membership before using the role:

```sql
revoke cloudsqlsuperuser from jina_v2_app;
```

Run as a database administrator, substituting a generated password stored out of band:

```sql
create role jina_v2_app login password 'generated-password';
grant connect on database jina to jina_v2_app;

create schema if not exists jina_runtime authorization jina_v2_app;
create schema if not exists jina_board authorization jina_v2_app;

grant usage on schema public to jina_v2_app;
grant select on table
  public.tenants,
  public.tenant_members,
  public.installations,
  public.repositories
to jina_v2_app;
```

Do not grant writes on `public`, broad `SELECT ON ALL TABLES`, or access to `dashboard_sessions` and integration credential tables. The identity adapter also sets its own pool to read-only transactions as defense in depth.

Store the same generated password in `jina-v2` Secret Manager:

```sh
gcloud secrets create jina-shared-db-password --project=jina-v2 --replication-policy=automatic
read -rs JINA_V2_DB_PASSWORD
printf '%s' "${JINA_V2_DB_PASSWORD}" | gcloud secrets versions add jina-shared-db-password \
  --project=jina-v2 --data-file=-
unset JINA_V2_DB_PASSWORD
gcloud secrets add-iam-policy-binding jina-shared-db-password \
  --project=jina-v2 \
  --member='serviceAccount:jina-runtime@jina-v2.iam.gserviceaccount.com' \
  --role='roles/secretmanager.secretAccessor'
```

## ContextGraph database cutover

Treat the graph move as a data migration, not an application redeploy side
effect.

Before deployment:

1. Run the full database test suite against disposable PostgreSQL 16 and 17
   instances.
2. Build and push the release images before pausing graph writes.
3. Pause graph build intake and all ContextGraph workers, then wait for
   `jina_context_graph` to stop changing. Original login, dashboard, and review
   traffic can remain online.
4. Export the complete `jina_context_graph` schema and data from the original
   database. Do not export `public`, `jina_runtime`, or `jina_board`.
5. Replace only `jina_context_graph` on the dedicated database, set its ownership
   to the graph migration owner, and run the current `@jina/db` migration.
6. Compare every source/target graph table count and sample tenant, repository,
   build, graph-head, ACL, and outbox rows.
7. Deploy the already-built images with both checked-in database substitutions.
   Verify `/health`, one original-app graph build, a worker claim/completion,
   tenant-scoped graph reads, and a graph query before resuming graph intake.
8. Keep the source graph schema intact but read-only during the rollback window.
   After the window, revoke `jina_v2_app` access to it so configuration drift
   cannot silently move graph traffic back to the dashboard database.

## Verification

Verify configuration and health without printing credentials:

```sh
gcloud run services describe jina-api \
  --project=jina-v2 --region=us-central1 --format=json \
  | jq '{revision:.status.latestReadyRevisionName, cloudSql:.spec.template.metadata.annotations["run.googleapis.com/cloudsql-instances"]}'

curl --fail https://jina-api-m56inn6iva-uc.a.run.app/health
curl --fail https://api.usejina.com/v1/healthz
```

Confirm that the Cloud Run annotation contains both connection names. For an
authenticated tenant read, send the internal credential server-side and use the
original UUID for both tenant scope and tenant principal. Confirm that a known
PR task contains the expected `workspaceLabel`, `authorLogin`, `senderLogin`,
GitHub account ID, and author GitHub user ID. The original work-overview
endpoint must return `401` without an original-app session.

## Rollback

Redeploy the same image with the graph connection pointed back at the retained
source schema:

```sh
gcloud builds submit \
  --project=jina-v2 \
  --region=us-central1 \
  --config=cloudbuild.deploy.yaml \
  --substitutions=_IMAGE_TAG=KNOWN_GOOD_TAG,_GRAPH_CLOUD_SQL_INSTANCE=jina-463721:us-east1:jina-db,_JINA_GRAPH_DB_NAME=jina,_JINA_GRAPH_DB_USER=jina_v2_app,_JINA_GRAPH_DB_PASS_SECRET=jina-shared-db-password:latest
```

Do not delete either database or run down-migrations as part of rollback. Reconcile any writes accepted after cutover before attempting another migration.
