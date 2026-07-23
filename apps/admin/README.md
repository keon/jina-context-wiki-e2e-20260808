# @jina/admin

Next.js admin app that shows the current graph head for **every** repository across **every tenant**, without repository-ACL scoping.

## How it sees all graphs

The app calls the Jina API from the server only (`lib/jina-api.ts`). Its index uses the read-only `JINA_GLOBAL_ADMIN_TOKEN` to fetch graph-head summaries directly across all graph tenants. Opening or querying a graph switches back to `INTERNAL_API_TOKEN` and forwards that graph's `tenantId`, preserving the existing tenant-scoped authorization path. Neither token is sent to the browser.

When `JINA_GLOBAL_ADMIN_TOKEN` is absent, local and legacy deployments fall back to the original `JINA_TENANT_ID`-scoped index.

## Authentication boundary

Because the app renders cross-tenant graph data, **the app itself is the security boundary**. `proxy.ts` accepts either of the two configured production boundaries:

- Google Cloud: a request must carry a valid IAP identity (`x-goog-authenticated-user-email`) or it receives `401`.
- Vercel: a request must carry valid HTTP credentials matching the server-only `JINA_WEB_AUTH_USERNAME` and `JINA_WEB_AUTH_PASSWORD` values.
- If `JINA_ADMIN_ALLOWED_EMAILS` is set, the IAP identity must appear in that allowlist or it receives `403`.
- When both API credentials are unset (local `pnpm dev`, CI), the app is not internet-reachable and requests pass through, matching the dashboard.

The decision logic lives in `lib/admin-auth.ts` and is covered by `lib/admin-auth.test.ts`.

## Pages

- `/` — every current graph head (all tenants and repositories), with per-repository filtering and aggregate stats.
- `/graphs/:id` — full graph detail: metadata, cited repository queries, an interactive force-directed node/edge visualization, and node/relationship inspection.

## Running

```sh
pnpm --filter @jina/admin dev      # http://localhost:3100
```

Environment:

- `JINA_API_URL` — base URL of the Jina API (default `http://localhost:4000`).
- `JINA_GLOBAL_ADMIN_TOKEN` — dedicated read-only credential for the production cross-tenant graph-head index. It must differ from `INTERNAL_API_TOKEN`.
- `INTERNAL_API_TOKEN` — required against a production API for tenant-scoped graph reads and queries; optional locally when the API runs with dev endpoints enabled (`pnpm dev`), where every request is already treated as a dev service principal. Its presence also switches on the inbound IAP authentication boundary described above.
- `JINA_TENANT_ID` — optional original tenant UUID used only by the legacy/local listing fallback and direct links without a tenant query parameter.
- `JINA_ADMIN_ALLOWED_EMAILS` — optional comma-separated allowlist of IAP identities permitted to view graphs. When unset, any IAP-authenticated identity is allowed.
- `JINA_WEB_AUTH_USERNAME` / `JINA_WEB_AUTH_PASSWORD` — app-level HTTP credentials for Vercel production.
