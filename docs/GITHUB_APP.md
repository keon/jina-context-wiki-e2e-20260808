# GitHub App Webhook Setup

Jina accepts real GitHub App webhook deliveries at `POST /webhooks/github`. The endpoint verifies the raw body with `X-Hub-Signature-256`, requires `X-GitHub-Delivery` for idempotency, and reads the event type from `X-GitHub-Event`.

## Current behavior

| GitHub event | Action | Board result |
| --- | --- | --- |
| Pull request | `opened` | Creates the existing root review, review-pass, and publication tasks |
| Pull request | `synchronize` | Supersedes the old head epoch and creates the next review task graph |
| Issues | `opened` | Creates one manual `issue_triage` card |
| Everything else | Any | Acknowledged and ignored |

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
- Subscribe to events: **Pull request** and **Issues**

Install the App on the repositories Jina should watch. GitHub App webhook payloads include the installation ID; unless `JINA_TENANT_ID` is set, Jina uses `github:installation:<id>` as the intake tenant key.

This inbound-only slice does not use the App ID or private key. Those become necessary when Jina starts making authenticated GitHub API calls as the bot, such as publishing review comments or checks.

GitHub documents the registration flow in [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app) and the event setup in [Using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps).

## 3. Verify delivery

Open an issue or pull request in an installed repository, then inspect:

```sh
curl http://localhost:4000/board
curl http://localhost:4000/events
```

GitHub's App settings also show every delivery, response status, and redelivery control.

## Local demo endpoint

`pnpm --filter @jina/api dev` enables `POST /dev/webhooks/github`, seeds a demo PR, and simulates task runs for the local dashboard. This unsigned endpoint is separate from the real webhook endpoint and is disabled by `pnpm --filter @jina/api start`.

## Persistence boundary

The current API process keeps board state and delivery IDs in memory, matching the rest of the development runtime. Signed GitHub delivery is real, but tasks do not survive an API restart yet. Before production deployment, move the board and the unique GitHub delivery ID into the planned Postgres transaction; the webhook contract and intake mapping can remain unchanged.
