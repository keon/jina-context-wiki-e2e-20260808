# GitHub App webhook setup

Jina accepts GitHub App webhook deliveries at `POST /webhooks/github`. The endpoint
verifies the unmodified body with `X-Hub-Signature-256`, requires
`X-GitHub-Delivery` for durable idempotency, and reads the event from
`X-GitHub-Event`.

## Current behavior

| Event           | Action                  | Board result                                                                                                                                                                             |
| --------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push            | non-deleted branch head | Creates `build-context` with strict `ingest-evidence` → baseline `index-context` → required `derive-knowledge` with enriched publication; carries the event head SHA and installation ID |
| Pull request    | `opened`                | Creates the review aggregate, review pass, and internal publication task                                                                                                                 |
| Pull request    | `synchronize`           | Supersedes the prior head epoch and creates review work for the new head                                                                                                                 |
| Issues          | `opened`                | Creates one manual `issue_triage` card                                                                                                                                                   |
| Everything else | any                     | Acknowledged and ignored                                                                                                                                                                 |

An unchanged latest head deduplicates redelivery. A real ref transition supersedes active
older context work, including a force-push back to a previously seen SHA. At ingestion,
the event head is also compared with a freshly fetched authoritative remote branch head;
a moved ref rejects the stale delivery instead of indexing its historical commit as
current. Issue triage has no automatic runner and remains in `triage` until a user acts.

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
Workers carry that resolved tenant and the installation ID in context-build metadata.

Configure the context worker with the App identity:

```text
GITHUB_APP_ID=<numeric app ID>
GITHUB_APP_PRIVATE_KEY=<PEM private key; literal \n escapes are accepted>
```

When `ingest-evidence` starts, the worker exchanges a short-lived App JWT for an
installation access token. It uses that token for both the exact Git checkout and bounded
GitHub REST pagination, keeps it only in the active lease, and never stores it in task or
context data. Git uses a full blob-filtered clone rather than a shallow clone, explicitly
fetches the branch to its remote-tracking ref, requires the fetched head to equal any
event-supplied SHA, and checks out that fetched head detached. The worker persists bounded
commit/parent history, including changed paths for the checkpoint commit, and paginates
repository metadata, PRs, issues, issue comments, PR review comments, and commit
discussion comments. These become citable inputs to the checkpoint-pinned
`derive-knowledge` agent. Reaching a configured limit or receiving an optional-source
403/404 records a `partial` checkpoint and exact omission reason. If an installation ID
is present and token minting fails, ingestion fails closed.

Trusted manual callers may include a positive `githubInstallationId` in
`POST /context/build`. A build with no installation ID falls back to
`GITHUB_API_TOKEN`, then `GITHUB_CLONE_TOKEN`, when configured; public repositories need
neither. Keep any fallback token fine-grained, read-only, and limited to the required
repositories. Jina does not currently publish review comments or checks.

GitHub documents [App registration](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app)
and [webhook configuration](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps).

## Repository access synchronization

Context retrieval is independent of webhook installation visibility. A trusted server
uses `INTERNAL_API_TOKEN` to synchronize the repository set for the server-side
`JINA_CONTEXT_TENANT_ID`/`JINA_CONTEXT_PRINCIPAL_ID` binding:

```sh
curl -X POST "${JINA_API_URL}/internal/context/access/sync" \
  -H "Authorization: Bearer ${INTERNAL_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"repositories":["owner/repository"],"mode":"merge"}'
```

`mode:"merge"` unions the submitted repositories with the principal's existing set and is
used by production acceptance so the fixture grant cannot erase unrelated access.
Tenant/principal headers may repeat the configured binding but cannot select another
identity.
The union is a store-level transaction: PostgreSQL acquires the same
tenant/principal advisory lock used by replacement, reads the current grants, and writes
the union before releasing the lock. Concurrent merge/replace requests therefore
serialize instead of racing between an API read and write: concurrent merges retain both
grant sets, while a serialized replacement can still intentionally revoke omitted
repositories.
`mode:"replace"` is the default and replaces the complete set; an empty replacement
revokes all context access for that principal. Each granted repository resolves to its
deterministic repository ACL fingerprint, which is later used to filter projection rows
in PostgreSQL before retrieval. The context query bearer cannot call this route.

## Verify delivery

Push a branch or open an issue or pull request, then inspect authenticated state:

```sh
curl -H "Authorization: Bearer ${INTERNAL_API_TOKEN}" \
  -H "X-Jina-Principal-Id: user:operator@example.com" \
  "${JINA_API_URL}/board"
```

For a push, verify that the root and all three context stages refer to the expected
repository/ref, that the ingest stage carries the expected GitHub installation ID, and
that ingestion records the event's full head SHA only if it still matches the fetched
remote head. A published generation returned by `/context/generations` must use that same
commit. The knowledge catalog should include an agent-derived change summary cited to the
checkpoint commit and changed paths when the evidence supports one.

GitHub's App settings show delivery response status and support redelivery.

## Local demo and persistence

`pnpm --filter @jina/api dev` can expose `POST /dev/webhooks/github` when
`JINA_ENABLE_DEV_ENDPOINTS=true`. It is unsigned and must stay disabled in production.

Development without database variables uses memory stores. Production records the board
snapshot in `jina_runtime.api_state`, delivery IDs in
`jina_runtime.github_deliveries`, and context state in `jina_context`.
