# Internal user transition

This transition adds stable Jina user UUIDs while preserving every existing
tenant UUID and all GitHub-id-based reads used by the current v1 and v2
deployments. It does not rename tables, replace sessions, or change webhook
routing.

## Deployment order

1. Deploy migrations `0025` through `0027`. They are additive and keep all new
   foreign keys nullable for the rolling-deployment window.
2. Run a dry run against the production database:

   ```bash
   cd api
   DATABASE_URL="postgresql://..." npm run identity:backfill -- \
     --dry-run --require-converged --resolve-repositories
   ```

3. Confirm all four `unmapped*` counts are zero. This includes repositories,
   which must have an exact installation before the new API serves traffic.
   `--require-converged` exits non-zero and rolls back unless there are zero
   unmapped legacy identity references and zero enabled repositories without
   an exact, same-tenant installation link. Disabled historical repositories
   may remain unlinked because they cannot serve or dispatch reviews.
4. Apply the transition:

   ```bash
   cd api
   DATABASE_URL="postgresql://..." npm run identity:backfill -- \
     --apply --require-converged --resolve-repositories
   ```

5. Deploy the API revision with no traffic, verify its tagged `/healthz`,
   rerun the convergence gate, then promote it at 5%, 25%, and 100%. Restore
   the previous revision to 100% automatically if any promotion or check fails.
6. Run the apply command a final time after 100% promotion. `identitiesCreated`,
   `membershipsBackfilled`, `integrationsBackfilled`, and `sessionsBackfilled`
   should all be zero. This catches rows written by an older Cloud Run revision
   during the rollout. The checked-in API deployment workflow performs this
   sequence and does not cancel an in-progress canary.

The command uses one transaction and a transaction-scoped advisory lock.
`--dry-run` executes the same statements and rolls them back. It never prints
the database URL, OAuth tokens, or session JSON.
`--resolve-repositories` checks GitHub's live per-installation repository lists
and links a legacy repository only when exactly one active installation
contains its immutable GitHub repository ID.

Live sign-ins take a shared form of the identity-transition lock, so sign-ins
remain concurrent with each other. The transition takes the lock exclusively.
If a sign-in transaction is already active, the transition exits without
changes and can be retried; once the transition starts, a new sign-in waits for
that transaction to finish instead of racing user creation.

## What is backfilled

The candidate set is the union of GitHub users found in:

- active dashboard session JSON;
- `user_integrations`;
- `tenant_members`;
- personal-account `tenants`.

GitHub's numeric user ID is stored as the stable provider subject. Logins,
names, and avatars are mutable profile data. Existing `tenant_members`,
`user_integrations`, and `dashboard_sessions` rows receive the matching
`users.id`. Existing tenants are classified as `personal` or `team`, and
personal tenants receive `personal_owner_user_id`. Installation account
metadata is copied from the tenant onto `installations`; Jina organizations
remain independent from GitHub namespaces. Jina-owned team
organizations may be created without a GitHub account and receive a native
creator-admin membership. Repositories written
during the rolling window are catch-up linked to an installation when the
owner matches, or when the tenant has exactly one installation; ambiguous rows
are deliberately left untouched.
The signed installation-webhook sender is also copied to the installation as
short-lived installer proof.

## Runtime behavior

GitHub OAuth remains the only sign-up method. On login, the API upserts the
GitHub provider connection, durable Jina user, personal workspace, and owner
membership in one transaction. GitHub's numeric ID remains in the session and
legacy columns during the transition; the session row and `/v1/dashboard/me`
also carry the stable Jina user UUID.

Tenant authorization reads the stable `user_id` first and falls back to the
GitHub ID only for rows written by an older revision. New sessions,
memberships, integrations, tenants, and installations dual-write the new
identity metadata. No separate identity service or second session system is
introduced.

Billing belongs to the Jina workspace: the Autumn `customer_id`, billing
policy, credit usage, checkout, and run billing all use `tenants.id`. Neither
the internal user id nor a GitHub user/organization id is a billing account.
Legacy personal-billing routes resolve `personal_owner_user_id` for new
sessions and use `github_account_id` only when an old session has no internal
user id. A supplied but mismatched internal id cannot borrow that fallback.

GitHub accounts are connections, not workspaces. Migration `0026` adds an
exact `repositories.installation_id` association, so one Jina tenant can
contain repositories from multiple GitHub users or organizations without
guessing which installation token owns a repository. Connecting another
installation changes neither the tenant UUID nor its Autumn customer.

Authenticated dashboard users can create a Jina organization from the workspace
menu or the Organization settings page before connecting GitHub. Organization
settings also exposes the stable tenant id, workspace type, membership role, and
an admin-only organization name editor. Once tenant membership has loaded, the
workspace menu is available even for a user with only a personal workspace, and
its `Create organization` action opens an inline form in the menu. Submitting
either form creates the Jina tenant without starting a GitHub installation. The
created team tenant is immediately selectable; its admins can attach multiple
GitHub App installations from Integrations, and the dashboard lists
each connected account, enabled-repository count, and active/suspended/deleted
status. The connection API requires Jina tenant-admin access, verifies that the
installation belongs to Jina's App, and rechecks GitHub account-admin authority
or signed installer proof.

The GitHub App setup URL should return to the dashboard integrations page
(for production, `https://app.usejina.com/integrations`). The dashboard sends
GitHub's returned `installation_id` to the selected tenant's authenticated
connection endpoint. The API rechecks both Jina tenant-admin access and that
the installation belongs to Jina's GitHub App. It also requires the signed-in
OAuth user to own the personal GitHub account, hold active org-admin access,
or match the installer recorded from GitHub's signed webhook. The last path
supports organizations that restrict OAuth Apps and hide membership from the
OAuth API; URL parameters alone never authorize a connection. The dashboard
briefly retries if the signed webhook is still being processed.

GitHub-derived tenant admin grants expire after five minutes. Admin writes
then recheck the user's live organization-admin membership and fail closed
when GitHub denies or cannot refresh it. Personal Jina workspace ownership is
internal and does not depend on this GitHub refresh. Restricted-organization
installer proof is scoped to the fresh signed-webhook window and also expires;
it is not a permanent admin bypass.

When the webhook created a fresh account-derived tenant before the selected
Jina tenant was known, a successful connection marks that source tenant as
merged only if it contains no other installations, history, billing policy,
integration, or model settings. Merged shells are hidden from authorization
and the workspace switcher but retained for a lossless rollback. A later
reinstall follows the recorded destination instead of recreating the shell.

## Compatibility and rollback

The old columns remain authoritative during this first phase. Rolling back the
application therefore requires no database rollback: leave the additive
tables and columns in place and redeploy the previous revision.

Before the production transition, record the revision currently serving
traffic and confirm Cloud SQL point-in-time recovery is available:

```bash
rollback_revision="$(
  gcloud run services describe "$SERVICE_NAME" \
    --project "$PROJECT_ID" \
    --region "$REGION" \
    --format=json |
    jq -er '.status.traffic[] | select(.percent == 100) | .revisionName'
)"
printf 'rollback revision: %s\n' "$rollback_revision"
```

Keep that revision name in the deployment or incident record. If the new API
revision misbehaves, move all traffic back to it:

```bash
gcloud run services update-traffic "$SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --to-revisions="${rollback_revision}=100"
```

Then verify API health, one existing GitHub sign-in, one existing organization,
and one v2 webhook/repository lookup. Do not run a down-migration or delete
`users`/`user_identities`: the previous revision ignores the additive objects,
continues writing the preserved GitHub columns, and is allowed to leave the new
nullable `user_id` columns empty. Before retrying the new revision, run the
backfill apply command again to catch those legacy writes and confirm a second
apply reports zero updates.

Migration `0025` is applied in one transaction, and the backfill also runs in
one transaction. A failure in either operation leaves no partial schema or
partial backfill. The PostgreSQL transition test snapshots every legacy column
for its tenants, memberships, integration, session, installation, and
repository, then proves the snapshot is unchanged after the backfill. The same
test exercises the v2 read contract against the preserved tenant UUID.

Migrations `0026` and `0027` are also additive and compatible with the previous
API revision: the repository connection, installer proof, and tenant merge
columns remain nullable during the rolling deployment. Every installation
reassignment is appended to
`installation_tenant_moves`. Before any reviews or project history are created,
operators can inspect and safely reverse the latest move:

```bash
DATABASE_URL="postgresql://..." npm run tenant-installation:rollback -- \
  --installation-id 123456 --dry-run

DATABASE_URL="postgresql://..." npm run tenant-installation:rollback -- \
  --installation-id 123456 --apply
```

The command refuses rollback after tenant-owned history exists, because moving
that history would silently change its billing owner. At that point the correct
operation is an explicit workspace merge, not a connection rollback.
For the same reason, the setup endpoint only reassigns a freshly-created
installation shell. An older installation—even one with no review rows—is an
established workspace and cannot have its billing ownership changed by the
connection flow.
When rollback is allowed, it also clears the source tenant's merge marker so
the original workspace becomes visible again.
Each move snapshots the exact repository UUID/GitHub-ID set it covered.
Rollback refuses if that set changed or if null-linked legacy repositories
could make the scope ambiguous.

GitHub `installation.suspended`, `installation.unsuspended`, and
`installation.deleted` webhooks flow through the same idempotent installation
task. The signed webhook applies suspension/deletion immediately before
dispatching that retryable task. Suspended installations stop resolving;
unsuspension restores their exact repositories; deletion records the terminal
state and disables those repositories without deleting review history.

Do not make `user_id` columns `not null`, remove GitHub-id reads, or clear
`tenants.github_account_*` until both v1 and v2 have completed their auth
cutovers and the legacy-session lifetime has elapsed.

## Local mock-data validation

CI applies every migration to disposable PostgreSQL 16 and runs both transition
and runtime identity tests. The mock data covers personal/team tenants,
memberships, a user integration, an active legacy session, a GitHub
installation, first login, profile rename, idempotent login, dual-written
memberships/integrations/sessions, an idempotent backfill rerun, and catch-up
after a simulated legacy writer adds another member. The transition test also
executes Jina v2's current read-only repository and membership lookup shapes
against the migrated tables and verifies that the original tenant UUID is
unchanged. The multi-installation PostgreSQL test connects repositories from
two GitHub organizations to one Jina tenant, verifies exact installation-token
selection, tenant billing, and restricted-org installer proof, retires the
empty source shell, dry-runs the rollback primitive, restores that shell, and
proves reassignment/rollback fail closed on unresolved or changed repository
scope and after review history exists. Lifecycle coverage suspends, restores,
and deletes an installation against the same exact repository mapping.
