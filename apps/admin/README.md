# @jina/admin

Next.js tenant-administration app for repository context health. It lists immutable
context releases across every repository in the tenant, summarizes derived context and
pending publication work, and exposes exact ref/commit state.

## Tenant-wide access

The app calls the Jina API only from server components in `lib/jina-api.ts` with
`INTERNAL_API_TOKEN`. No bearer credential reaches the browser. The API authenticates the
server caller as the tenant administrator and therefore returns all repositories in that
tenant rather than applying an end-user repository subset.

The app itself is a security boundary. In production, every request must provide HTTP
Basic credentials matching the server-only `JINA_WEB_AUTH_USERNAME` and
`JINA_WEB_AUTH_PASSWORD`. Caller-supplied identity headers are ignored. The coordinated
Cloud Run deployment exposes the app only through this Basic-auth path.

- When `INTERNAL_API_TOKEN` is unset for local development/CI, inbound checks are relaxed;
  this mode must not be internet-reachable.

The decision logic is in `lib/admin-auth.ts` and has unit tests.

## Page

`/` shows tenant-wide release, repository, current logical context-document, pending
publication, active-build, model-task, checkpoint, and hierarchy counts. Operators can
filter by repository and inspect each release's ref, full commit identity, publication
time, source completeness, and context availability.

The agent-derived context section reports document counts by kind and shows each current
document's repository, logical ID, commit, citation count, and immutable release.
The build section shows recent Board build state, retry counts, and private checkpoint
validity without exposing worker inputs or artifact layout. The index section reports the
latest immutable projector checkpoint, version, status, and backlog.

## Running

```sh
pnpm --filter @jina/admin dev
```

The app listens at `http://localhost:3100` by default.

Environment:

- `JINA_API_URL` — API base URL; defaults to `http://localhost:4000`.
- `INTERNAL_API_TOKEN` — server-side tenant-administrator credential.
- `JINA_WEB_PRINCIPAL_ID` — trusted principal forwarded to the API. Required with
  `INTERNAL_API_TOKEN` unless `JINA_TENANT_ID` supplies the binding.
- `JINA_TENANT_ID` — original tenant UUID forwarded to a shared-database API. When
  `JINA_WEB_PRINCIPAL_ID` is absent, the client binds as `tenant:<JINA_TENANT_ID>`.
  Fixed/local deployments may omit it only when `JINA_WEB_PRINCIPAL_ID` is set.
- `JINA_WEB_AUTH_USERNAME` / `JINA_WEB_AUTH_PASSWORD` — server-side HTTP credentials.

When `JINA_WEB_PRINCIPAL_ID` is a user principal, that principal must also be configured
as a tenant administrator by the API. The admin client fails before making a request when
`INTERNAL_API_TOKEN` is configured without either principal-binding variable.

The admin uses `/context/releases`, `/context/list`, `/context/builds`,
`/context/builds/{id}/progress`, and `/context/metrics`. Metrics access is
tenant-administrator only.
