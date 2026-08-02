-- Durable dashboard sessions (replaces the in-memory map; safe across instances).
create table if not exists dashboard_sessions (
    id text primary key,
    session_json jsonb not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);
create index if not exists idx_dashboard_sessions_expires on dashboard_sessions(expires_at);

-- Short-lived OAuth login state -> return_to (also previously in-memory).
create table if not exists oauth_states (
    state text primary key,
    return_to text not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);

-- Scenario plans generated for a review run. A scenario has ordered steps.
create table if not exists scenarios (
    id uuid primary key default uuid_generate_v4(),
    tenant_id uuid references tenants(id) on delete cascade,
    review_run_id uuid not null references review_runs(id) on delete cascade,
    scenario_key text not null,
    scenario_index integer not null,
    title text not null,
    risk text not null default 'unknown',
    intent text,
    justification text,
    relevant_paths jsonb not null default '[]',
    markdown text,
    created_at timestamptz not null default now(),
    unique (review_run_id, scenario_key)
);
create index if not exists idx_scenarios_review_run on scenarios(review_run_id);

create table if not exists scenario_steps (
    id uuid primary key default uuid_generate_v4(),
    scenario_id uuid not null references scenarios(id) on delete cascade,
    step_index integer not null,
    text text not null,
    step_type text not null default 'action',
    created_at timestamptz not null default now(),
    unique (scenario_id, step_index)
);

-- Simulations are instances of a scenario. A scenario can have many simulations.
create table if not exists simulations (
    id uuid primary key default uuid_generate_v4(),
    tenant_id uuid references tenants(id) on delete cascade,
    scenario_id uuid not null references scenarios(id) on delete cascade,
    review_run_id uuid not null references review_runs(id) on delete cascade,
    mode text,
    status text not null,
    final_verdict text,
    confidence double precision,
    commit text,
    completed_at timestamptz,
    raw_json jsonb,
    created_at timestamptz not null default now()
);
create index if not exists idx_simulations_scenario on simulations(scenario_id);
create index if not exists idx_simulations_review_run on simulations(review_run_id);

create table if not exists simulation_steps (
    id uuid primary key default uuid_generate_v4(),
    simulation_id uuid not null references simulations(id) on delete cascade,
    step_index integer not null,
    step_text text,
    step_status text,
    scenario_verdict text,
    consensus_reached boolean,
    predicted_output text,
    confidence double precision,
    raw_json jsonb,
    created_at timestamptz not null default now(),
    unique (simulation_id, step_index)
);
