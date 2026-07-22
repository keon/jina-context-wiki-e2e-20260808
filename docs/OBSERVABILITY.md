# Observability

Jina runs entirely on Cloud Run in the `jina-v2` Google Cloud project, so the
recommended observability stack is **Google Cloud Observability**: Cloud
Logging for structured events, Cloud Monitoring log-based metrics and
dashboards for trends and alerts, and Cloud Trace for request correlation.
Cloud Run ingests JSON written to stdout/stderr automatically, so this stack
needs no agent, no collector, no sidecar, and no new vendor; access control
reuses the project's existing IAM.

The instrumentation itself is vendor-neutral. `@jina/observability` emits
standards-based data — W3C `traceparent` propagation, one JSON document per
event — so pointing the same logs at Grafana Cloud, Honeycomb, or Datadog
later (for example through an OpenTelemetry Collector reading the same
stream) requires no application changes.

## What is emitted

`@jina/observability` is a zero-dependency workspace package used by the API
and both worker services. Every line is a single JSON document with a Cloud
Logging `severity`, an ISO `time`, a human-readable `message`, a stable
`event` name for filtering, and event-specific fields. `WARNING` and above go
to stderr, the rest to stdout; Cloud Logging reads the embedded severity from
either stream.

### Events

| Event                                                                                                                    | Service              | Meaning                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.request`                                                                                                           | API                  | One line per finished HTTP request with `httpRequest` (method, status, latency) and a low-cardinality `route` label. Healthy health-probe requests are counted but not logged, and paths outside the served-route table are logged as `(unknown)` — attacker-controlled raw paths are never retained. |
| `http.request.error`                                                                                                     | API                  | A request handler threw; includes the error name, message, stack, and mapped status code.                                                                                                                                                                                                             |
| `github.webhook`                                                                                                         | API                  | A GitHub delivery was accepted, with `deliveryId`, `repository`, `outcome` (created/duplicate/ignored), and `createdTaskCount`.                                                                                                                                                                       |
| `stage.completed` / `stage.failed`                                                                                       | workers              | One line per finished board task with `topic`, `taskId`, `repository`, `durationMs`, and on failure a stable `failureCategory` (see `apps/worker/src/diagnostics.ts`) plus the redacted `reason`.                                                                                                     |
| `worker.started`, `worker.poll_failed`, `worker.lease_lost`, `worker.lease_renewal_retry`, `worker.lease_release_failed` | workers              | Worker lifecycle and control-plane health.                                                                                                                                                                                                                                                            |
| `ingest.git_transport_unavailable`, `ingest.github_source_unavailable`                                                   | context-graph worker | Degraded-source conditions during ingestion.                                                                                                                                                                                                                                                          |

### Trace correlation

Every API request resolves its trace from the W3C `traceparent` header first,
then Cloud Run's `X-Cloud-Trace-Context`, and otherwise starts a fresh trace.
Request and error logs carry `logging.googleapis.com/trace`, `spanId`, and
`trace_sampled`, so the Logs Explorer groups them with Cloud Run's own request
logs and Cloud Trace shows the application events inside each request. Worker
stage logs get a generated trace per task execution so one task's lines
correlate. `GOOGLE_CLOUD_PROJECT` must be set on the services for the trace
resource name; without it, lines still carry a raw `traceId`.

### In-process metrics

Both services keep cumulative in-process counters and duration summaries
(`MetricsRegistry`), capped at 1,000 label combinations:

- API: `http.requests` (route, method, status class), `http.request.duration_ms`
  (route), `github.webhooks` (outcome), served at `GET /internal/observability`
  (internal token required).
- Workers: `worker.tasks` (topic, outcome, failure category),
  `worker.stage.duration_ms` (topic), `worker.poll_failures`,
  `worker.lease_lost`, included in the existing `GET /health` payload.

These snapshots reset on instance restart; they are for live inspection and
the acceptance job. Durable time series come from log-based metrics.

## Surfacing it in Google Cloud

### Logs Explorer (available immediately)

Useful queries in **Logging → Logs Explorer**:

```text
jsonPayload.event="stage.failed"                       -- every failed task with category and duration
jsonPayload.event="http.request" AND severity>=ERROR    -- 5xx requests
jsonPayload.event="github.webhook"                      -- webhook intake outcomes
jsonPayload.taskId="<task id>"                          -- one task's full story
```

### Log-based metrics (provisioned)

These log-based metrics exist in the `jina-v2` project (created 2026-07-21;
recreate with `gcloud logging metrics create` if the project is rebuilt).
They turn the structured events into durable Cloud Monitoring time series
under `logging.googleapis.com/user/...`:

1. `jina_stage_outcomes` — counter over `jsonPayload.event=("stage.completed" OR "stage.failed")`,
   labels `topic`, `event`, `failureCategory`.
2. `jina_stage_duration_ms` — distribution over the same filter, value
   `jsonPayload.durationMs`, label `topic`.
3. `jina_webhook_outcomes` — counter over `jsonPayload.event="github.webhook"`,
   label `outcome`.
4. `jina_api_errors` — counter over `jsonPayload.event="http.request" AND severity>=ERROR`,
   label `route`.

### Dashboard and alerts (provisioned)

The **Jina Operations** dashboard in Cloud Monitoring covers request rate and
p95 latency per service (Cloud Run built-in metrics), task throughput and
failure categories by topic, stage duration p95, webhook intake outcomes, API
5xx by route, instance counts, and Cloud SQL connections (relevant because
board mutations hold a cross-instance transaction lock).

Two alert policies exist, currently without notification channels — attach an
email or chat channel in **Monitoring → Alerting** to receive them:

- _Jina worker task failures sustained 15m_ — `jina_stage_outcomes{event="stage.failed"}`
  non-zero for 15 minutes, grouped by `failureCategory`.
- _Jina API 5xx responses sustained 10m_ — `jina_api_errors` non-zero for
  10 minutes, grouped by `route`.

## Local development

Logs stay readable as single-line JSON. Pipe through `jq` when needed:

```sh
pnpm dev 2>&1 | jq -R 'fromjson? // .'
```

`GET /internal/observability` (API) and `GET /health` (workers) return the
live metrics snapshots.
