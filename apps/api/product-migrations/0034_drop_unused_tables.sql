-- These stores have no remaining application reader or writer. Retired board
-- and graph schemas are removed separately by the database-owner cleanup
-- because they intentionally have no dependency on the product migration role.
drop table if exists public.scenario_review_comments;
drop table if exists jina_context.context_embeddings;
