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
- Post-deploy acceptance job: `jina-acceptance`
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
commit DAG rows, exact commit trees, first-parent changes, content-addressed blob analyses, source
facts, and model-output proposals survive worker retries. Before fetching trees,
the worker asks which commits are known, so a repeat build reads only the head
tree and a new head stops at known parents. With an unchanged head, blob parsing and Daytona/Codex generation are reused and manifest/search projection returns a no-op checkpoint when there are no pending scoped events. The project task runs the manifest, search, reconciliation, and graph consumers over their own canonical outbox deliveries and rebuilds ref manifests, lexical/vector search, affected causal graphs, redirect
reconciliation, retention, and the immutable graph. The ontology worker continuously drains remaining events while idle; global redirect/identity changes fan out across repositories and events are acknowledged only after affected projections succeed. Ontology list polling loads
the newest full graph plus graph summaries; it does not hydrate historical node
and edge collections.

Board, event, and ontology reads/commands require the internal service credential
and are scoped to the canonical `JINA_TENANT_ID=omlabs`. The dashboard forwards the IAP-authenticated email as the application principal; `JINA_TENANT_ADMIN_PRINCIPALS=user:keon@omlabs.xyz` grants the independent Jina tenant-admin role. Non-admin users are filtered through repository ACLs for board, graph, retrieval, and mutation access. Repository Context
retrieval checks repository ACL scope at entry and at context assembly. On startup,
`JINA_TENANT_ALIASES` migrates the earlier `github:unscoped`, `e2e-production`,
and `e2e` records into that tenant, so old tasks remain visible. The dashboard
proxies read requests and adds the credential server-side.

The simulation integration uses that same storage tenant but never its service
principal for graph reads. Its server maps a simulation tenant UUID to
`tenant:<uuid>`, replaces the principal's repository ACL through
`POST /internal/graph/access/sync`, and binds every subsequent graph request to
that principal. The sync is exact so repository removal or App uninstall is
revoked on the next request. A dedicated `GRAPH_API_TOKEN` authenticates public
graph routes and ACL synchronization without granting worker or board access.
Provision it directly as `jina-graph-api-token` in Secret Manager; the production
workflow mounts that secret without copying it through GitHub. Never expose it to
browsers or agents.

The API also serves stateless Streamable HTTP MCP at `POST /mcp`. MCP exposes one
read-only `query_graph` tool and reuses the same repository-scoped retrieval path.
Production MCP traffic must arrive through a trusted identity-aware caller that
adds both the internal service credential and a bound `x-jina-principal-id`; the
endpoint rejects the service credential alone to prevent an implicit tenant-admin
fallback. Browser callers are rejected unless their exact origin is listed in
`JINA_MCP_ALLOWED_ORIGINS`.

Production dashboard ingress uses Cloud Run's direct IAP integration. The IAP
service agent alone receives Cloud Run invoker access, while
`keon@omlabs.xyz` receives `roles/iap.httpsResourceAccessor`. Opening the service
URL in a browser therefore presents Google sign-in and enforces user access at
the edge. The workflow manages the service-level IAP policy through its numeric
IAP REST resource, preserving existing bindings without requiring the Cloud
Resource Manager API. Health checks, task type definitions, and signed GitHub
webhooks on the API remain public; tenant data does not.

CI lints, typechecks, and tests the workspace, audits production dependencies at high
severity, and builds all three container images on every pull request. A deploy
can run only from `refs/heads/main`, including manual dispatches. The protected
`production` environment remains the approval boundary.

Before production GitHub App intake is enabled, store the webhook secret in
Secret Manager and attach it to the API as `GITHUB_WEBHOOK_SECRET`. Never add
that secret to the workflow or repository files.

`GITHUB_CLONE_TOKEN` is the worker's temporary private-repository credential
until installation tokens replace it. A fine-grained PAT must select every
repository the worker is allowed to process and grant read-only access to
Contents, Issues, Pull requests, and Metadata. Deployments and Actions read access
adds deployment observations; those two enrichments are optional and a 403/404
does not block core Git/code intake. Required source failures still fail closed,
and worker health reports only a safe GitHub failure category.

The ontology worker uses OpenRouter model `deepseek/deepseek-v4-flash` through the
`jina-openrouter-api-key` Secret Manager secret. The provider and model are fixed
as `ONTOLOGY_CODEX_PROVIDER=openrouter` and
`ONTOLOGY_CODEX_MODEL=deepseek/deepseek-v4-flash` in the deployment workflow.
The worker advertises a 16,000-token context with compaction at 12,000 tokens,
leaving room for the bounded evidence bundle and schema without an immediate
extra compaction call.
Transient provider stream, timeout, rate-limit, 5xx, and Daytona command-transport
failures retry the Codex execution once inside the same checkout. Validation and
schema failures remain terminal. Deployment acceptance keys include the GitHub run attempt, so
an operator can rerun a failed release without colliding with the prior board task.

## Verification

Pull-request CI must pass all of the following before merge:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm audit --prod --audit-level=high
docker build -f apps/api/Dockerfile .
docker build -f apps/worker/Dockerfile .
docker build -f apps/dashboard/Dockerfile .
```

## Database migrations and roles

Ontology schema changes are an administrative deployment concern, not a runtime
request concern. Run the migration with a schema-owning login before setting
`JINA_DB_MANAGE_SCHEMA=false` on the API:

```sh
DATABASE_URL=postgresql://... pnpm --filter @jina/db migrate
```

An administrator with `CREATEROLE` can also install the least-privilege
capability roles:

```sh
DATABASE_URL=postgresql://... pnpm --filter @jina/db migrate -- --install-roles
```

Grant the matching `jina_ontology_intake`, `jina_ontology_code`, `jina_ontology_knowledge`,
`jina_ontology_manifest`, `jina_ontology_search`, `jina_ontology_reconciliation`,
`jina_ontology_graph`, or `jina_ontology_query` capability to a split service login.
The modular-monolith login may use compatibility aggregate `jina_ontology_writer`;
reporting logins use `jina_ontology_reader`. Do not make application logins the schema
owner. Each component role can mutate only its owned outputs and canonical outbox deliveries.
The migration also revokes PUBLIC
access and configures matching default privileges for subsequently created
Ontology objects. Composite foreign keys prevent new cross-tenant references,
while partial unique indexes serialize live assertion candidates and
cardinality-one relationships.

CI supplies PostgreSQL 17 through a service container, so the `@jina/db`
integration test exercises commit deltas, parsing caches, source normalization,
knowledge review and disagreement, outbox projection, all eight cited templates, ACL denial,
redaction, erasure, and graph creation. After a `main` deployment, the workflow verifies API health,
worker-to-API connectivity, the dashboard's IAP annotation, and the IAP access
policy for `keon@omlabs.xyz`. It then executes the short-lived
`jina-acceptance` Cloud Run Job as `jina-runtime`; Secret Manager injects the
internal credential directly into that job, so the GitHub deployer can never
read it. The job submits `omxyz/jina-ontology-e2e` to the production three-chunk
workflow and waits for the aggregate to finish.
The acceptance check fails the deployment unless the graph has cited nodes and
edges, the fixed retrieval orchestrator returns cited results, Issue #4 resolves through PR #5, and Codex proposes the documented Issue #4 → PR #3 / commit causality with a reason and checked evidence. On the private fixture repository, the job performs the review transitions and proves the complete v5.1 query contract: two Feature implementations; the direct zod dependency; primary and alternative issue causes; PR and package counterfactuals; renamed implementation continuity; incident-introducing and recovery deployments; impacted Service and Feature; and the VirtualIssue resolved by unlinked PR #11. It then starts a cached projection build and requires those active facts plus the cited `INTRODUCED_BY` edge in the materialized graph. The canonical outbox and parser backlog must also be empty. It rejects any blocked ontology task
left for the accepted repository and ref; older active attempts must have been
superseded, while their terminal records remain available on the History page.
Repeated deployments deliberately exercise the unchanged-head cache path; a generator-contract version change performs one full semantic backfill and then returns to cached execution.
The acceptance poll window is 50 minutes and its Cloud Run task limit is 55
minutes. This outer wall-clock budget includes sandbox provisioning, repository
checkout, Codex installation, the ontology worker's model-command budget,
evidence validation, and cleanup. Production raises the executor's 30-minute
default command budget to 40 minutes so a slow but active Codex run can complete
while remaining inside the acceptance job's outer limits. The assertion worker
preloads prioritized evidence concurrently; `ONTOLOGY_FOCUS_BUNDLE_FILE_LIMIT`,
`ONTOLOGY_FOCUS_BUNDLE_MAX_CHARS`, and `ONTOLOGY_FOCUS_BUNDLE_FILE_CHARS` bound
that prompt input independently from the larger assertion focus list. It reports the root,
ingest, assertion, and projection statuses whenever they change. A blocked aggregate is
terminal for this automated check: acceptance reads the related board events and
includes the failed chunk's redacted worker reason instead of waiting for the
full timeout. On exit it also writes its brief success or failure summary to the
container termination-message path. Because Cloud Run does not currently
project that message into the task status, failures use stable coarse exit
categories: 20 for workflow state, 21-23 for graph scope/content/evidence, 24
for cited retrieval, 25 for convergence, and 26 for transport or unexpected
failures. The deployment step prints the execution and task status on both
success and failure without exposing the internal API credential; detailed
application diagnostics remain in the Cloud Run Job logs.

Worker topic sets use a pipe-separated `WORKER_TOPICS` value in Cloud Run.
Commas are reserved by the deployment CLI for separating environment entries;
the workflow verifies each worker's complete ordered topic list after rollout so
a truncated dispatcher configuration cannot pass health checks again.
Worker health also reports the most recent topic, outcome, timestamp, and a
coarse failure category. The public response never includes API polling errors,
task or repository identifiers, raw exceptions, or provider responses; detailed
redacted reasons stay in authenticated board events and Cloud Logging. GitHub
failures distinguish authentication, authorization, not-found, rate-limit,
timeout, response-shape, and checkout boundaries without returning the upstream
response body.

Useful production checks:

```sh
gcloud run services list --project=jina-v2 --region=us-central1
gcloud run services describe jina-dashboard --project=jina-v2 --region=us-central1 --format=json
curl --fail-with-body --request POST \
  --header "Authorization: Bearer $(gcloud auth print-access-token)" \
  --header "Content-Type: application/json" --data '{}' \
  "https://iap.googleapis.com/v1/projects/749416389045/iap_web/cloud_run-us-central1/services/jina-dashboard:getIamPolicy"
```
