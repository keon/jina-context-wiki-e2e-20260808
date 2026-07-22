# Deployment

Only `main` deploys Jina to the `jina-v2` Google Cloud project in `us-central1`. Pull requests validate the repository but cannot change production. The protected `production` environment is the approval boundary.

## Resources

- Artifact Registry repository: `jina`
- Cloud Run: `jina-api`, `jina-dashboard`, `jina-task-worker`, `jina-context-graph-worker`
- Cloud Run Job: `jina-acceptance`
- Cloud SQL: PostgreSQL 17 instance `jina-postgres`, database `jina`
- GitHub deployer: `github-deployer@jina-v2.iam.gserviceaccount.com`
- Workload identity provider: `github/omxyz-jina`

GitHub Actions exchanges its OIDC token for short-lived Google credentials. No service-account key is stored in GitHub.

## Runtime configuration

The API requires PostgreSQL, `INTERNAL_API_TOKEN`, and `JINA_TENANT_ID`. Signed intake additionally requires `GITHUB_WEBHOOK_SECRET` from Secret Manager. `JINA_TENANT_ALIASES` migrates configured legacy tenant IDs at startup.

The dashboard uses direct Cloud Run IAP. It forwards the verified user email and adds the service credential. Configure tenant administrators with `JINA_TENANT_ADMIN_PRINCIPALS`; other principals require repository ACL entries. Health, task-type definitions, and signed webhooks remain public; tenant data does not.

Streamable HTTP MCP at `POST /mcp` requires both the internal credential and a bound principal. Browser origins must be listed exactly in `JINA_MCP_ALLOWED_ORIGINS`.

The simulation graph integration uses `GRAPH_API_TOKEN` for graph routes and exact ACL synchronization without granting worker or board access. Provision `jina-graph-api-token` directly in Secret Manager; the deployment mounts it without copying the value through GitHub. Never expose it to browsers or agents.

The integration maps each simulation UUID to `tenant:<uuid>` and replaces that principal's complete repository ACL through `POST /internal/graph/access/sync`; repository removal or App uninstall is therefore revoked on the next sync.

`GITHUB_CLONE_TOKEN` is the worker's temporary private-repository credential until installation tokens replace it. Use a fine-grained read-only token for Contents, Issues, Pull requests, and Metadata. Deployments and Actions access is optional enrichment; required source failures still fail closed.

The production context graph uses the `jina-openrouter-api-key` secret with:

```text
CONTEXT_GRAPH_CODEX_PROVIDER=openrouter
CONTEXT_GRAPH_CODEX_MODEL=deepseek/deepseek-v4-flash
```

The worker advertises a 16,000-token context and compacts at 12,000. Transient provider stream, timeout, rate-limit, 5xx, and Daytona transport failures retry once within the same checkout. Validation and schema errors are terminal.

Workers receive pipe-separated `WORKER_TOPICS`; commas are reserved by the Cloud Run CLI. Services keep one minimum instance with CPU allocated, poll continuously, and renew five-minute leases. The durable lease, not process identity, is the source of truth.

## Context graph retry and cache behavior

Canonical observations, exact commit trees, first-parent changes, blob analyses, source facts, and model-output proposals survive retries. The worker stops commit traversal at known parents. Unchanged heads reuse parsed blobs and exact-fingerprint assertion generations. A generator-contract change performs one bounded semantic refresh and then returns to cached execution.

Manifest, search, reconciliation, and graph consumers own separate canonical outbox deliveries. Events are acknowledged only after the affected projection succeeds; global identity/redirect changes fan out to affected repositories. Historical graph lists load summaries, not every node and edge.

## CI and verification

Pull-request CI runs:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm audit --prod --audit-level=high
docker build -f apps/api/Dockerfile .
docker build -f apps/worker/Dockerfile .
docker build -f apps/dashboard/Dockerfile .
```

After deployment, the workflow checks API health, worker connectivity, dashboard IAP, and the IAP policy. The `jina-acceptance` job receives the internal credential directly from Secret Manager and runs the private fixture repository through the three-stage context graph workflow.

Acceptance requires terminal success, no lingering blocked work, a nonempty cited graph at the requested commit, fixed-template and causal retrieval, reviewed causal assertions in the projection, and empty canonical-outbox/parser backlogs. It also exercises the unchanged-head cache path and rejects stale attempts. The request key includes the GitHub run attempt so an operator can rerun a failed release without colliding with the prior task.

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

## Post-rename cutover runbook

The `ontology` to `context graph` rename shipped with the repository, but some resources are configured outside this repository and must be cut over manually:

1. **Database roles.** Run `pnpm --filter @jina/db migrate -- --install-roles` (with a `CREATEROLE` administrator) to create the `jina_context_graph_*` roles. Re-point any Secret Manager entries or service login credentials that still authenticate as the old `jina_ontology_*` role names to the new roles, verify the services reconnect, and then drop the old `jina_ontology_*` roles.
2. **Acceptance fixture repository.** Rename the GitHub repository `omxyz/jina-ontology-e2e` to `omxyz/jina-context-graph-e2e`, then update the default repository in `apps/worker/src/acceptance.ts` (`runProductionContextGraphAcceptance`) to the new name. Until both steps happen together, the acceptance job must keep the pre-rename default.
3. **Externally set environment variables.** Any `ONTOLOGY_*` variables configured outside this repository (Cloud Run overrides, local `.env` files, operator shells) must be recreated under their `CONTEXT_GRAPH_*` names. Known families: `CONTEXT_GRAPH_CODEX_*`, `CONTEXT_GRAPH_FOCUS_BUNDLE_*`, `CONTEXT_GRAPH_HISTORY_LIMIT`, `CONTEXT_GRAPH_ASSERTION_FOCUS_LIMIT`, and `CONTEXT_GRAPH_GITHUB_PR_CONCURRENCY`. The old `ONTOLOGY_*` names are no longer read.
4. **CI log access.** Grant `roles/logging.viewer` to `github-deployer@jina-v2.iam.gserviceaccount.com` so the deploy workflow can read the acceptance job's logs; until then CI reports only the mapped acceptance exit-code category.
5. **Old worker service.** No action needed: the deploy pipeline now deletes the retired `jina-ontology-worker` Cloud Run service automatically after the renamed worker passes its health check.

## Useful checks

```sh
gcloud run services list --project=jina-v2 --region=us-central1
gcloud run services describe jina-dashboard --project=jina-v2 --region=us-central1 --format=json
```

Structured logging, trace correlation, metrics, and the recommended Cloud
Monitoring dashboards and alerts are documented in
[OBSERVABILITY.md](OBSERVABILITY.md).
