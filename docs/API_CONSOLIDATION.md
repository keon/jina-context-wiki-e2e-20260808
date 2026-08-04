# Unified API architecture

Jina has one public API service and one customer dashboard. The customer-facing
entry points are:

- `https://api.usejina.com` for API, webhook, Context, causal-graph, worker, and MCP traffic.
- `https://app.usejina.com` for the dashboard, whose browser requests are proxied through `/api`.
- `https://mcp.usejina.com/mcp` for MCP clients.

Staging uses the equivalent `*.staging.usejina.com` domains and isolated cloud
resources, secrets, GitHub App, Clerk instance, database credentials, and
deployment configuration.

## Source ownership

- `apps/api` owns the only HTTP listener. Dashboard and review routes live under
  `apps/api/src/product`; Context, causal graph, MCP, and worker routes share the
  same server and deployment image.
- `apps/dashboard` is the only customer dashboard application. Browser calls use
  `/api/dashboard/*`; the Next.js proxy forwards those requests to the unified API
  without exposing service credentials.
- `apps/worker` runs Context and causal-graph Board work.
- `services/review-trigger` contains the Trigger.dev review orchestration and
  Daytona runtime.
- `apps/api/product-migrations` contains the product schema migrations. Context
  schema definitions remain in `packages/db`; one v2 migration job applies both
  sets against the same database before the API is deployed.

There is no deployable legacy API or dashboard package and no `/v1/dashboard`
route surface. The compatibility boundary is internal: the dashboard/review
handler and Context handler are composed behind the same listener and use the
same v2 runtime database identity. Context still activates narrowly scoped
capability roles per transaction, and worker credentials remain independently
scoped.

## Request routing

The unified listener routes these public families:

- `/dashboard/*` — Clerk-authenticated dashboard data and mutations.
- `/webhooks/github` — the GitHub App webhook and review admission.
- `/context/*` — Context builds, catalog, search, and releases.
- `/causal-graph*` — causal-graph builds and published graph queries.
- `/mcp` — repository-scoped MCP.
- `/internal/*` — authenticated worker and service coordination.
- `/health` — service health.

The review webhook passes the original signed provider delivery to Context only
for events that can change derived repository knowledge: branch pushes, pull
request open/synchronize events, and newly opened issues. Manual review comments
start review work but do not implicitly rebuild Context or a causal graph.

## Deployment rule

Deploy the API and worker image together, run both migration sets, verify the
unified health endpoint, and then deploy the dashboard. Staging deployment uses
`scripts/deploy-staging.sh`. Production changes require the coordinated release
workflow and are never inferred from a staging deployment.
