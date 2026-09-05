# Staging workflow fixture

This repository is a staging-only fixture for Jina's Wiki and review workflows.
It contains a small in-memory job queue and an idempotent webhook delivery flow
with enough executable behavior for the review agent to exercise retries and
for OpenWiki to document the runtime flows.

## User onboarding and account activation

New users remain pending until they complete a profile, verify their email, and accept
the terms. Steps may happen in any order and repeating a completed step is idempotent.
The account becomes active only when every required step is complete. Resetting the
flow returns it to a clean pending state. The state transition is pure and immutable;
persistence and delivery live outside this fixture's domain boundary.

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

The executable Wiki readiness model keeps a previously published release
readable while a refresh is running. Assignment and repository access still
take precedence, and an active build disables duplicate generation.

Release acceptance checks inspect published Wiki documents and saved Scenario
library entries, not only the background task's completion status.

Provider recovery checks keep repository ownership unchanged. Each admitted
review, Wiki build, and Scenario update uses the workspace's selected provider
policy; reconnecting an account does not assign or transfer this repository.
An interrupted Wiki build may preserve private verified progress for a later
authorized build, but incomplete pages are never published as a release.
