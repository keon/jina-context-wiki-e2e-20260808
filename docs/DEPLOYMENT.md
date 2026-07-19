# Deployment

Jina's runnable API and dashboard deploy to Cloud Run in the `jina-v2` Google
Cloud project. Pull requests run typechecking and tests. Only `main` may deploy,
including manual workflow dispatches. Deployment builds immutable container
images, pushes them to Artifact Registry, deploys all services, and verifies
their HTTP endpoints.

## Production resources

- Region: `us-central1`
- Artifact Registry repository: `jina`
- API service: `jina-api`
- Dashboard service: `jina-dashboard`
- Ontology worker service: `jina-ontology-worker`
- Cloud SQL instance: `jina-postgres` (PostgreSQL 17)
- Database: `jina`
- GitHub deployer: `github-deployer@jina-v2.iam.gserviceaccount.com`
- Workload identity provider: `github/omxyz-jina`

GitHub Actions exchanges its GitHub OIDC token for short-lived Google Cloud
credentials. No service-account key is stored in GitHub.

## Current runtime boundary

The API owns short board state transitions and persists outbox leases in Cloud
SQL. The ontology worker claims a lease, performs Daytona/Codex execution outside
the API, and completes with the same lease. Expired leases are reclaimable after
a worker crash. The worker runs with one minimum instance and CPU always
allocated, while the durable lease remains the source of truth.

Board, event, and ontology reads require the internal service credential and are
scoped to `JINA_TENANT_ID`. The dashboard proxies these requests and adds
the credential server-side. Production dashboard ingress requires Cloud Run IAM
and its proxy only exposes read endpoints. Health checks, task type definitions,
and signed GitHub webhooks remain public.

Before production GitHub App intake is enabled, store the webhook secret in
Secret Manager and attach it to the API as `GITHUB_WEBHOOK_SECRET`. Never add
that secret to the workflow or repository files.
