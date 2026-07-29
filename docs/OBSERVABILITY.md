# Observability

Jina writes structured JSON to stdout/stderr for Cloud Logging and propagates W3C
`traceparent`/Cloud Run trace identity. Google Cloud Monitoring supplies durable
log-based metrics and alerts; in-process metrics support live inspection and acceptance.
Source text and credentials must never be metric labels or routine logs.

## Structured events

`@jina/observability` emits one JSON document per event with `severity`, `time`, a
human-readable `message`, and a stable `event` field.

| Event                                              | Service        | Meaning                                                                    |
| -------------------------------------------------- | -------------- | -------------------------------------------------------------------------- |
| `http.request`                                     | API            | Completed request with low-cardinality route, method, status, and duration |
| `http.request.error`                               | API            | Handler error, mapped status, and diagnostic fields                        |
| `github.webhook`                                   | API            | Delivery outcome, repository, and task count                               |
| `stage.completed` / `stage.failed`                 | workers        | Board topic, task, repository, duration, and redacted failure category     |
| `worker.started`                                   | workers        | Worker identity and configured topics                                      |
| `worker.poll_failed`                               | workers        | API polling/control-plane failure                                          |
| `worker.lease_lost` / `worker.lease_renewal_retry` | workers        | Lease fencing or renewal health                                            |
| `worker.lease_release_failed`                      | workers        | Failed release after an incomplete execution                               |
| `ingest.github_source_unavailable`                 | context worker | Optional provider endpoint unavailable during bounded intake               |

Unknown raw paths are logged as `(unknown)`, preventing attacker-controlled
high-cardinality route labels. Healthy probes are counted without routine info logs.
Failures must redact bearer tokens, repository credentials, model keys, and source body
content.

## Correlation

API requests use `traceparent`, then `X-Cloud-Trace-Context`, then a generated trace.
Logs include Cloud Logging trace resource fields when `GOOGLE_CLOUD_PROJECT` is set.
Worker stages receive a task-execution trace.

For a repository context incident, correlate:

```text
GitHub delivery
  -> build-context root task
  -> stage task + lease + attempt/write fence
  -> evidence checkpoint
  -> derivation run
  -> index generation
  -> query trace
```

The API response exposes only the query `traceId`; authenticated task and generation
views provide the remaining operational identities.

## Live metrics

`GET /internal/observability` requires `INTERNAL_API_TOKEN` and returns API counters and
duration summaries. Worker `GET /health` includes its bounded metrics snapshot and stable
last-work category.

The API registry includes:

- `http.requests` by route, method, and status class;
- `http.request.duration_ms` by route;
- `github.webhooks` by outcome.

Workers include:

- `worker.tasks` by topic, outcome, and failure category;
- `worker.stage.duration_ms` by topic;
- `worker.poll_failures`;
- `worker.lease_lost`.

These snapshots reset with the instance and cap label combinations; they are not a
durable time-series store.

## Context health endpoint

Tenant administrators can call `GET /context/metrics`. The response is backed by context
storage and includes:

- `outboxDepthByConsumer` and `oldestPendingAt`;
- published generation count;
- knowledge-document, fragment, hierarchy-node, and embedding counts;
- projector name, status, version, checkpoint, and backlog;
- query count, p95 duration, citation-verification failure count, and surfaced conflict
  count.

`embeddingCount` remains zero while dense retrieval is disabled. A PageIndex-specific
claim must not be inferred from `hierarchyNodeCount`; hierarchy nodes currently come from
the deterministic fallback unless generation capability metadata says otherwise.

Query runs persist bounded telemetry: tenant/repository, principal and request
fingerprints, selected generation, task kind, selected routes, coverage, degraded
capabilities, duration, citation failures, and conflict count. Candidate and answer
citation tables are bounded operational records and must follow retention policy.

## Required dashboards

A production context dashboard should show:

- stage throughput/failure and p95 duration by `ingest-evidence`, baseline
  `index-context`, and `derive-knowledge`/enriched publication;
- derivation input size, prior-document count, re-emitted/retired logical IDs, Codex
  model/prompt/schema version, first-pass validation failures, repair outcome, and
  fail-closed count;
- lease loss and API polling failures;
- repository/ref ingestion freshness and latest published generation age;
- complete/partial checkpoint rate plus Git history count/root status, GitHub pagination
  completion/reason, and omitted-body count from the observation frontier;
- outbox depth and oldest age by manifest, knowledge-current, lexical, dense, hierarchy,
  structural, identity, ACL, and retention consumer;
- generation build time and degraded/disabled projector capabilities;
- query count and p95, route contribution, coverage status, conflict count, and citation
  verification failures;
- `diagnose` query count, answered/partial/unanswered rate for the maintained real-question
  corpus, and the missing evidence/retriever categories behind failures;
- Cloud Run request/instance health and Cloud SQL connections/latency.

Do not combine all projector backlog into one number; ACL/retention lag is more severe
than an optional dense or hierarchy lag.

## Alerts

Page immediately when:

- an ACL or erasure projector is behind a query-serving generation;
- citation verification failure count becomes nonzero outside a short diagnostic window;
- a required projector cannot publish or no generation exists for a current ref;
- authoritative-head/commit acceptance or MCP citation verification fails.

Alert at an operational threshold when:

- required outbox age exceeds the freshness SLO;
- stage failure/repair rates change materially;
- partial checkpoint rate or a repeated Git/GitHub/body-omission frontier regresses;
- derivation latency/cost or validation failures move materially;
- query p95 or insufficient coverage regresses;
- rebuild fingerprints diverge for identical input;
- an optional projector degrades query latency.

Notification channels are configured in Cloud Monitoring, not in application source.

## Useful log queries

```text
jsonPayload.event="stage.failed"
jsonPayload.event="stage.completed" AND jsonPayload.topic="run-index-context"
jsonPayload.event="http.request" AND severity>=ERROR
jsonPayload.event="github.webhook"
jsonPayload.taskId="<task id>"
jsonPayload.repository="owner/repository"
```

## Acceptance evidence

Each release must retain:

- Cloud Build and immutable image SHA;
- pre-deployment backup ID;
- migration execution;
- API and both worker health payloads;
- acceptance build/stage IDs;
- certified repository/ref/commit and generation ID;
- HTTP and real MCP citation counts;
- final outbox depth;
- evaluation report produced by `pnpm evaluate:context`;
- per-question coverage report produced by `pnpm evaluate:questions` for the maintained
  engineering-question corpus.

The acceptance job output is a release gate, not a substitute for ongoing SLO monitoring.

## Local inspection

```sh
pnpm dev 2>&1 | jq -R 'fromjson? // .'
curl -H "Authorization: Bearer ${INTERNAL_API_TOKEN}" \
  "${JINA_API_URL}/internal/observability"
curl -H "Authorization: Bearer ${INTERNAL_API_TOKEN}" \
  -H "X-Jina-Principal-Id: user:operator@example.com" \
  "${JINA_API_URL}/context/metrics"
```

The context metrics caller must use the internal credential and be configured as a tenant
administrator. The fixed context query bearer is intentionally rejected by this route.
