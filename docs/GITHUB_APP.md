# GitHub App Webhook Setup

Jina accepts real GitHub App webhook deliveries at `POST /webhooks/github`. The endpoint verifies the raw body with `X-Hub-Signature-256`, requires `X-GitHub-Delivery` for idempotency, and reads the event type from `X-GitHub-Event`.

## Current behavior

| GitHub event    | Action                  | Board result                                                                                                                                                              |
| --------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push            | non-deleted branch head | Creates the existing `ontology_build`/ingest/assert/project tree; an unchanged latest head deduplicates redelivery, while every real ref transition supersedes stale work |
| Pull request    | `opened`                | Creates the existing root review, review-pass, and publication tasks                                                                                                      |
| Pull request    | `synchronize`           | Supersedes the old head epoch and creates the next review task graph                                                                                                      |
| Issues          | `opened`                | Creates one manual `issue_triage` card                                                                                                                                    |
| Everything else | Any                     | Acknowledged and ignored                                                                                                                                                  |

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
- Optional repository permission: **Deployments — Read-only**
- Optional repository permission: **Actions — Read-only**
- Subscribe to events: **Push**, **Pull request**, and **Issues**

Install the App on the repositories Jina should watch. Local development can derive `github:installation:<id>` from the payload. Production sets the canonical `JINA_TENANT_ID=omlabs`; configured aliases are migrated at API startup so historical tasks remain visible.

The webhook slice does not use an App ID or private key. The current review worker uses `GITHUB_CLONE_TOKEN` to read PR metadata and diffs. External review comments/checks are not published yet; a GitHub App installation-token flow is still required before that side effect ships.

GitHub documents the registration flow in [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app) and the event setup in [Using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps).

## 3. Verify delivery

Push a branch, or open an issue or pull request in an installed repository, then inspect:

```sh
curl http://localhost:4000/board
curl http://localhost:4000/events
```

Production read endpoints require `Authorization: Bearer <INTERNAL_API_TOKEN>` and always use the configured tenant. Browsers should use the IAP-protected dashboard rather than calling the API credential directly.

GitHub's App settings also show every delivery, response status, and redelivery control.

## Local demo endpoint

`pnpm --filter @jina/api dev` enables `POST /dev/webhooks/github`, seeds a demo PR, and simulates task runs for the local dashboard. This unsigned endpoint is separate from the real webhook endpoint and is disabled by `pnpm --filter @jina/api start`.

## Persistence boundary

Development without database variables uses in-memory stores. Production uses PostgreSQL: the board snapshot is stored in `jina_runtime.api_state`, and `github_deliveries.delivery_id` provides durable webhook deduplication. Delivery insertion, loading the latest board state, command application, and snapshot persistence occur under one transaction lock, so acknowledged tasks survive API restarts and concurrent API instances cannot overwrite one another.
