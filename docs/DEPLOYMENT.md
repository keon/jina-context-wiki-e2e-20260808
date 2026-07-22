# Deployment

Cloud Build validates pull requests and deploys backend changes from `main` to the `jina-v2` Google Cloud project in `us-central1`. Pull-request builds use a validation-only service account and cannot change production. The main trigger requires approval before its build starts.

The Next.js dashboard and admin apps deploy through the Om Labs Vercel projects `jina-dashboard` and `jina-admin`, not this Google Cloud pipeline. Both projects track `omxyz/jina`; pushes to `main` create production deployments from `apps/dashboard` and `apps/admin`. Cloud Build still compiles both production bundles. The existing `jina-dashboard` Cloud Run service remains available during traffic cutover, but Cloud Build does not update it.

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

The API requires PostgreSQL plus `INTERNAL_API_TOKEN` and `GRAPH_API_TOKEN`. Fixed mode requires `JINA_TENANT_ID`; shared mode requires it to be unset and resolves original tenant UUIDs from the database. Signed intake additionally requires `GITHUB_WEBHOOK_SECRET`.

Backend services remain in `jina-v2/us-central1`. Production attaches the single original Jina database in `jina-463721/us-east1`; the original identity tables and v2-owned schemas have separate ownership and grants.

See [Shared original Jina database](SHARED_TENANCY.md) for IAM, database grants, cutover checks, and rollback.

The existing Cloud Run dashboard uses direct Cloud Run IAP. It forwards the verified user email and adds the service credential. Configure tenant administrators with `JINA_TENANT_ADMIN_PRINCIPALS`; other principals require repository ACL entries. Health, task-type definitions, and signed webhooks remain public; tenant data does not.

The current Vercel plan does not provide production Vercel Authentication for new projects, so both web apps enforce app-level HTTP authentication using server-only `JINA_WEB_AUTH_USERNAME` and `JINA_WEB_AUTH_PASSWORD` values. Both apps forward the original tenant UUID through `JINA_TENANT_ID` when calling the shared-database API. The dashboard additionally forwards `JINA_WEB_PRINCIPAL_ID=user:keon@omlabs.xyz`; the admin app calls as `svc:api`. Both are tenant administrators, so possession of the web credentials controls access to tenant-wide data. Rotate the shared password through Secret Manager and both Vercel projects together.

Both apps make server-side API calls with `JINA_API_URL` and `INTERNAL_API_TOKEN`. Those values belong only in Vercel Production environment variables and must never use a `NEXT_PUBLIC_` prefix. Preview builds intentionally receive no production API token.

Streamable HTTP MCP at `POST /mcp` requires both the internal credential and a bound principal. Browser origins must be listed exactly in `JINA_MCP_ALLOWED_ORIGINS`.

The simulation graph integration uses `GRAPH_API_TOKEN` for graph routes and exact ACL synchronization without granting worker or board access. Provision `jina-graph-api-token` directly in Secret Manager; the deployment mounts it without copying the value through GitHub. Never expose it to browsers or agents.

The integration maps each simulation UUID to `tenant:<uuid>` and replaces that principal's complete repository ACL through `POST /internal/graph/access/sync`; repository removal or App uninstall is therefore revoked on the next sync.

`GITHUB_CLONE_TOKEN` is the worker's temporary private-repository clone credential until installation tokens replace it. `GITHUB_API_TOKEN` may provide separate REST API access and falls back to the clone token when unset. Give the API token read-only access to Contents, Issues, Pull requests, Metadata, Deployments, and Actions. Deployments and Actions access is optional enrichment; required source failures still fail closed.

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

Acceptance requires terminal success, no lingering blocked work, a nonempty cited graph at the requested commit, fixed-template and causal retrieval, reviewed causal assertions in the projection, and empty canonical-outbox/parser backlogs. It also exercises the unchanged-head cache path and rejects stale attempts. The request key includes the Cloud Build ID so an operator can rerun a failed release without colliding with the prior task.

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
gcloud run services describe jina-dashboard --project=jina-v2 --region=us-central1 --format=json
gcloud builds list --project=jina-v2 --region=us-central1
```

Structured logging, trace correlation, metrics, and the recommended Cloud
Monitoring dashboards and alerts are documented in
[OBSERVABILITY.md](OBSERVABILITY.md).
