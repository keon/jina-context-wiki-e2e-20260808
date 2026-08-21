# Staging workflow fixture

This repository is a staging-only fixture for Jina's Wiki and review workflows.
It contains a small in-memory job queue with enough executable behavior for the
review agent to exercise retries and for OpenWiki to document the runtime flow.

## Commands

```sh
npm test
```

The fixture uses Node's built-in test runner and has no install-time dependencies.

## Canonical documentation

Jina regenerates this repository's canonical Wiki from the exact `main` commit
after a change is merged. Pull requests are reviewed against the current
canonical release and do not create separate Wiki releases.
