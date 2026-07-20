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
ontology worker incrementally ingests the unseen commit DAG, PR/issue/CODEOWNERS source facts, tree-sitter structure, runs cited Daytona/Codex assertion jobs, and rebuilds manifest/search/graph projections; the task worker handles review,
research, publish, and cleanup topics. Both renew five-minute leases while work
is active. Expired leases are reclaimable after a worker crash. Each service has
one minimum instance and CPU always allocated, while the durable lease remains
the source of truth.

Ontology canonical writes are independently idempotent: source observations,
commit DAG rows, first-parent changes, content-addressed blob analyses, source
facts, and model-output proposals survive worker retries. Before fetching trees,
the worker asks which commits are known, so a repeat build reads only the head
tree and a new head stops at known parents. With an unchanged head, blob parsing and Daytona/Codex generation are reused and manifest/search projection returns a no-op checkpoint when there are no pending scoped events. The project task claims repository-scoped canonical
outbox rows and rebuilds ref manifests, lexical/vector search, redirect
reconciliation, retention, and the immutable graph. The ontology worker continuously drains remaining events while idle; global redirect/identity changes fan out across repositories and events are acknowledged only after affected projections succeed. Ontology list polling loads
the newest full graph plus graph summaries; it does not hydrate historical node
and edge collections.

Board, event, and ontology reads/commands require the internal service credential
and are scoped to the canonical `JINA_TENANT_ID=omlabs`. The dashboard forwards the IAP-authenticated email as the application principal; `JINA_TENANT_ADMIN_PRINCIPALS=user:keon@omlabs.xyz` grants the independent Jina tenant-admin role. Non-admin users are filtered through repository ACLs for board, graph, retrieval, and mutation access. Repository Context
retrieval checks repository ACL scope at entry and at context assembly. On startup,
`JINA_TENANT_ALIASES` migrates the earlier `github:unscoped`, `e2e-production`,
and `e2e` records into that tenant, so old tasks remain visible. The dashboard
proxies read requests and adds the credential server-side.

Production dashboard ingress uses Cloud Run's direct IAP integration. The IAP
service agent alone receives Cloud Run invoker access, while
`keon@omlabs.xyz` receives `roles/iap.httpsResourceAccessor`. Opening the service
URL in a browser therefore presents Google sign-in and enforces user access at
the edge. The workflow manages the service-level IAP policy through its numeric
IAP REST resource, preserving existing bindings without requiring the Cloud
Resource Manager API. Health checks, task type definitions, and signed GitHub
webhooks on the API remain public; tenant data does not.

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
integration test exercises commit deltas, parsing caches, GitHub normalization,
knowledge review, outbox projection, all four cited templates, ACL denial,
redaction, erasure, and graph creation. After a `main` deployment, the workflow verifies API health,
worker-to-API connectivity, the dashboard's IAP annotation, and the IAP access
policy for `keon@omlabs.xyz`.

Useful production checks:

```sh
gcloud run services list --project=jina-v2 --region=us-central1
gcloud run services describe jina-dashboard --project=jina-v2 --region=us-central1 --format=json
curl --fail --header "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://iap.googleapis.com/v1/projects/749416389045/iap_web/cloud_run-us-central1/services/jina-dashboard:getIamPolicy"
```
