-- Scenario identity becomes three levels:
--   lineage  (stable identity for "the same scenario" across review runs/commits)
--     -> version  (a specific "course": a set of steps)
--       -> simulation instance  (one execution; commit + prior + uuid)
-- Previously a scenario's identity was positional (scenario-<index>), so the
-- dashboard grouped different scenarios together across runs. Lineages give a
-- stable, addressable handle for grouping and for user-triggered reruns.

-- A scenario lineage spans review runs for one pull request.
create table if not exists scenario_lineages (
    id uuid primary key default uuid_generate_v4(),
    tenant_id uuid references tenants(id) on delete cascade,
    repository_id uuid not null references repositories(id) on delete cascade,
    pr_number bigint not null,
    lineage_key text not null,
    title text not null,
    risk text not null default 'unknown',
    relevant_paths jsonb not null default '[]',
    created_at timestamptz not null default now(),
    unique (repository_id, pr_number, lineage_key)
);
create index if not exists idx_scenario_lineages_repo_pr on scenario_lineages(repository_id, pr_number);

-- A version is a concrete "course" (ordered steps) of a lineage. Generated
-- scenarios create version 1; a user-supplied course adds a new version under
-- the same lineage. version_hash is a content hash of the normalized steps so an
-- identical course is reused rather than duplicated.
create table if not exists scenario_versions (
    id uuid primary key default uuid_generate_v4(),
    lineage_id uuid not null references scenario_lineages(id) on delete cascade,
    version_index integer not null,
    version_hash text not null,
    steps jsonb not null default '[]',
    markdown text,
    origin text not null default 'generated', -- generated | user
    created_by text,
    created_at timestamptz not null default now(),
    unique (lineage_id, version_hash)
);
create index if not exists idx_scenario_versions_lineage on scenario_versions(lineage_id);

-- Link the existing per-run scenario snapshot to its durable lineage, and record
-- the content fingerprint used to derive the lineage key. Nullable so historical
-- rows backfill lazily.
alter table scenarios add column if not exists lineage_id uuid references scenario_lineages(id) on delete set null;
alter table scenarios add column if not exists fingerprint text;
create index if not exists idx_scenarios_lineage on scenarios(lineage_id);

-- A simulation is one execution instance of a scenario. Extend it so an instance
-- is distinguishable by (commit, prior_hash, version): two reruns on the same
-- commit with a different prior (initial state) are two instances.
alter table simulations add column if not exists lineage_id uuid references scenario_lineages(id) on delete set null;
alter table simulations add column if not exists scenario_version_id uuid references scenario_versions(id) on delete set null;
alter table simulations add column if not exists prior_state jsonb;
alter table simulations add column if not exists prior_hash text;
alter table simulations add column if not exists kind text not null default 'review'; -- review | rerun | question
alter table simulations add column if not exists question text;
alter table simulations add column if not exists answer text;
create index if not exists idx_simulations_lineage on simulations(lineage_id);
