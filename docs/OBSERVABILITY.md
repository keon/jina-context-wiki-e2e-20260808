# Observability

Jina writes structured JSON to stdout/stderr for Cloud Logging and propagates W3C
`traceparent`/Cloud Run trace identity. Google Cloud Monitoring supplies durable
log-based metrics and alerts; in-process metrics support live inspection and acceptance.
Source text and credentials must never be metric labels or routine logs.

## Structured events

`@jina/observability` emits one JSON document per event with `severity`, `time`, a
human-readable `message`, and a stable `event` field.

| Event                                                | Service        | Meaning                                                                                       |
| ---------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------- |
| `http.request`                                       | API            | Completed request with low-cardinality route, method, status, and duration                    |
| `http.request.error`                                 | API            | Handler error, mapped status, and diagnostic fields                                           |
| `github.webhook`                                     | API            | Delivery outcome, repository, and task count                                                  |
| `stage.started` / `stage.completed` / `stage.failed` | workers        | Build, topic, task, attempt, duration, exact model-token usage, and redacted failure category |
| `context.page_draft_created`                         | context worker | Draft bytes, citation count, and deterministic structural findings                            |
| `context.page_audit_evaluated`                       | context worker | Audit pass, structural and unsupported-citation counts, and bounded diagnostics               |
| `context.page_repair_evaluated`                      | context worker | Repair pass, candidate findings, and regression-retention decision                            |
| `worker.started`                                     | workers        | Worker identity and configured topics                                                         |
| `worker.poll_failed`                                 | workers        | API polling/control-plane failure                                                             |
| `worker.lease_lost` / `worker.lease_renewal_retry`   | workers        | Lease fencing or renewal health                                                               |
| `worker.lease_release_failed`                        | workers        | Failed release after an incomplete execution                                                  |
| `ingest.github_source_unavailable`                   | context worker | Optional provider endpoint unavailable during bounded intake                                  |

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
  -> immutable input/research/page/audit artifact
  -> publication task and PageIndex artifact
  -> immutable release
  -> query trace
```

The API response exposes only the query `traceId`; authenticated task and release
views provide the remaining operational identities.

Authenticated build progress exposes per-stage input, cached-input, output, and total
model tokens, current build reservations and remaining budget, the latest retry reason,
and bounded page diagnostics. This state is durable on the Board and survives worker or
dashboard restarts; Cloud Logging supplies the higher-cardinality execution timeline.

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

Tenant administrators can call `GET /wiki/metrics`. The response is backed by context
storage and includes:

- `outboxDepthByConsumer` and `oldestPendingAt`;
- published context release count;
- knowledge-document, fragment, hierarchy-node, and embedding counts;
- projector name, status, version, checkpoint, and backlog;
- query count, p95 duration, citation-verification failure count, and surfaced conflict
  count.

`embeddingCount` remains zero while dense retrieval is disabled. Hierarchy nodes come
from the pinned PageIndex OSS Markdown worker when it is healthy; projector status and
release artifacts identify a fallback or failed hierarchy build.

Query runs persist bounded telemetry: tenant/repository, principal and request
fingerprints, selected release, task kind, selected routes, coverage, degraded
capabilities, duration, citation failures, and conflict count. Search telemetry records
selection, not a model-written answer; bounded operational records follow retention
policy.

Every failed or retried worker stage appends its bounded diagnostic and stable failure
category to the task's Board event stream. Tenant-facing build summaries expose the
category's safe fixed description; operators inspect the authorized Board events for the
specific reason without relying on ephemeral worker logs.

The operator-only `GET /internal/observability` response also includes process-local
database pool state plus cumulative checkout-wait, transaction setup, SQL/body, commit,
and total latency summaries grouped by stable operation and role. Database metric labels
never contain tenant IDs, SQL text, bind values, or exception messages. A rising
`context.db.pool.checkout_wait_ms` or `context.db.pool.queued_checkouts` identifies pool
pressure; `context.db.transaction.setup_ms` isolates transaction/RLS setup;
`context.db.transaction.operation_ms` isolates the repository query or transaction body;
`context.db.operation.duration_ms` breaks multi-statement transaction bodies into named
repository phases; and `context.db.transaction.commit_ms` isolates commit latency. The
`pool` object reports current `total`, `idle`, `waiting`, and configured `max` connections.
Like other in-process metrics, these diagnostics reset when the instance restarts.

## Required dashboards

A production context dashboard should show:

- stage throughput/failure and p95 duration for all four Board topics:
  `run-context-input-snapshot`, `run-context-page-plan`,
  `run-context-page-build`, and `run-context-publication`;
- snapshot size, prior-release inputs, Codex model/prompt/schema version, page-audit
  failures, repair passes, and fail-closed count;
- Board graph phase and checkpoint age, planned/completed subjects and pages, page
  dispositions, repair counts, attempt counts, and terminal failures;
- lease loss and API polling failures, attributed to a process-unique worker ID
  (the release revision alone is not an instance identity);
- repository/ref ingestion freshness and latest published release age;
- valid/pending/invalid private-checkpoint rate plus Git history count/root status, GitHub pagination
  completion/reason, and omitted-body count from the observation frontier;
- outbox depth and oldest age by manifest, knowledge-current, lexical, dense, hierarchy,
  structural, identity, ACL, and retention consumer;
- release build time and degraded/disabled projection capabilities;
- query count and p95, route contribution, coverage status, conflict count, and citation
  verification failures;
- lexical-tree search count, retrieved/no-context rate for the maintained real-query
  corpus, and exact-title acceptance hit rate;
- Cloud Run request/instance health and Cloud SQL connections/latency.

Do not combine all projector backlog into one number; ACL/retention lag is more severe
than an optional dense or hierarchy lag.

## Alerts

Page immediately when:

- an ACL or erasure projector is behind a query-serving release;
- citation verification failure count becomes nonzero outside a short diagnostic window;
- a required projector cannot publish or no release exists for a current ref;
- authoritative-head/commit acceptance or MCP citation verification fails.

Alert at an operational threshold when:

- required outbox age exceeds the freshness SLO;
- stage failure/repair rates change materially;
- pending/invalid checkpoint rate or a repeated Git/GitHub/body-omission frontier regresses;
- derivation latency/cost or validation failures move materially;
- query p95 or insufficient coverage regresses;
- rebuild fingerprints diverge for identical input;
- an optional projector degrades query latency.

Notification channels are configured in Cloud Monitoring, not in application source.

## Useful log queries

```text
jsonPayload.event="stage.failed"
jsonPayload.event="stage.completed" AND jsonPayload.topic="run-context-publication"
jsonPayload.event="context.page_audit_evaluated" AND jsonPayload.unsupportedCitationCount>0
jsonPayload.event="context.page_repair_evaluated" AND jsonPayload.regressionProblemCount>0
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
- published repository/ref/commit and release ID;
- HTTP and real MCP citation counts;
- final outbox depth;
- per-question coverage report produced by `pnpm evaluate:questions` for the maintained
  engineering-question corpus.

The retained `context-board-quality-v2` report is historical compatibility evidence,
not required page-oriented release evidence until its artifact parser is updated.

The acceptance job output is a release gate, not a substitute for ongoing SLO monitoring.

## Local inspection

```sh
pnpm dev 2>&1 | jq -R 'fromjson? // .'
curl -H "Authorization: Bearer ${INTERNAL_API_TOKEN}" \
  "${JINA_API_URL}/internal/observability"
curl -H "Authorization: Bearer ${INTERNAL_API_TOKEN}" \
  -H "X-Jina-Principal-Id: user:operator@example.com" \
  "${JINA_API_URL}/wiki/metrics"
```

The context metrics caller must use the internal credential and be configured as a tenant
administrator. The fixed context query bearer is intentionally rejected by this route.
