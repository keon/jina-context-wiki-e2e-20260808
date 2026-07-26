# GitHub App webhook setup

Jina accepts GitHub App webhook deliveries at `POST /webhooks/github`. The endpoint
verifies the unmodified body with `X-Hub-Signature-256`, requires
`X-GitHub-Delivery` for durable idempotency, and reads the event from
`X-GitHub-Event`.

## Current behavior

| Event           | Action                  | Board result                                                                                                                                              |
| --------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push            | non-deleted branch head | Creates `build-context` with `ingest-evidence`, `derive-knowledge`, and `index-context`; carries the event head SHA so the build is pinned to that commit |
| Pull request    | `opened`                | Creates the review aggregate, review pass, and internal publication task                                                                                  |
| Pull request    | `synchronize`           | Supersedes the prior head epoch and creates review work for the new head                                                                                  |
| Issues          | `opened`                | Creates one manual `issue_triage` card                                                                                                                    |
| Everything else | any                     | Acknowledged and ignored                                                                                                                                  |

An unchanged latest head deduplicates redelivery. A real ref transition supersedes active
older context work, including a force-push back to a previously seen SHA. Issue triage has
no automatic runner and remains in `triage` until a user acts.

## Configure the server

Generate a high-entropy webhook secret and store it in Secret Manager:

```sh
openssl rand -hex 32
export GITHUB_WEBHOOK_SECRET='<generated value>'
pnpm --filter @jina/api build
pnpm --filter @jina/api start
```

The API listens on port 4000 by default. Confirm readiness:

```sh
curl http://localhost:4000/health
```

The endpoint must be reachable over public HTTPS. A development tunnel is suitable only
for local testing.

## Register the GitHub App

Create a private GitHub App under the account or organization that owns the repositories:

- Webhook URL: `https://<api-host>/webhooks/github`
- Webhook secret: the exact `GITHUB_WEBHOOK_SECRET`
- Repository permission: **Contents — Read-only**
- Repository permission: **Pull requests — Read-only**
- Repository permission: **Issues — Read-only**
- Optional repository permission: **Deployments — Read-only**
- Optional repository permission: **Actions — Read-only**
- Subscribe to **Push**, **Pull request**, and **Issues**

Install the App on every repository Jina should observe. In shared-database mode, webhook
intake resolves the original tenant UUID from the installation/repository identity tables.
Workers carry that resolved tenant on every API call.

The current worker uses `GITHUB_CLONE_TOKEN` for private Git clone and provider pagination.
Use a fine-grained read-only token limited to the installed repositories and the
permissions above. Installation-token minting should replace this temporary credential
before GitHub write-side effects are enabled. Jina does not currently publish review
comments or checks.

GitHub documents [App registration](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app)
and [webhook configuration](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps).

## Repository access synchronization

Context retrieval is independent of webhook installation visibility. A trusted server
uses `CONTEXT_API_TOKEN` plus a bound principal to replace that principal's complete
repository set:

```sh
curl -X POST "${JINA_API_URL}/internal/context/access/sync" \
  -H "Authorization: Bearer ${CONTEXT_API_TOKEN}" \
  -H "X-Jina-Principal-Id: tenant:<uuid>" \
  -H "X-Jina-Tenant-Id: <uuid>" \
  -H "Content-Type: application/json" \
  --data '{"repositories":["owner/repository"]}'
```

Sending an empty list revokes all context access for that principal. The credential is
server-only and does not grant board or worker access.

## Verify delivery

Push a branch or open an issue or pull request, then inspect authenticated state:

```sh
curl -H "Authorization: Bearer ${INTERNAL_API_TOKEN}" \
  -H "X-Jina-Principal-Id: user:operator@example.com" \
  "${JINA_API_URL}/board"
```

For a push, verify that the root and all three context stages refer to the expected
repository/ref and that ingestion records the event's full head SHA. A published
generation returned by `/context/generations` must use that same commit.

GitHub's App settings show delivery response status and support redelivery.

## Local demo and persistence

`pnpm --filter @jina/api dev` can expose `POST /dev/webhooks/github` when
`JINA_ENABLE_DEV_ENDPOINTS=true`. It is unsigned and must stay disabled in production.

Development without database variables uses memory stores. Production records the board
snapshot in `jina_runtime.api_state`, delivery IDs in
`jina_runtime.github_deliveries`, and context state in `jina_context`.
