# GitHub App webhook setup

The GitHub App sends deliveries to the unified Jina API at
`https://api.usejina.com/webhooks/github`. The review handler verifies and records the
delivery, then hands the exact raw body plus the three GitHub headers to the Context
handler at `POST /context/webhooks/github`. Context verifies `X-Hub-Signature-256` again, uses
`X-GitHub-Delivery` for durable idempotency, and admits only Context Board work. The relay
cannot manufacture provider events or create a second review.

Only `POST /webhooks/github` is configured on the GitHub App. The Context-specific
route is an internal handoff and is never a second public webhook target.

## Current behavior

| Event           | Action                  | Board result                                                                                              |
| --------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| Push            | non-deleted branch head | Starts a Board Context build fenced to the exact branch head                                              |
| Pull request    | `opened`                | Creates review work and a Board Context preview at `pull/<number>/head`                                   |
| Pull request    | `synchronize`           | Supersedes the prior review/head epoch and starts a new preview at the new head                           |
| Issues          | `opened`                | Creates manual triage and starts a Board Context build on the default branch so the new issue is evidence |
| Everything else | any                     | Acknowledged and ignored; comments, edits, closes, labels, and reviews do not schedule Context builds     |

The integrated `POST /context/webhooks/github` route produces only the Context result in
this table. The review handler owns all review tasks.

An unchanged latest head deduplicates redelivery. Pull-request heads supersede their
older previews immediately. A branch push replaces an unstarted build, but once the
default-ref build has invested work, later pushes and issues are coalesced as a durable
Board follow-up; only the newest commit is admitted after the active build finishes. This
lets a long first publication finish and makes the queued commit incremental instead of
discarding hours of verified checkpoints. At ingestion, the selected head is compared
with a freshly fetched authoritative remote branch head; a moved ref rejects stale work
instead of indexing a historical commit as current. Issue triage has no automatic runner
and remains in `triage` until a user acts; the separate context build is automatic.

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

Create a private GitHub App under the account or organization that owns the repositories.
For normal Context repositories, grant:

- Webhook URL in integrated production: `https://api.usejina.com/webhooks/github`
- Webhook secret: the exact `GITHUB_WEBHOOK_SECRET`
- Repository permission: **Contents — Read-only**
- Repository permission: **Pull requests — Read-only**
- Repository permission: **Issues — Read-only**
- Optional repository permission: **Deployments — Read-only**
- Optional repository permission: **Actions — Read-only**
- Subscribe to **Push**, **Pull request**, **Issues**, and **Issue comments**

Production trigger acceptance uses a second, isolated fixture-mutation App. That App
needs **Contents**, **Pull requests**, and **Issues** write access so the operator
harness can create and clean up its branch, marker commit, issue, comment, and unmerged
PR. Disable its webhook and install it only on `omxyz/jina-context-graph-e2e`; never
install it on an ordinary Context repository. The harness further downscopes every
fixture-App installation token to that exact repository and permission set.

The normal operational Context App remains installed on the fixture too. It keeps the
read-only permissions and event subscriptions above, receives the fixture App's
events, and is the only identity used to inventory and redeliver webhooks. Do not reuse
the operational App ID, private key, or installation as the mutation identity.

Install the App on every repository Jina should observe. In shared-database mode, webhook
intake resolves the original tenant UUID from the installation/repository identity tables.
Workers carry that resolved tenant and the installation ID in context-build metadata.

Configure the context worker with the App identity:

```text
GITHUB_APP_ID=<numeric app ID>
GITHUB_APP_PRIVATE_KEY=<PEM private key; literal \n escapes are accepted>
```

When `snapshot-context-input` starts, the worker exchanges a short-lived App JWT for an
installation access token. Every mint includes the exact build repository and only
**Contents**, **Pull requests**, **Issues**, and **Metadata** read access. The worker
validates the returned repository list and exact permission map before using the token;
a broad, mismatched, or underprivileged response fails closed. The fixture-mutation App
credentials are never mounted into snapshot workers. The worker uses its scoped
operational-App token for both the exact Git checkout and bounded
GitHub REST pagination, keeps it only in the active lease, and never stores it in task or
context data. Git uses a full blob-filtered clone rather than a shallow clone, explicitly
fetches the branch to its remote-tracking ref, requires the fetched head to equal any
event-supplied SHA, and checks out that fetched head detached. The worker persists bounded
commit/parent history, including changed paths for the checkpoint commit, and paginates
repository metadata, PRs, issues, issue comments, PR review comments, and commit
discussion comments. These become citable inputs to the checkpoint-pinned Board research,
planning, page-writing, and audit tasks. Commit records have natural
`https://github.com/<owner>/<repository>/commit/<sha>` citation targets even when no separate
provider observation supplies one. Reaching a configured limit or receiving an
optional-source 403/404 records a `partial` checkpoint and exact omission reason. If an
installation ID is present and token minting fails, snapshotting fails closed.

Comments are collected as evidence when a later supported trigger starts a snapshot. Their
delivery events do not start a Context build by themselves.
The Issue comments subscription is still required for production trigger acceptance:
the gate audits the exact delivered event and proves that the API persisted it without
admitting Board work. Without that subscription, absence of a build would not test the
no-trigger contract.

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

For a push, verify that the page-oriented Board root, snapshot, planner, page tasks, and
publication task refer to the expected repository/ref; that the snapshot task carries
the expected GitHub installation ID; and that it records the event's full head SHA only
if it still matches the fetched remote head. Publication includes PageIndex construction.
An immutable release returned by `/context/releases` must use that same commit. The
context catalog should include an agent-derived change summary cited to the checkpoint
commit and changed paths when the evidence supports one.

GitHub's App settings show delivery response status and support redelivery.

## Review access to Context

A review never receives either service credential. After resolving the shared tenant
UUID and exact repository, the review handler calls `POST /internal/context/review-access`
with its server-only Context credential. Context resolves the repository through shared identity,
creates a deterministic run-and-repository principal, replaces that principal's ACL with
exactly one repository, and returns a 5–360 minute opaque token with only
`context:query` and `context:read`.

The review sandbox connects directly to `/mcp` with that token and can use only
`search_context`, `list_context`, `read_context`, and `diff_context`. It cannot build,
administer, or read another repository. The review handler exposes no MCP proxy and stores no Context
response bodies in review telemetry.

## Local demo and persistence

`pnpm --filter @jina/api dev` can expose `POST /dev/webhooks/github` when
`JINA_ENABLE_DEV_ENDPOINTS=true`. It is unsigned and must stay disabled in production.
That flag does not need to weaken ordinary API authentication. Keep
`JINA_TRUST_DEV_IDENTITY_HEADERS=false` (the development-server default) to require the
configured bearer credentials on API, MCP, Board, and administration routes while still
using the unsigned webhook fixture. Set it to `true` only for an explicitly isolated test
that needs header-trusted identities; it is rejected unless development endpoints are also
enabled, and Cloud Run rejects development endpoints entirely.

Development without database variables uses memory stores. Production records the board
snapshot in `jina_runtime.api_state`, delivery IDs in
`jina_runtime.github_deliveries`, and context state in `jina_context`.
