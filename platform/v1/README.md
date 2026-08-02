# Jina Code Review

Jina is a multi-tenant GitHub App code review service. It listens for pull request events, runs review workers in Daytona sandboxes, publishes progress and PR review feedback on GitHub, and stores review state for the dashboard.

## Documentation

- [Architecture](./docs/ARCHITECTURE.md)
- [Deployment](./docs/DEPLOYMENT.md)
- [Manual `@usejina` reviews](./docs/MANUAL_REVIEWS.md)
- [OpenRouter and Autumn billing design](./docs/BILLING_OPENROUTER_AUTUMN.md)
- [Jina repository instructions](./docs/JINA_INSTRUCTIONS.md)
- [Scenario evals](./evals/README.md)

## Repository Layout

| Path | Purpose |
| --- | --- |
| `api/` | Webhooks, dashboard APIs, auth, persistence, and Trigger.dev dispatch. |
| `trigger/` | Trigger.dev tasks for PR review, installation backfill, scheduled scans, Daytona orchestration, and GitHub output. |
| `dashboard/` | Next.js dashboard for reviews, findings, historical scenario detail, and integrations. |
| `migrations/` | Postgres schema migrations. |
| `evals/` | Offline evaluation tooling. |
| `docs/` | Architecture and deployment docs. |

## Local Setup

Copy the root environment example:

```bash
cp .env.example .env
```

Fill the core local values:

- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_APP_SLUG` or `GITHUB_APP_INSTALL_URL`
- `GITHUB_APP_PRIVATE_KEY`
- `INTERNAL_API_TOKEN`
- `TRIGGER_SECRET_KEY`
- `TRIGGER_PROJECT_REF`
- `API_BASE_URL`
- `DASHBOARD_URL`
- `DAYTONA_API_KEY`
- `OPENAI_API_KEY`
- `DATABASE_URL` for full webhook, dashboard, and review persistence flows

Export values before running local services:

```bash
set -a
source .env
set +a
```

For authenticated dashboards, create a GitHub OAuth App and set:

- `DASHBOARD_AUTH_MODE=github`
- `GITHUB_OAUTH_CLIENT_ID`
- `GITHUB_OAUTH_CLIENT_SECRET`
- `GITHUB_OAUTH_SCOPES=read:user read:org repo`

Use the API origin as the OAuth callback:

```text
http://localhost:8080/auth/github/callback
```

Apply database migrations when `DATABASE_URL` is configured:

```bash
cd api
npm install
npm run migrate
```

Run the API:

```bash
cd api
npm install
npm run dev
```

Run Trigger.dev tasks locally:

```bash
cd trigger
npm install
npm run dev
```

Run the dashboard:

```bash
cd dashboard
npm install
cp .env.example .env.local
npm run dev
```

The dashboard runs on `http://localhost:3000` by default. Set `NEXT_PUBLIC_API_BASE_URL` in `dashboard/.env.local` when the API is not on `http://localhost:8080`.

To enable the dashboard's **Graph** page, configure `JINA_GRAPH_API_URL` and
`JINA_GRAPH_API_TOKEN` on the API service. The browser calls only this repo's
tenant-scoped dashboard API; service credentials remain server-side. GitHub sends
webhooks only to this API. After verification, it relays the exact signed delivery
to V2's Context-only endpoint; comments and review completion never start builds.

Context and CodeGraph are separate inputs. CodeGraph is the local CLI index built
inside the review checkout. Context is V2's cited derived engineering documentation.
The dashboard reads V2 releases, document trees, and documents. Review sandboxes
connect directly to V2 MCP with a short-lived token scoped to one tenant, review,
and repository; V1 does not proxy MCP.

Codex can use the LLM-less `search_context`, `list_context`, `read_context`, and
`diff_context` tools. Telemetry records only tool names and outcomes, never Context
response bodies. Repositories without a published release receive no Context MCP
configuration. Context attachment defaults on. Set
`JINA_GRAPH_MCP_ENABLED=false` on Trigger.dev only as an emergency kill switch.

## Common Commands

API:

```bash
cd api
npm run typecheck
npm test
npm run build
```

Trigger workers:

```bash
cd trigger
npm run typecheck
npm run deploy
```

Dashboard:

```bash
cd dashboard
npm run build
```

## Local GitHub Webhooks

Expose the API with a tunnel, then configure the GitHub App webhook URL:

```text
https://your-tunnel.example.com/webhooks/github
```

With ngrok running, sync the current tunnel URL automatically:

```bash
cd api
npm run sync:webhook
```

Set `WEBHOOK_PUBLIC_URL` if you use a stable tunnel or deployed API URL.

## Review Flow

Normal PR reviews use the Trigger task `review`, which starts `review-summary` and `review-runtime` child tasks. The current flow does not create a GitHub check run and does not run static review, scenario generation, scenario simulation, or scenario reruns.

To request a review manually, include a standalone `@usejina` mention anywhere
in a new PR comment. The remaining Markdown becomes preferences and scope for
that run. If several comments request reviews, only the newest command is
worked. Replying inside a Jina-generated finding keeps the review scoped to that
issue. See [Manual PR Reviews](./docs/MANUAL_REVIEWS.md).

PR review dispatch is intentionally disabled by default and controlled in code:

- `reviewTaskTriggerControl.enabled` in `api/src/review-task-routing.ts`
- `reviewTaskTriggerControl.allowedRepositories`, currently only `omxyz/jina-simulation`
- `false`: PR review webhooks are accepted but do not dispatch Trigger review runs, except for allowlisted repositories.
- `true`: accepted PR review webhooks trigger `review`.

## Deployment

Production deployment is split across Cloud Run for the API, Trigger.dev for workers, and Vercel or another Next.js host for the dashboard. See [Deployment](./docs/DEPLOYMENT.md).
