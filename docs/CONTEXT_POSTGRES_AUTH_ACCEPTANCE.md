# Shared-Postgres token acceptance

The production-shaped local acceptance for issued Context credentials is:

```sh
pnpm evaluate:context-postgres-auth -- \
  --report /tmp/jina-context-postgres-auth-e2e.json
```

The command requires Docker, `psql`, and the workspace dependencies. It creates
one disposable PostgreSQL 17 container on a random loopback port, installs the
production Context schema and capability roles, and starts two separate API
processes against the same database. The APIs bind to random loopback ports.
Development endpoints are enabled only to obtain loopback binding; trusted
development identity headers are explicitly disabled, so every assertion uses
the production bearer-verification path.

The harness proves:

- the runtime login is `NOINHERIT`, is not a superuser, has no
  `BYPASSRLS`, has no `jina_context_admin` membership, and cannot read the
  token table without activating the narrow token capability;
- a tenant/principal token minted through API instance A is immediately usable
  through instance B over both HTTP and the real MCP SDK;
- the MCP surface exposes exactly `search_context`, `list_context`,
  `read_context`, and `diff_context`;
- repository ACL denial is indistinguishable from a repository that does not
  exist over both HTTP and MCP;
- a mismatched tenant assertion is indistinguishable from an unknown issued
  credential;
- a token belonging to another tenant cannot observe the first tenant's
  repository;
- revoking through instance A causes immediate HTTP and MCP rejection through
  instance B; and
- expiry is evaluated with PostgreSQL `now()`, then immediately enforced by
  instance B over HTTP and MCP.

The retained JSON contains status codes and booleans, never a bearer token,
token hash, database password, or database URL. It is written with mode `0600`.
Both API processes, temporary files, and the exact disposable container are
removed whether the run passes or fails. The command does not read, restart, or
modify `/tmp/jina-dev`, its database container, its processes, or its
artifacts.
