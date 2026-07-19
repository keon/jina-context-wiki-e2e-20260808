# Deployment

Jina's runnable API and dashboard deploy to Cloud Run in the `jina-v2` Google
Cloud project. Pull requests run typechecking and tests. A push to `main`, or a
manual workflow dispatch, additionally builds immutable container images, pushes
them to Artifact Registry, deploys both services, and verifies their HTTP
endpoints.

## Production resources

- Region: `us-central1`
- Artifact Registry repository: `jina`
- API service: `jina-api`
- Dashboard service: `jina-dashboard`
- GitHub deployer: `github-deployer@jina-v2.iam.gserviceaccount.com`
- Workload identity provider: `github/omxyz-jina`

GitHub Actions exchanges its GitHub OIDC token for short-lived Google Cloud
credentials. No service-account key is stored in GitHub.

## Current runtime boundary

The API and dashboard are the two deployable HTTP services today. The API uses
the in-process simulated-run loop so the current MVP can advance queued board
tasks. `apps/workflows` is built and tested in CI, but is not deployed as a
separate service because it does not yet expose a worker entry point and the
board is not yet backed by shared Postgres storage.

Before production GitHub App intake is enabled, store the webhook secret in
Secret Manager and attach it to the API as `GITHUB_WEBHOOK_SECRET`. Never add
that secret to the workflow or repository files.

