# @jina/admin

Next.js admin app that shows **every** generated context graph across all repositories in the tenant, without repository-ACL scoping.

## How it sees all graphs

The app calls the Jina API from the server only (`lib/jina-api.ts`) using `INTERNAL_API_TOKEN` and no forwarded `x-jina-principal-id`. The API authenticates such requests as the `svc:api` principal, which is a tenant administrator, and tenant-admin repository resolution returns every repository that has graph data. The token is never sent to the browser.

## Authentication boundary

Because the app renders tenant-wide graph data as the tenant-admin service principal, **the app itself is the security boundary**. `proxy.ts` accepts either of the two configured production boundaries:

- Google Cloud: a request must carry a valid IAP identity (`x-goog-authenticated-user-email`) or it receives `401`.
- Vercel: a request must carry valid HTTP credentials matching the server-only `JINA_WEB_AUTH_USERNAME` and `JINA_WEB_AUTH_PASSWORD` values.
- If `JINA_ADMIN_ALLOWED_EMAILS` is set, the IAP identity must appear in that allowlist or it receives `403`.
- When `INTERNAL_API_TOKEN` is unset (local `pnpm dev`, CI), the app is not internet-reachable and requests pass through, matching the dashboard.

The decision logic lives in `lib/admin-auth.ts` and is covered by `lib/admin-auth.test.ts`.

## Pages

- `/` — every graph (all repositories), with per-repository filtering and aggregate stats.
- `/graphs/:id` — full graph detail: metadata, cited repository queries, an interactive force-directed node/edge visualization, and node/relationship inspection.

## Running

```sh
pnpm --filter @jina/admin dev      # http://localhost:3100
```

Environment:

- `JINA_API_URL` — base URL of the Jina API (default `http://localhost:4000`).
- `INTERNAL_API_TOKEN` — required against a production API; optional locally when the API runs with dev endpoints enabled (`pnpm dev`), where every request is already treated as a dev service principal. Its presence also switches on the inbound IAP authentication boundary described above.
- `JINA_TENANT_ID` — original tenant UUID forwarded to a shared-database API; omit it for fixed-tenancy or local deployments.
- `JINA_ADMIN_ALLOWED_EMAILS` — optional comma-separated allowlist of IAP identities permitted to view graphs. When unset, any IAP-authenticated identity is allowed.
- `JINA_WEB_AUTH_USERNAME` / `JINA_WEB_AUTH_PASSWORD` — app-level HTTP credentials for Vercel production.
