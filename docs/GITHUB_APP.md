# GitHub App Webhook Setup

Jina can accept real GitHub App webhook deliveries at `POST /webhooks/github`. The endpoint verifies the raw body with `X-Hub-Signature-256`, requires `X-GitHub-Delivery` for idempotency, and reads the event type from `X-GitHub-Event`.

Production currently sets `JINA_GITHUB_WEBHOOK_ENABLED=false` and does not mount `GITHUB_WEBHOOK_SECRET`. The original Jina application is the sole GitHub webhook consumer and calls `POST /context-graph/build` after accepting a review. Disabled v2 intake returns `202` without creating work, avoiding GitHub redelivery noise. Keep the signed route for local development and rollback only.

## Behavior when enabled

| GitHub event    | Action                  | Board result                                                                                                                                                                   |
| --------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Push            | non-deleted branch head | Creates the existing `context_graph_build`/ingest/assert/project tree; an unchanged latest head deduplicates redelivery, while every real ref transition supersedes stale work |
| Pull request    | `opened`                | Creates the existing root review, review-pass, and publication tasks                                                                                                           |
| Pull request    | `synchronize`           | Supersedes the old head epoch and creates the next review task graph                                                                                                           |
| Issues          | `opened`                | Creates one manual `issue_triage` card                                                                                                                                         |
| Everything else | Any                     | Acknowledged and ignored                                                                                                                                                       |

Issue triage deliberately has no automatic agent runner yet. It stays in `triage` until a user acts on it.

## 1. Configure the server

Generate a high-entropy webhook secret and store it in your secret manager:

```sh
openssl rand -hex 32
export GITHUB_WEBHOOK_SECRET='<generated value>'
pnpm --filter @jina/api build
pnpm --filter @jina/api start
```

The API listens on port `4000` by default. Confirm the webhook is configured:

```sh
curl http://localhost:4000/healthz
```

The response should include `"githubWebhookConfigured": true`.

The endpoint must be reachable over public HTTPS for GitHub delivery. A development tunnel is fine for local testing; use a normal application host in production.

## 2. Register the GitHub App

Create a private GitHub App under the account or organization that owns the repositories:

- Webhook URL: `https://<your-host>/webhooks/github`
- Webhook secret: the exact value in `GITHUB_WEBHOOK_SECRET`
- Repository permission: **Pull requests — Read-only**
- Repository permission: **Issues — Read-only**
- Repository permission: **Contents — Read-only**
- Repository permission for deployment-aware context graphs: **Deployments — Read-only**
- Optional repository permission: **Actions — Read-only**
- Subscribe to events: **Push**, **Pull request**, and **Issues**

Install the App on the repositories Jina should watch. In production shared mode, the original Jina database must already contain the enabled repository, its tenant, and a non-suspended installation. The signed delivery is resolved against those records; an unknown, disabled, suspended, or mismatched repository is rejected instead of receiving a synthetic tenant. Local development and rollback can use fixed mode with `JINA_TENANT_ID`.

When intake is enabled, the resolved original tenant UUID scopes every task created by the delivery. In the current production path, the original application sends the same UUID and verified repository/review identity as server-side graph-build metadata. Both paths retain the original tenant's GitHub account login plus the webhook author's and sender's GitHub IDs, logins, and account types.

The API webhook slice needs only the webhook secret. Context graph workers also receive `GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY`; they exchange the installation ID persisted on each build for a short-lived token used by
REST metadata, local git, and Daytona cloning. Legacy non-graph review tasks may still use `GITHUB_API_TOKEN` and
`GITHUB_CLONE_TOKEN` until that workflow is migrated separately.

GitHub documents the registration flow in [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app) and the event setup in [Using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps).

## 3. Verify delivery

Push a branch, or open an issue or pull request in an installed repository, then inspect:

```sh
curl http://localhost:4000/board
curl http://localhost:4000/events
```

Production read endpoints require `Authorization: Bearer <INTERNAL_API_TOKEN>`. Shared-mode callers also send `x-jina-tenant-id: <original-tenant-uuid>`; a forwarded `tenant:<uuid>` principal must match it. The signed webhook endpoint resolves its own tenant and does not accept a caller-supplied tenant override. Browsers should use the authenticated dashboard rather than calling the API credential directly.

GitHub's App settings also show every delivery, response status, and redelivery control.

## Local demo endpoint

`pnpm --filter @jina/api dev` enables `POST /dev/webhooks/github`, seeds a demo PR, and simulates task runs for the local dashboard. This unsigned endpoint is separate from the real webhook endpoint and is disabled by `pnpm --filter @jina/api start`.

## Persistence boundary

Development without database variables uses in-memory stores. Production uses PostgreSQL: the board snapshot is stored in `jina_runtime.api_state`, and `github_deliveries.delivery_id` provides durable webhook deduplication. Delivery insertion, loading the latest board state, command application, and snapshot persistence occur under one transaction lock, so acknowledged tasks survive API restarts and concurrent API instances cannot overwrite one another.
