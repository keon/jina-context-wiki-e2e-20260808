# Shared original Jina database

Jina v2 runs in `jina-v2/us-central1` and connects to the original PostgreSQL database at
`jina-463721:us-east1:jina-db`.

- Original identity and GitHub App data remain owned by the original service in `public`.
- Jina v2 owns `jina_runtime`, `jina_board`, and `jina_context`.
- Webhook intake resolves tenant UUIDs from `public.repositories`,
  `public.installations`, and `public.tenants`.
- Workers receive the resolved tenant with each task and never receive a database
  credential.

Cross-region access adds latency, egress, and a dependency on both regions. Monitor it;
do not introduce another identity cache or database replica without measured need.

## Runtime configuration

The checked-in production substitutions select:

```text
CLOUD_SQL_INSTANCE=jina-463721:us-east1:jina-db
JINA_TENANCY_MODE=shared-db
JINA_DB_NAME=jina
JINA_DB_USER=jina_v2_app
JINA_DB_PASS_SECRET=jina-shared-db-password:latest
JINA_MIGRATION_DB_USER=jina_app
JINA_MIGRATION_DB_PASS_SECRET=jina-db-password:latest
```

`JINA_TENANT_ID` must be unset in shared mode. Local deployments can use
`JINA_TENANCY_MODE=fixed` with an explicit tenant and disposable database.

## IAM

The runtime service account needs Cloud SQL Client in the database-owning project:

```sh
gcloud projects add-iam-policy-binding jina-463721 \
  --member='serviceAccount:jina-runtime@jina-v2.iam.gserviceaccount.com' \
  --role='roles/cloudsql.client'
```

The migration job uses the distinct
`jina-migration@jina-v2.iam.gserviceaccount.com` service account. Grant that identity
Cloud SQL Client and secret accessor on `jina-db-password` only. Remove
`jina-runtime@jina-v2.iam.gserviceaccount.com` from that secret's IAM policy and do not
grant either identity project-wide Secret Manager access.

```sh
gcloud projects add-iam-policy-binding jina-463721 \
  --member='serviceAccount:jina-migration@jina-v2.iam.gserviceaccount.com' \
  --role='roles/cloudsql.client'

gcloud secrets add-iam-policy-binding jina-db-password \
  --project=jina-v2 \
  --member='serviceAccount:jina-migration@jina-v2.iam.gserviceaccount.com' \
  --role='roles/secretmanager.secretAccessor'

gcloud secrets remove-iam-policy-binding jina-db-password \
  --project=jina-v2 \
  --member='serviceAccount:jina-runtime@jina-v2.iam.gserviceaccount.com' \
  --role='roles/secretmanager.secretAccessor'

gcloud secrets get-iam-policy jina-db-password --project=jina-v2
```

The build deployer needs permission to act as both service accounts, but that does not
authorize either workload identity to impersonate the other. Never attach
`jina-migration` to API, worker, dashboard, admin, or acceptance. Never mount
`jina-db-password` into a `jina-runtime` revision.

The deployer may need read-only instance metadata:

```sh
gcloud projects add-iam-policy-binding jina-463721 \
  --member='serviceAccount:jina-cloud-build-deployer@jina-v2.iam.gserviceaccount.com' \
  --role='roles/cloudsql.viewer'
```

The runtime service account also needs `roles/secretmanager.secretAccessor` on the
database, internal API, context API, webhook, GitHub App identity/private key, fallback
clone, Daytona, and model-provider secrets mounted into its services.

## Database boundary

`jina_v2_app` is a separate runtime login. It may read the original identity tables and
operate its board/runtime schemas, but it must not own `jina_context`, mutate `public`, or
read session/OAuth credential tables. `jina_app` is the separate context
migration/schema owner used only by the migration job.

If `gcloud sql users create` grants `cloudsqlsuperuser`, revoke it before using the role:

```sql
revoke cloudsqlsuperuser from jina_v2_app;
```

Run the boundary setup as a database administrator:

```sql
create role jina_app login password 'migration-owner-password';
create role jina_v2_app login noinherit password 'runtime-password';
grant connect on database jina to jina_v2_app;
grant connect on database jina to jina_app;

create schema if not exists jina_runtime authorization jina_v2_app;
create schema if not exists jina_board authorization jina_v2_app;
create schema if not exists jina_context authorization jina_app;

grant usage on schema public to jina_v2_app;
grant select on table
  public.tenants,
  public.tenant_members,
  public.installations,
  public.repositories
to jina_v2_app;
```

Do not grant broad `SELECT ON ALL TABLES`, writes on `public`, or access to dashboard
sessions and integration secrets. The identity adapter also uses read-only transactions.

Install context capability roles through the administrative migration job, not the API:

```sh
CONTEXT_RUNTIME_DB_USER=jina_v2_app \
  DATABASE_URL=postgresql://jina_app:...@.../jina \
  pnpm --filter @jina/db migrate -- --install-roles
```

The migration verifies the runtime role name, applies `ALTER ROLE ... NOINHERIT`, and
grants membership in every focused context capability role. `NOINHERIT` means membership
does not grant ambient table access: runtime adapters must enter a transaction and issue
`SET LOCAL ROLE` for coordinator, ingest, derive, query, projector, or administrative
work. Tests connect as this exact runtime login and verify capability activation and
denied direct access.

## Context-engine cutover

The context engine is a clean replacement. No old index data is copied into
`jina_context`; active repositories are reingested at exact commits.

1. Build and validate release images against disposable PostgreSQL.
2. Record active repository/ref inventory and expected principal access.
3. Create a restorable Cloud SQL backup and record its operation/backup ID.
4. Stop prior context workers and disable new context intake.
5. Wait for old writes to stop. Archive pending old workflow metadata for audit; do not
   translate or replay it.
6. Run the new schema/role migration with the separate owner credential and
   `CONTEXT_RUNTIME_DB_USER=jina_v2_app`.
7. Deploy API, `jina-context-worker`, task worker, dashboard, admin, and MCP-compatible
   API from the same exact source/build identity as one coordinated Cloud Run release.
8. Trigger `build-context` for every active repository/ref.
9. Require exact-commit baseline generations before enabling callers, then allow
   knowledge derivation to publish enriched successors.
10. Audit per-ref build/checkpoint sequences, commits, manifests, projection-input
    fingerprints, ACLs, required projector status, outbox depth, citations, and exact
    queries. Run the production acceptance job and retain race-test output.
11. Retain the restorable backup for the normal recovery window before deleting any
    archived prior schema.

The API may run with `JINA_DB_MANAGE_SCHEMA=true` only in disposable/local environments.
Production runs a separate migration job, then starts the API with schema management
disabled. Release approval additionally verifies that the migration job uses
`jina-migration`, all network-facing services use `jina-runtime`, and the runtime identity
cannot access `jina-db-password`.

## Backup and rollback

Create and inspect the backup before cutover:

```sh
gcloud sql backups create \
  --project=jina-463721 \
  --instance=jina-db \
  --description="before context-engine cutover"

gcloud sql backups list --project=jina-463721 --instance=jina-db
```

There is no mixed-version or compatibility rollback. Emergency rollback is:

1. stop all new context writers;
2. redeploy the complete previously known-good API and worker release;
3. restore its matching database backup into an isolated recovery target;
4. validate tenant identities and ACLs before directing traffic;
5. reconcile writes accepted after the backup before trying another cutover.

Do not run down-migrations or point old code at `jina_context`. Do not delete the recovery
backup during the rollback window.
