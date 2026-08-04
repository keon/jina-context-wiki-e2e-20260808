# Upstream provenance

This directory contains the complete application imported from
[`omxyz/jina-simulation`](https://github.com/omxyz/jina-simulation).

- Upstream commit: `a2b795785e4bc5034052ab1b1bd9e1bd9ad42062`
- Imported on: 2026-08-01
- Active surfaces: review API, migrations, Trigger.dev workers, and evaluation tools.

The root `apps/dashboard` owns the single deployed route tree and all dashboard source.
The imported dashboard has been fully promoted into that application under
`apps/dashboard/src/dashboard`; `platform/v1` no longer contains or deploys a second
Next.js package. Keep this provenance file focused on the retained backend compatibility
surface whenever the upstream import is refreshed.

## Consolidation hardening

The import is intentionally not a byte-for-byte deployment of the pinned commit.
Before staging, its supported dependency lines were advanced to Hono 4.12 / Node
adapter 2, Trigger.dev 4.5, and Daytona 0.203. Transitive overrides pin patched
OpenTelemetry, Socket.IO, WebSocket, esbuild, and tar releases. Both deployed npm
trees currently pass `npm audit` with zero known vulnerabilities, and the complete
409-test API and 215-test Trigger suites pass on the hardened lockfiles.
