-- The retired model-driven Context query engine was the only intended writer
-- for these tables, but no production request path ever persisted its telemetry.
drop table if exists jina_context.retrieval_candidates;
drop table if exists jina_context.answer_citations;
drop table if exists jina_context.retrieval_metrics;
drop table if exists jina_context.query_runs;
