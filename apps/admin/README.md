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
`JINA_WEB_AUTH_PASSWORD`. Caller-supplied identity headers are ignored. The service is
deployed `--allow-unauthenticated`, so this Basic-auth path is the only thing between the
internet and tenant-wide context.

The gate keys off those web credentials and nothing else, and it fails closed:

- Both credentials configured — Basic authentication is enforced on every route.
- Either one missing while the other is set — every request is refused with 503; a
  half-configured deployment is always a mistake.
- Neither configured — refused with 503, except under `pnpm dev`. `NODE_ENV` is inlined at
  build time, so that escape hatch does not exist in a deployed image and cannot be turned
  back on with an environment variable.

Dropping an unrelated credential such as `INTERNAL_API_TOKEN` therefore cannot disable
inbound authentication.

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

Because this is a monitoring page, a read that fails is never rendered as a healthy zero:
a failed section shows an alert naming the heading, counts it could not measure show `—`
rather than `0`, and a section skipped because a dependency failed says so. Long tables are
capped (100 releases, 50 builds, 100 documents) and every table states its visible count
against the total plus its ordering. Individual malformed rows from the API are dropped and
logged rather than taking their whole section down.

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

The admin uses `/wiki/releases`, `/wiki/list`, `/wiki/builds`,
`/wiki/builds/{id}/progress`, and `/wiki/metrics`. Metrics access is
tenant-administrator only.
