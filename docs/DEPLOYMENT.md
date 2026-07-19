# Deployment

Jina's runnable API and dashboard deploy to Cloud Run in the `jina-v2` Google
Cloud project. Pull requests run typechecking and tests. Only `main` may deploy,
including manual workflow dispatches. Deployment builds immutable container
images, pushes them to Artifact Registry, deploys all services, and verifies
their HTTP endpoints.

This file documents the deployment produced by the current `main` workflow.
Changes on a pull-request branch are validated but are not production state until
they are merged and the protected deployment job succeeds.

## Production resources

- Region: `us-central1`
- Artifact Registry repository: `jina`
- API service: `jina-api`
- Dashboard service: `jina-dashboard`
- Ontology worker service: `jina-ontology-worker`
- Review/task worker service: `jina-task-worker`
- Cloud SQL instance: `jina-postgres` (PostgreSQL 17)
- Database: `jina`
- GitHub deployer: `github-deployer@jina-v2.iam.gserviceaccount.com`
- Workload identity provider: `github/omxyz-jina`

GitHub Actions exchanges its GitHub OIDC token for short-lived Google Cloud
credentials. No service-account key is stored in GitHub.

## Current runtime boundary

The API owns only short board state transitions and persists outbox leases in
Cloud SQL. Two instances of the same worker image claim disjoint topic sets. The
ontology worker resolves source commits and runs Daytona/Codex builds; the task worker handles review,
research, publish, and cleanup topics. Both renew five-minute leases while work
is active. Expired leases are reclaimable after a worker crash. Each service has
one minimum instance and CPU always allocated, while the durable lease remains
the source of truth.

An ontology completion writes the immutable graph generation and completed board
snapshot in one PostgreSQL transaction. Ontology list polling loads the newest
full graph plus graph summaries in two queries; it does not hydrate historical
node and edge collections.

Board, event, and ontology reads require the internal service credential and are
scoped to the canonical `JINA_TENANT_ID=omlabs`. On startup,
`JINA_TENANT_ALIASES` migrates the earlier `github:unscoped`, `e2e-production`,
and `e2e` records into that tenant, so old tasks remain visible. The dashboard
proxies read requests and adds the credential server-side.

Production dashboard ingress uses Cloud Run's direct IAP integration. The IAP
service agent alone receives Cloud Run invoker access, while
`keon@omlabs.xyz` receives `roles/iap.httpsResourceAccessor`. Opening the service
URL in a browser therefore presents Google sign-in and enforces user access at
the edge. Health checks, task type definitions, and signed GitHub webhooks on the
API remain public; tenant data does not.

CI typechecks and tests the workspace, audits production dependencies at high
severity, and builds all three container images on every pull request. A deploy
can run only from `refs/heads/main`, including manual dispatches. The protected
`production` environment remains the approval boundary.

Before production GitHub App intake is enabled, store the webhook secret in
Secret Manager and attach it to the API as `GITHUB_WEBHOOK_SECRET`. Never add
that secret to the workflow or repository files.

## Verification

Pull-request CI must pass all of the following before merge:

```sh
pnpm typecheck
pnpm test
pnpm audit --prod --audit-level=high
docker build -f apps/api/Dockerfile .
docker build -f apps/worker/Dockerfile .
docker build -f apps/dashboard/Dockerfile .
```

CI supplies PostgreSQL 17 through a service container, so the `@jina/db`
integration test exercises the atomic graph/board transaction and tenant-scoped
graph queries. After a `main` deployment, the workflow verifies API health,
worker-to-API connectivity, the dashboard's IAP annotation, and the IAP access
policy for `keon@omlabs.xyz`.

Useful production checks:

```sh
gcloud run services list --project=jina-v2 --region=us-central1
gcloud run services describe jina-dashboard --project=jina-v2 --region=us-central1 --format=json
gcloud iap web get-iam-policy --project=jina-v2 --region=us-central1 \
  --resource-type=cloud-run --service=jina-dashboard
```
