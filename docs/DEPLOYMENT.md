# Deployment

Cloud Build validates pull requests and deploys backend changes from `main` to the `jina-v2` Google Cloud project in `us-central1`. Pull-request builds use a validation-only service account and cannot change production. The main trigger requires approval before its build starts. GitHub Actions is not used for CI or backend deployment; `.github` contains only Dependabot configuration.

The Next.js dashboard and admin apps deploy through the Om Labs Vercel projects `jina-dashboard` and `jina-admin`, not this Google Cloud pipeline. Both projects track `omxyz/jina`; pushes to `main` create production deployments from `apps/dashboard` and `apps/admin`, and pull requests create previews. Cloud Build still compiles both production bundles. The legacy `jina-dashboard` Cloud Run service remains available during traffic cutover, but Cloud Build does not update it.

## Current delivery paths

| Change                        | System          | Configuration                          | Result                                                                                         |
| ----------------------------- | --------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Pull request targeting `main` | Cloud Build     | `jina-pr-ci` (`cloudbuild.ci.yaml`)    | Validation only; no production credentials or mutation rights                                  |
| Push/merge to `main`          | Cloud Build     | `jina-main-deploy` (`cloudbuild.yaml`) | Creates a manually approved backend release, deploys Cloud Run, and runs production acceptance |
| Pull request                  | Vercel, Om Labs | `jina-dashboard`, `jina-admin`         | Preview deployments for both web apps                                                          |
| Push/merge to `main`          | Vercel, Om Labs | Production branch `main`               | Automatic production deployments for both web apps                                             |

The Cloud Build GitHub repository connection is `jina-github` in `us-central1`. Trigger IDs are `ad9f5441-6253-4553-8856-75be1aa66174` for PR validation and `92954810-36e3-4b35-8613-83c662d1052d` for approved `main` releases.

## Resources

- Artifact Registry repository: `jina`
- Cloud Run: `jina-api`, `jina-task-worker`, `jina-context-graph-worker`
- Cloud Run Job: `jina-acceptance`
- Production Cloud SQL: PostgreSQL 16 instance `jina-463721:us-east1:jina-db`, database `jina`
- Rollback Cloud SQL: PostgreSQL 17 instance `jina-v2:us-central1:jina-postgres`, database `jina`
- Cloud Build deployer: `jina-cloud-build-deployer@jina-v2.iam.gserviceaccount.com`
- Cloud Build pull-request validator: `jina-cloud-build-ci@jina-v2.iam.gserviceaccount.com`

Cloud Build runs entirely with user-specified Google service accounts. No Google service-account key is stored in GitHub or Vercel.

## Runtime configuration

The API requires PostgreSQL plus `INTERNAL_API_TOKEN` and `GRAPH_API_TOKEN`. Fixed mode requires `JINA_TENANT_ID`; shared mode requires it to be unset and resolves original tenant UUIDs from the database. Production sets `JINA_GITHUB_WEBHOOK_ENABLED=false` and omits `GITHUB_WEBHOOK_SECRET`; the original Jina service owns GitHub intake and submits tenant-scoped review graph builds. Local signed intake requires both the secret and an enabled switch.

Backend services remain in `jina-v2/us-central1`. Production attaches the single original Jina database in `jina-463721/us-east1`; the original identity tables and v2-owned schemas have separate ownership and grants.

See [Shared original Jina database](SHARED_TENANCY.md) for IAM, database grants, cutover checks, and rollback.

The existing Cloud Run dashboard uses direct Cloud Run IAP. It forwards the verified user email and adds the service credential. Configure tenant administrators with `JINA_TENANT_ADMIN_PRINCIPALS`; other principals require repository ACL entries. Health and task-type definitions remain public; the disabled webhook route only acknowledges and discards deliveries. Tenant data does not become public.

The current Vercel plan does not provide production Vercel Authentication for new projects, so both web apps enforce app-level HTTP authentication using server-only `JINA_WEB_AUTH_USERNAME` and `JINA_WEB_AUTH_PASSWORD` values. The configured username is `omlabs`; the password remains secret. Both apps forward the original tenant UUID through `JINA_TENANT_ID` when calling the shared-database API. The dashboard additionally forwards `JINA_WEB_PRINCIPAL_ID=user:keon@omlabs.xyz`; the admin app calls as `svc:api`. Both are tenant administrators, so possession of the web credentials controls access to tenant-wide data. Rotate the shared password through Secret Manager and both Vercel projects together.

Both apps make server-side API calls with `JINA_API_URL` and `INTERNAL_API_TOKEN`. Those values must remain server-only and must never use a `NEXT_PUBLIC_` prefix. The current Om Labs projects define the following variables for both Production and Preview so an authenticated preview can exercise the real API:

| Project          | Root directory   | Canonical production URL            | Server environment                                                                                                                  |
| ---------------- | ---------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `jina-dashboard` | `apps/dashboard` | `https://jina-dashboard.vercel.app` | `JINA_API_URL`, `INTERNAL_API_TOKEN`, `JINA_TENANT_ID`, `JINA_WEB_AUTH_USERNAME`, `JINA_WEB_AUTH_PASSWORD`, `JINA_WEB_PRINCIPAL_ID` |
| `jina-admin`     | `apps/admin`     | `https://jina-admin-ten.vercel.app` | `JINA_API_URL`, `INTERNAL_API_TOKEN`, `JINA_TENANT_ID`, `JINA_WEB_AUTH_USERNAME`, `JINA_WEB_AUTH_PASSWORD`                          |

`JINA_API_URL` is `https://jina-api-m56inn6iva-uc.a.run.app`, and `JINA_TENANT_ID` is the original shared-database tenant UUID. The dashboard's `/api/overview` route forwards the bearer credential, tenant ID, and bound principal to the API. A browser request without the web session is expected to return `401`; an authenticated request must return the combined board/event payload and must not use a localhost fallback.

Streamable HTTP MCP at `POST /mcp` requires both the internal credential and a bound principal. Browser origins must be listed exactly in `JINA_MCP_ALLOWED_ORIGINS`.

The simulation graph integration uses `GRAPH_API_TOKEN` for graph routes and exact ACL synchronization without granting worker or board access. Provision `jina-graph-api-token` directly in Secret Manager; the deployment mounts it without copying the value through GitHub. Never expose it to browsers or agents.

The integration maps each simulation UUID to `tenant:<uuid>` and replaces that principal's complete repository ACL through `POST /internal/graph/access/sync`; repository removal or App uninstall is therefore revoked on the next sync.

`GITHUB_CLONE_TOKEN` is the worker's temporary private-repository clone credential until installation tokens replace it. Production supplies the separate `GITHUB_API_TOKEN` from the `jina-github-api-token` Secret Manager secret; local execution falls back to the clone token when the API token is unset. Give the API token read-only access to Contents, Issues, Pull requests, Metadata, Deployments, and Actions. The production v5.1 acceptance fixture requires Deployments access so its source-backed deployment identities can enter the graph. Other optional-source failures remain fail-closed only where the source is required by the requested contract.

The production context graph uses the `jina-openrouter-api-key` secret with:

```text
CONTEXT_GRAPH_MODEL=google/gemini-3.5-flash-lite
CONTEXT_GRAPH_MODEL_MAX_OUTPUT_TOKENS=12000
CONTEXT_GRAPH_MODEL_TIMEOUT_MS=600000
CONTEXT_GRAPH_MODEL_VALIDATION_ATTEMPTS=3
```

The assertion worker calls OpenRouter's non-streaming chat-completions API directly with a strict JSON schema. Daytona provides only the pinned repository checkout and citation reads; no coding-agent runtime or localhost proxy participates in generation. Transient provider timeout, rate-limit, 5xx, and network failures retry once within the same checkout. Host validation can trigger up to two complete schema-constrained repair generations with the default three-attempt setting.

Workers receive pipe-separated `WORKER_TOPICS`; commas are reserved by the Cloud Run CLI. Services keep one minimum instance with CPU allocated, poll continuously, and renew five-minute leases. The durable lease, not process identity, is the source of truth.

## Context graph retry and cache behavior

Canonical observations, exact commit trees, first-parent changes, blob analyses, source facts, and model-output proposals survive retries. The worker stops commit traversal at known parents. Unchanged heads reuse parsed blobs and exact-fingerprint assertion generations. A generator-contract change performs one bounded semantic refresh and then returns to cached execution.

Manifest, search, reconciliation, and graph consumers own separate canonical outbox deliveries. Events are acknowledged only after the affected projection succeeds; global identity/redirect changes fan out to affected repositories. Historical graph lists load summaries, not every node and edge.

## CI and verification

Pull-request Cloud Build runs `cloudbuild.ci.yaml` with the validation-only service account. It starts an ephemeral PostgreSQL 16 container, matching the production major version, and runs:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm audit --prod --audit-level=high
pnpm --filter @jina/dashboard build
pnpm --filter @jina/admin build
```

The approved main-branch build runs `cloudbuild.yaml`, repeats validation, builds and pushes the API and worker images, deploys the three backend Cloud Run services, and checks API and worker health. The `jina-acceptance` job receives the internal credential directly from Secret Manager and runs the private fixture repository through the three-stage context graph workflow.

Acceptance requires terminal success, no lingering blocked work, a nonempty cited graph at the requested commit, fixed-template and causal retrieval, reviewed causal assertions in the projection, and empty canonical-outbox/parser backlogs. Its deployment scenario requires the postmortem's cited introducing and recovery deployments to appear in the incident trace, including when the postmortem retains an older repository name. It also exercises the unchanged-head cache path and rejects stale attempts. The request key includes the Cloud Build ID so an operator can rerun a failed release without colliding with the prior task.

The acceptance repository/ref is a single supersession scope. Do not run a manual fixture build or a second acceptance execution while the release job is active: any newer build for the same tenant, repository, and ref intentionally supersedes the older workflow. Wait for every stage of the existing workflow—not only its aggregate root—to become terminal before retrying with a new request key.

The acceptance poll window is 50 minutes, the Cloud Run task limit is 55 minutes, and production raises the model-command budget from 30 to 40 minutes. `CONTEXT_GRAPH_FOCUS_BUNDLE_FILE_LIMIT`, `CONTEXT_GRAPH_FOCUS_BUNDLE_MAX_CHARS`, and `CONTEXT_GRAPH_FOCUS_BUNDLE_FILE_CHARS` independently bound preloaded evidence.

A blocked aggregate is terminal for acceptance. The job reports the failed chunk's redacted reason instead of waiting for timeout. Exit categories are 20 for workflow state, 21–23 for graph scope/content/evidence, 24 for retrieval, 25 for convergence, and 26 for transport/unexpected failure. Detailed diagnostics remain in Cloud Logging and authenticated task events.

## Migrations and roles

Run schema migrations with a schema-owning login before setting `JINA_DB_MANAGE_SCHEMA=false` on the API:

```sh
DATABASE_URL=postgresql://... pnpm --filter @jina/db migrate
```

Install least-privilege roles with an administrator that has `CREATEROLE`:

```sh
DATABASE_URL=postgresql://... pnpm --filter @jina/db migrate -- --install-roles
```

Split services may receive `jina_context_graph_intake`, `jina_context_graph_code`, `jina_context_graph_knowledge`, `jina_context_graph_manifest`, `jina_context_graph_search`, `jina_context_graph_reconciliation`, `jina_context_graph_projection`, or `jina_context_graph_query`. The modular-monolith login may use aggregate `jina_context_graph_writer`; reporting logins use `jina_context_graph_reader`. Application logins must not own the schema.

The migration revokes `PUBLIC` access, installs matching default privileges, uses composite foreign keys to prevent cross-tenant references, and serializes live/cardinality-one assertions with partial unique indexes.

## Useful checks

```sh
gcloud run services list --project=jina-v2 --region=us-central1
gcloud run jobs executions list --job=jina-acceptance --project=jina-v2 --region=us-central1
gcloud builds list --project=jina-v2 --region=us-central1
vercel ls jina-dashboard --scope omlabs
vercel ls jina-admin --scope omlabs
```

Structured logging, trace correlation, metrics, and the recommended Cloud
Monitoring dashboards and alerts are documented in
[OBSERVABILITY.md](OBSERVABILITY.md).
