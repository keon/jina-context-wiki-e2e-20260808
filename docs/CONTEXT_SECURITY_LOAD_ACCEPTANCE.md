# Context security and load acceptance

Use `scripts/context-security-load-e2e.mjs` as the retained local acceptance
gate after a Board build and its Context release have already completed. The
harness is intentionally a client: it does not start or restart API/worker
processes, enqueue a build, invoke a model, or call `search_context`. It refuses
non-loopback API URLs.

## Preconditions

- the API is already running on an explicit `http://127.0.0.1`, `localhost`, or
  `[::1]` URL;
- `--build` identifies a completed build whose publication and index stages are
  done;
- `--release` identifies the available published release from that build;
- the query credential is bound to the non-admin `--principal`, can read the
  target repository, and cannot read the repository passed through
  `--isolation-repository`; and
- the internal credential can read build status and issue/revoke a tenant token.

The harness creates one five-minute `context:read`/`context:query` token,
immediately revokes it, and proves the revoked credential receives HTTP 401.
It never writes any token value to the retained report.

## Local query-principal configuration

The local stack keeps `tenant:<JINA_TENANT_ID>` as its tenant administrator. By
default it also binds the static Context credential to that tenant principal,
preserving the original developer behavior. Issued-token and security/load
acceptance instead need an ordinary repository-bound user. Configure one only
through the local lifecycle option before `dev-up`:

```bash
export JINA_DEV_CONTEXT_QUERY_PRINCIPAL_ID=user:context-query@jina.internal
scripts/dev-up.sh
source /tmp/jina-dev.env
```

`dev-up` validates the value, keeps the tenant principal in
`JINA_TENANT_ADMIN_PRINCIPALS`, synchronizes the configured repositories for
the user, and exports the normalized user as `JINA_CONTEXT_PRINCIPAL_ID`.
Process-only restarts retain that exact binding in private restart state.

To switch an already retained local database after its active work is safely
terminal, make the change explicit on the process-only restart. PostgreSQL,
Board state, artifacts, and credentials remain unchanged; the successful
restart updates only the retained query-principal metadata:

```bash
JINA_DEV_CONTEXT_QUERY_PRINCIPAL_ID=user:context-query@jina.internal \
  scripts/dev-restart.sh --build
source /tmp/jina-dev.env

curl -fsS -X POST "$JINA_API_URL/internal/context/access/sync" \
  -H "authorization: Bearer $JINA_INTERNAL_TOKEN" \
  -H "x-jina-tenant-id: $JINA_TENANT_ID" \
  -H "x-jina-principal-id: $JINA_CONTEXT_PRINCIPAL_ID" \
  -H "content-type: application/json" \
  -d '{"repositories":["owner/repository"],"mode":"merge"}'
```

The local option accepts only the exact tenant default or a normalized
`user:<name>@<domain>` principal. Service principals, another tenant's
principal, and malformed user identities fail before any process is stopped.
It does not change production API, worker, dashboard, or admin configuration.

## Run

Choose an explicit retained report path. The parent directory is created
automatically and the file is written with mode `0600`.

```bash
pnpm evaluate:context-security-load -- \
  --api-url http://127.0.0.1:3000 \
  --tenant "$JINA_TENANT_ID" \
  --internal-token "$INTERNAL_API_TOKEN" \
  --query-token "$CONTEXT_API_TOKEN" \
  --principal "$JINA_CONTEXT_PRINCIPAL_ID" \
  --repository owner/repository \
  --ref main \
  --build cb_completed_build \
  --release cr_published_release \
  --from-release cr_previous_release \
  --isolation-repository forbidden/context-security-probe \
  --concurrency 4 \
  --request-count 30 \
  --max-p95-ms 2000 \
  --max-error-rate 0 \
  --report /absolute/path/to/retained/context-security-load.json
```

`--from-release` may equal `--release` when no prior release exists. Run
`pnpm evaluate:context-security-load -- --help` for all environment-variable
alternatives and bounds.

The process exits nonzero if any contract is violated. The JSON report retains:

- target build/release/commit/document identity;
- overall and per-operation list/read/diff counts, status/error counts, byte
  count, and p50/p95/p99 latency;
- exact-response stability and release consistency outcomes;
- missing-credential, admin-denial, tenant-isolation, repository-isolation, and
  revoked-token outcomes; and
- public-payload leak violations for raw evidence, provider payloads, prompts,
  transcripts, private Board/checkpoint fields, artifact keys, GCS URIs, and
  stack traces.

The configurable defaults are conservative: concurrency 4, 30 total requests,
10-second per-request timeout, 2-second p95, zero accepted errors, and 8 MiB
maximum response size. Search is deliberately excluded because the separate
surface harness owns one bounded search and HTTP/MCP-equivalence check.

## Test the harness without a live stack

```bash
pnpm test:context-security-load
```

The fake-server suite proves concurrent success, deterministic/release
consistency, isolation and denial behavior, issued-token revocation, private
payload rejection, bounded load error/latency reporting, secret-free reports,
and the non-loopback guard.
