# @jina/admin

Next.js admin app that shows **every** generated context graph across all repositories in the tenant, without repository-ACL scoping.

## How it sees all graphs

The app calls the Jina API from the server only (`lib/jina-api.ts`) using `INTERNAL_API_TOKEN` and no forwarded `x-jina-principal-id`. The API authenticates such requests as the `svc:api` principal, which is a tenant administrator, and tenant-admin repository resolution returns every repository that has graph data. The token is never sent to the browser.

## Authentication boundary

Because the app renders tenant-wide graph data as the tenant-admin service principal, **the app itself is the security boundary** — it must only be reached through the identity-aware proxy (Google IAP), exactly like the dashboard. `middleware.ts` enforces this on every route:

- When `INTERNAL_API_TOKEN` is set (production), a request must carry a valid IAP identity (`x-goog-authenticated-user-email`) or it receives `401`.
- If `JINA_ADMIN_ALLOWED_EMAILS` is set, the IAP identity must appear in that allowlist or it receives `403`.
- When `INTERNAL_API_TOKEN` is unset (local `pnpm dev`, CI), the app is not internet-reachable and requests pass through, matching the dashboard.

The decision logic lives in `lib/admin-auth.ts` and is covered by `lib/admin-auth.test.ts`.

## Pages

- `/` — every graph (all repositories), with per-repository filtering and aggregate stats.
- `/graphs/:id` — full graph detail: metadata, an interactive force-directed node/edge visualization, and per-node relationship inspection.

## Running

```sh
pnpm --filter @jina/admin dev      # http://localhost:3100
```

Environment:

- `JINA_API_URL` — base URL of the Jina API (default `http://localhost:4000`).
- `INTERNAL_API_TOKEN` — required against a production API; optional locally when the API runs with dev endpoints enabled (`pnpm dev`), where every request is already treated as a dev service principal. Its presence also switches on the inbound IAP authentication boundary described above.
- `JINA_ADMIN_ALLOWED_EMAILS` — optional comma-separated allowlist of IAP identities permitted to view graphs. When unset, any IAP-authenticated identity is allowed.
