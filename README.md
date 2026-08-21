# Staging workflow fixture

This repository is a staging-only fixture for Jina's Wiki and review workflows.
It contains a small in-memory job queue and an idempotent webhook delivery flow
with enough executable behavior for the review agent to exercise retries and
for OpenWiki to document the runtime flows.

Webhook dispatch is intentionally at-least-once. Workers renew their lease
while a request is in flight, and receivers must deduplicate side effects using
the normalized `eventId` from every attempt as the stable idempotency key. A
worker crash or an ambiguous network response can still cause a retry; attempt
tokens fence stale workers from changing Jina's delivery state, but cannot undo
an external side effect. Active work and completed deduplication history each
retain at most `maxEntries` records. The oldest completed record leaves the
in-process dedupe window when that history fills; receivers remain responsible
for durable idempotency beyond that window.
Replacement workers use `attemptNext()` to discover pending or expired work
without retaining an event ID. IDs are trimmed, normalized to Unicode NFC, and
must be well-formed before they become receiver idempotency keys.

## Commands

```sh
npm test
```

## Canonical documentation

Jina regenerates this repository's canonical Wiki from the exact `main` commit
after a change is merged. Pull requests are reviewed against the current
canonical release and do not create separate Wiki releases.
