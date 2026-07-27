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
JINA_MIGRATION_DB_PASS_SECRET=jina-primary-owner-db-password:latest
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
Cloud SQL Client in both database projects and direct secret accessor on
`jina-primary-owner-db-password`, `jina-primary-cutover-auditor-db-password`, and
`jina-legacy-cutover-auditor-db-password`. Remove
`jina-runtime@jina-v2.iam.gserviceaccount.com` from those secrets' IAM policies and do
not grant either identity project-wide Secret Manager access. `jina-db-password` is the
retired graph owner's credential; it is not a valid primary-owner credential.

These are intentionally cross-project grants: the Google identities are created in
`jina-v2`, while `roles/cloudsql.client` is bound on `jina-463721`, the project that owns
the database instance. The password secret is owned by `jina-v2`, so its direct IAM
binding remains in `jina-v2`. Both grants are required for migration; neither substitutes
for the other.

```sh
gcloud projects add-iam-policy-binding jina-463721 \
  --member='serviceAccount:jina-migration@jina-v2.iam.gserviceaccount.com' \
  --role='roles/cloudsql.client'

gcloud projects add-iam-policy-binding jina-v2 \
  --member='serviceAccount:jina-migration@jina-v2.iam.gserviceaccount.com' \
  --role='roles/cloudsql.client'

for secret in \
  jina-primary-owner-db-password \
  jina-primary-cutover-auditor-db-password \
  jina-legacy-cutover-auditor-db-password; do
  gcloud secrets add-iam-policy-binding "${secret}" \
    --project=jina-v2 \
    --member='serviceAccount:jina-migration@jina-v2.iam.gserviceaccount.com' \
    --role='roles/secretmanager.secretAccessor'
  gcloud secrets remove-iam-policy-binding "${secret}" \
    --project=jina-v2 \
    --member='serviceAccount:jina-runtime@jina-v2.iam.gserviceaccount.com' \
    --role='roles/secretmanager.secretAccessor'
done
gcloud projects get-iam-policy jina-463721 \
  --flatten='bindings[].members' \
  --filter='bindings.role=roles/cloudsql.client AND bindings.members:serviceAccount:jina-migration@jina-v2.iam.gserviceaccount.com' \
  --format='table(bindings.role,bindings.members)'
```

The build deployer needs permission to act as both service accounts, but that does not
authorize either workload identity to impersonate the other. Never attach
`jina-migration` to API, worker, dashboard, admin, or acceptance. Never mount an owner or
cutover-auditor secret into a `jina-runtime` revision.

The deployer may need read-only instance metadata:

```sh
gcloud projects add-iam-policy-binding jina-463721 \
  --member='serviceAccount:jina-cloud-build-deployer@jina-v2.iam.gserviceaccount.com' \
  --role='roles/cloudsql.viewer'

gcloud projects add-iam-policy-binding jina-v2 \
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
create role jina_cutover_auditor login noinherit nocreatedb nocreaterole password 'dedicated-audit-password';
alter role jina_cutover_auditor set default_transaction_read_only = on;
revoke cloudsqlsuperuser from jina_cutover_auditor;
revoke create, temporary on database jina from public;
revoke create on schema public from public;
grant connect on database jina to jina_v2_app;
grant connect on database jina to jina_app;
grant connect on database jina to jina_cutover_auditor;

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

grant usage on schema public, jina_runtime to jina_cutover_auditor;
grant select on table
  public.tenants,
  public.installations,
  public.repositories,
  jina_runtime.api_state
to jina_cutover_auditor;
```

Do not grant broad `SELECT ON ALL TABLES`, writes on `public`, or access to dashboard
sessions and integration secrets. The identity adapter also uses read-only transactions.
On the retired graph database, grant a separate same-named audit login only `USAGE` on
`jina_board` and `jina_context_graph`, plus `SELECT` on
`jina_board.workflows`, `jina_board.tasks`, and `jina_context_graph.outbox`. Use a
different password/secret from the primary audit login.

Install context capability roles through the administrative migration job, not the API:

```sh
CONTEXT_RUNTIME_DB_USER=jina_v2_app \
  DATABASE_URL=postgresql://jina_app:...@.../jina \
  pnpm --filter @jina/db migrate -- --install-roles
```

The migration verifies that the runtime role is already an ordinary
`NOSUPERUSER NOBYPASSRLS NOREPLICATION` login, applies only the hardening attributes a
documented `CREATEROLE` migration login may change, and grants focused context
capabilities except `jina_context_admin`. `NOINHERIT` means membership does not grant
ambient table access: runtime adapters must enter a transaction and issue `SET LOCAL
ROLE` for coordinator, ingest, derive, query, projector, or strictly tenant-scoped
administrative work. Tests connect as this exact runtime login and verify capability
activation, denial of the wildcard admin role, and denied direct access.

## Context-engine cutover

The context engine is a clean replacement. No old index data is copied into
`jina_context`; active repositories are reingested from authoritative current remote
heads and recorded at exact commits.

1. Build and validate release images against disposable PostgreSQL.
2. Record active repository/ref inventory and expected principal access.
3. Create restorable Cloud SQL backups for both the primary runtime database and the
   separate retired graph database; record both backup IDs.
4. Have the coordinated destructive deploy stop prior context workers and disable old
   API intake; do not create a manual preflight-to-shutdown gap.
5. After the write path is absent, audit the durable board and outbox. Archive terminal
   old workflow metadata for audit; reject every nondispatched outbox entry and do not
   translate or replay it.
6. Run the new schema/role migration with the separate owner credential and
   `CONTEXT_RUNTIME_DB_USER=jina_v2_app`.
7. Deploy API, `jina-context-worker`, task worker, dashboard, admin, and MCP-compatible
   API from the same exact source/build identity as one coordinated Cloud Run release.
8. Trigger `build-context` for every active repository/ref.
9. Require authoritative-head baseline generations recorded at exact commits before
   enabling callers, then allow knowledge derivation to publish enriched successors.
10. Audit per-ref build/checkpoint sequences, commits, manifests, projection-input
    fingerprints, ACLs, required projector status, outbox depth, citations, and exact
    queries. Run the production acceptance job and retain race-test output.
11. Retain both restorable backups for the normal recovery window before deleting the
    archived graph database or prior schema.

The coordinated deploy makes steps 4–5 executable. It binds the release to the connected
repository commit and verifies both backups. The deploy first deletes the retired worker
and old API and verifies both are absent. Its non-serving, SELECT-only preflight then reads the primary
API snapshot and directly audits the separate retired graph database's
`jina_board.workflows`, `jina_board.tasks`, and `jina_context_graph.outbox` tables. It
fails on nonterminal tasks or workflows, residual leases, unprocessed outbox rows,
missing relations, or a declared inventory that differs from the authoritative active
shared tenant set. This order fences claims and intake before the audit, eliminating a
preflight-to-shutdown race. The old API deletion is the intake-disable boundary; no
incompatible API remains available while the new schema is installed.

The API may run with `JINA_DB_MANAGE_SCHEMA=true` only in disposable/local environments.
Production runs a separate migration job, then starts the API with schema management
disabled. Release approval additionally verifies that the migration job uses
`jina-migration`, all network-facing services use `jina-runtime`, and the runtime identity
cannot access any migration-owner or cutover-auditor secret.

## Backup and rollback

Create and inspect both backups before cutover:

```sh
gcloud sql backups create \
  --project=jina-463721 \
  --instance=jina-db \
  --description="pre-context-engine-primary-${release_sha}"

gcloud sql backups list --project=jina-463721 --instance=jina-db

gcloud sql backups create \
  --project=jina-v2 \
  --instance=jina-postgres \
  --description="pre-context-engine-legacy-graph-${release_sha}"

gcloud sql backups list --project=jina-v2 --instance=jina-postgres
```

There is no mixed-version or compatibility rollback. Emergency rollback is:

1. stop all new context writers and keep the failed release isolated from traffic;
2. restore the matching primary and graph backups into two new isolated recovery
   instances; never restore over either current production database;
3. validate the restored schemas, tenant inventory, ACLs, queue state, and backup
   timestamps directly against those isolated targets;
4. deploy the complete prior API and worker image set as no-traffic recovery services,
   with their primary and graph database settings pinned to the isolated targets;
5. run the prior release's health, tenant/ACL, graph-query, and worker no-claim checks
   against those recovery services;
6. only after validation, shift traffic to the recovered API and enable the recovered
   worker, then reconcile writes accepted after the backup before another cutover.

Do not run down-migrations or point old code at `jina_context`. Do not delete the recovery
backups during the rollback window.
