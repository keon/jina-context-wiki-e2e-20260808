# Shared original Jina database

Jina v2 remains deployed in `jina-v2/us-central1` and connects directly to the original PostgreSQL database at `jina-463721:us-east1:jina-db`. This is a single-database layout:

- Original identity and GitHub App data remain owned by the original service in `public`.
- Jina v2 owns only `jina_runtime`, `jina_board`, and `jina_context_graph`.
- Webhooks resolve their tenant from `public.repositories`, `public.installations`, and `public.tenants` before creating work.
- Workers receive the resolved original tenant UUID with each task and send it on subsequent API calls.
- No Cloud Run service moves regions. Workers never receive a database credential.

Cross-region access adds query latency, network egress, and a dependency on both regions. Monitor it, but do not add a second identity cache or replicated database until measurements justify that complexity.

## Runtime configuration

The checked-in production substitutions select:

```text
CLOUD_SQL_INSTANCE=jina-463721:us-east1:jina-db
JINA_TENANCY_MODE=shared-db
JINA_DB_NAME=jina
JINA_DB_USER=jina_v2_app
JINA_DB_PASS_SECRET=jina-shared-db-password:latest
```

`JINA_TENANT_ID` must be unset in shared mode. The API attaches exactly one Cloud SQL instance. Local and rollback deployments can use `JINA_TENANCY_MODE=fixed` with the existing `jina-v2:us-central1:jina-postgres` database.

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

Create `jina_v2_app` as a separate login. It may read the original identity tables and own only the v2 schemas; it must not read session/OAuth secret tables or mutate original application tables.

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
create schema if not exists jina_context_graph authorization jina_v2_app;

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

## Cutover

Before deployment:

1. Apply the v2 schemas to PostgreSQL 16 and run the full database test suite against a disposable PostgreSQL 16 instance.
2. Build and push the release images before pausing production writes.
3. Pause v2 webhook intake and workers. Wait until the three v2 schemas stop changing before taking the final export.
4. Use a PostgreSQL 17 `pg_dump` client to export the complete schema and data for only `jina_runtime`, `jina_board`, and `jina_context_graph`. A data-only copy is insufficient because historical rows can precede current column additions. Do not export or overwrite `public`.
5. In the plain SQL export, remove PostgreSQL 17's `SET transaction_timeout = 0` statement for PostgreSQL 16 compatibility. Remap only exact relational tenant values and JSON `tenantId` values from the legacy `omlabs` tenant to the original tenant UUID. Do not perform a broad text replacement, which would corrupt email addresses, task IDs, and dedupe keys.
6. Drop and restore only the three v2 schemas, set their ownership to `jina_v2_app`, then run the current schema upgrader once with temporary database `CREATE` permission. Revoke that permission before starting the API; production runs with `JINA_DB_MANAGE_SCHEMA=false`.
7. Compare every source/target v2 table count, verify that no legacy relational or JSON tenant remains, and sample board/graph reads.
8. Deploy the already-built images with the checked-in shared-mode substitutions. Verify `/health`, one signed webhook, tenant-scoped `/board`, a worker claim/completion, and a graph query before resuming normal traffic.

Keep `jina-v2:us-central1:jina-postgres` intact and read-only during the rollback window.

## Rollback

Redeploy the same image in fixed mode against the untouched v2 database:

```sh
gcloud builds submit \
  --project=jina-v2 \
  --region=us-central1 \
  --config=cloudbuild.deploy.yaml \
  --substitutions=_IMAGE_TAG=KNOWN_GOOD_TAG,_CLOUD_SQL_INSTANCE=jina-v2:us-central1:jina-postgres,_JINA_TENANCY_MODE=fixed,_JINA_DB_NAME=jina,_JINA_DB_USER=jina_app,_JINA_DB_PASS_SECRET=jina-db-password:latest,_JINA_FIXED_TENANT_ID=omlabs
```

Do not delete either database or run down-migrations as part of rollback. Reconcile any writes accepted after cutover before attempting another migration.
