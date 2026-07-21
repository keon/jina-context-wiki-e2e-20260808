# Issue-trace retrieval benchmark

Date: 2026-07-21

## Evidence status

This file is a historical architecture-decision record, not a reproducible
benchmark target. The one-off harness, deleted synthetic fixture, PostgreSQL
instance configuration, and raw timing samples were not retained in this
repository, so the exact numbers below cannot be independently rerun from the
current checkout. They support the recorded cache decision but should not be
treated as current production performance evidence.

Any refresh of this decision must add a checked-in benchmark command and fixture
generator, record the PostgreSQL version and relevant settings, emit raw samples
or a machine-readable summary, and compare result parity before updating the
numbers in this document.

## Decision

`issue_trace` reads the materialized relational graph directly. The former per-issue JSON cache is not retained because direct traversal meets the 100 ms database p95 target at the tested scale. `ontology_project` remains the exclusive owner of graph materialization; retrieval performs no writes.

## Method

Both implementations were exercised through `PostgresOntologyGraphStore.retrieve` against the same PostgreSQL instance, rotating through issue-number, issue-text, pull-request, and commit lookups. Every lookup was required to return exactly one equivalent issue trace before timings were accepted. The real-repository run used 20 warm-ups and 100 measured calls; the scaled run used 10 warm-ups and 70 measured calls.

The scaled fixture contained one graph generation with 5,000 Issues, 5,000 Pull Requests, 5,000 Commits, and 20,000 causal/resolution/membership edges plus corresponding active assertions. It was deleted after the run. The direct path used indexes on graph kind/identity, edge source/target/predicate, and active assertion endpoints.

## Results

| Dataset                                                    | Path                        |     p50 |     p95 |     max |
| ---------------------------------------------------------- | --------------------------- | ------: | ------: | ------: |
| Real validation repository (94 nodes, 163 edges)           | JSON cache                  |  0.7 ms |  1.8 ms |  5.5 ms |
| Real validation repository (94 nodes, 163 edges)           | Direct relational traversal |  2.2 ms |  5.9 ms |  8.0 ms |
| Synthetic scale (5,000 issues, 15,000 nodes, 20,000 edges) | JSON cache                  |  6.7 ms |  9.2 ms | 14.6 ms |
| Synthetic scale (5,000 issues, 15,000 nodes, 20,000 edges) | Direct relational traversal | 21.1 ms | 35.7 ms | 43.7 ms |

The initial unindexed full-graph direct implementation measured 855.2 ms p95 at synthetic scale. Narrowing traversal to the selected issue neighborhood and adding relational indexes reduced p95 to 35.7 ms. The optimized direct path is slower than denormalized JSON, but it avoids duplicated projection logic and remains well within the target.

## Revisit condition

Reconsider a dedicated cache only if production telemetry shows direct `issue_trace` database latency above 100 ms p95 on representative repository sizes after query/index tuning. Any future cache must remain disposable, be written only by `ontology_project`, and pass result-parity tests against direct graph traversal.
