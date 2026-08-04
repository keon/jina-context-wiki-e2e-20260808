# Shared database tenancy

Jina runs in `jina-v2/us-east1` and connects to the original PostgreSQL database at
`jina-463721:us-east1:jina-db`.

- Original identity and GitHub App data remain owned by the original service in `public`.
- Jina owns `jina_runtime`, `jina_board`, and `jina_context`.
- Webhook intake resolves tenant UUIDs from `public.repositories`,
  `public.installations`, and `public.tenants`.
- Workers receive the resolved tenant with each task and never receive a database
  credential.

The unified API, its workers, and the shared database are co-located in `us-east1`. Keep the serving services
and database in the same region; do not introduce another identity cache or database
replica without measured need.

## Runtime configuration

```text
CLOUD_SQL_INSTANCE=jina-463721:us-east1:jina-db
JINA_TENANCY_MODE=shared-db
JINA_DB_NAME=jina
JINA_DB_USER=jina_v2_app
JINA_DB_PASS_SECRET=jina-shared-db-password:latest
JINA_MIGRATION_DB_USER=jina_app
JINA_MIGRATION_DB_PASS_SECRET=jina-primary-owner-db-password:latest
```

`JINA_TENANT_ID` must be unset in shared mode. Local deployments can use
`JINA_TENANCY_MODE=fixed` with an explicit tenant and disposable database.

## IAM

The API, both workers, acceptance job, and migration service accounts need Cloud SQL
Client in the database-owning project. Grant the owner password only to the migration
identity:

```sh
for account in \
  jina-api-runtime \
  jina-context-worker \
  jina-task-worker \
  jina-acceptance \
  jina-migration; do
  gcloud projects add-iam-policy-binding jina-463721 \
    --member="serviceAccount:${account}@jina-v2.iam.gserviceaccount.com" \
    --role='roles/cloudsql.client'
done

gcloud secrets add-iam-policy-binding jina-primary-owner-db-password \
  --project=jina-v2 \
  --member='serviceAccount:jina-migration@jina-v2.iam.gserviceaccount.com' \
  --role='roles/secretmanager.secretAccessor'
```

Never attach `jina-migration` to an API, worker, dashboard, admin, or acceptance service.
Grant each runtime identity only the secrets mounted by its service. Confirm that none
can access `jina-primary-owner-db-password`.

## Database boundary

`jina_v2_app` is a separate runtime login. It may read the original identity tables and
operate its board/runtime schemas, but it must not own `jina_context`, mutate `public`, or
read session/OAuth credential tables. `jina_app` is the separate context
migration/schema owner used only by the migration job.

### `jina_app` is shared with Jina v1

`jina_app` is not exclusive to this repository. Jina v1
([omxyz/jina-simulation](https://github.com/omxyz/jina-simulation)) connects to the same
instance as `jina_app` through `jina-database-url` in project `jina-463721`, while this
repository reads the same password from `jina-primary-owner-db-password` in project
`jina-v2` for its migration login. Two secret stores therefore hold one credential with
nothing keeping them in step.

Rotating it on one side alone breaks the other. A v1 rotation that left this repository's
copy stale failed a production release at the schema step with
`28P01 password authentication failed for user "jina_app"`, and resetting the role's
password to match this repository would equally break v1, which pins an explicit version.

Treat v1's `jina-database-url` as the source of truth and copy the password across rather
than resetting the role. The value never needs to be displayed:

```bash
gcloud secrets versions access latest --secret=jina-database-url --project=jina-463721 \
  | python3 -c "import sys,urllib.parse as p; print(p.unquote(p.urlparse(sys.stdin.read().strip()).password or ''), end='')" \
  | gcloud secrets versions add jina-primary-owner-db-password --project=jina-v2 --data-file=-
```

`scripts/cloud-build-deploy.sh` compares the two fingerprints before it builds anything and
stops with this command when they diverge, so a stale copy can no longer surface only once
the migration runs. Set `JINA_SHARED_OWNER_SECRET_PROJECT` and `JINA_SHARED_OWNER_SECRET`
if v1's secret moves. Only fingerprints are printed, and a release still proceeds where the
upstream secret is unreadable, because cross-project access is not required to deploy.

The runtime login `jina_v2_app` is unaffected by this coupling, so a healthy API says
nothing about whether the migration login can still authenticate.

If `gcloud sql users create` grants `cloudsqlsuperuser`, revoke it before using the role:

```sql
revoke cloudsqlsuperuser from jina_v2_app;
```

Run the boundary setup as a database administrator:

```sql
revoke cloudsqlsuperuser from jina_v2_app;
revoke create, temporary on database jina from public;
revoke create on schema public from public;
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

Install context capability roles through the administrative migration job:

```sh
CONTEXT_RUNTIME_DB_USER=jina_v2_app \
  DATABASE_URL=postgresql://jina_app:...@.../jina \
  pnpm --filter @jina/db migrate -- --install-roles
```

The migration verifies that the runtime role is already an ordinary
`NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB NOCREATEROLE` login, applies only the
hardening attributes a documented `CREATEROLE` migration login may change, and grants
focused context capabilities except `jina_context_admin`, each granted `WITH INHERIT
FALSE`. A dormant membership grants no ambient table access: runtime adapters must enter a
transaction and issue
`SET LOCAL ROLE` for coordinator, ingest, derive, query, projector, or strictly
tenant-scoped administrative work. Tests connect as this exact runtime login and verify
capability activation, denial of the wildcard admin role, and denied direct access.

## Backup and recovery

Create and verify a primary database backup before deployment. Restore backups only into
an isolated recovery instance, validate schema, tenant inventory, ACLs, queue state, and
timestamps there, then deploy the matching release as no-traffic recovery services before
shifting production traffic. Do not run down-migrations or restore over current
production.
