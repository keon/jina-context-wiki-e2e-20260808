# Staging workflow fixture

This repository is a staging-only fixture for Jina's Wiki and review workflows.
It contains a small in-memory job queue and an idempotent webhook delivery flow
with enough executable behavior for the review agent to exercise retries and
for OpenWiki to document the runtime flows.

## Commands

```sh
npm test
```

## Canonical documentation

Jina regenerates this repository's canonical Wiki from the exact `main` commit
after a change is merged. Pull requests are reviewed against the current
canonical release and do not create separate Wiki releases.
