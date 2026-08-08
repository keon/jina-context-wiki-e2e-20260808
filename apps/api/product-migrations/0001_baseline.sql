-- Baseline squash of product migrations 0001_initial.sql through
-- 0037_collapse_context_schema.sql, generated with pg_dump from a fresh
-- database that ran the full legacy chain.
--
-- Fresh databases execute this file and continue with 0038+. Databases that
-- already ran the legacy chain record it as applied without executing
-- (migrate.ts skips it when 0037_collapse_context_schema.sql is recorded);
-- a database stopped mid-chain must finish the legacy chain first and the
-- runner refuses with instructions.
--
-- public.api_tokens is deliberately absent: packages/db owns its DDL.

create extension if not exists "uuid-ossp";

-- The dump orders functions alphabetically, so bodies may reference functions
-- defined later in this file; skip body validation like pg_dump restores do.
set local check_function_bodies = off;
--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14


--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--


--
-- Name: jina_dashboard_bounded_text(jsonb, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.jina_dashboard_bounded_text(value jsonb, max_length integer DEFAULT 500) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  select case
    when jsonb_typeof(value) = 'string'
      then nullif(left(btrim(value #>> '{}'), max_length), '')
  end
$$;


--
-- Name: jina_dashboard_event_payload_projection(text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.jina_dashboard_event_payload_projection(event_status text, source jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  select case
    when source is null or jsonb_typeof(source) <> 'object' then null
    when event_status = 'runtime_review_completed' then
      jsonb_strip_nulls(jsonb_build_object(
        'status', public.jina_dashboard_bounded_text(source->'status'),
        'summary', public.jina_dashboard_bounded_text(source->'summary'),
        'findings_count', public.jina_dashboard_number(source->'findings_count'),
        'publishable_findings_count', public.jina_dashboard_number(source->'publishable_findings_count'),
        'inline_comment_count', public.jina_dashboard_number(source->'inline_comment_count'),
        'file_comment_count', public.jina_dashboard_number(source->'file_comment_count'),
        'unanchored_findings_count', public.jina_dashboard_number(source->'unanchored_findings_count'),
        'low_confidence_findings_held_back', public.jina_dashboard_number(source->'low_confidence_findings_held_back'),
        'areas_count', public.jina_dashboard_number(source->'areas_count'),
        'tasks_count', public.jina_dashboard_number(source->'tasks_count'),
        'error', public.jina_dashboard_bounded_text(source->'error')
      ))
    when event_status in (
      'github_runtime_review_published',
      'github_runtime_review_publish_skipped',
      'github_runtime_review_publish_failed'
    ) then
      jsonb_strip_nulls(jsonb_build_object(
        'publication_status', public.jina_dashboard_bounded_text(source->'publication_status'),
        'reason', public.jina_dashboard_bounded_text(source->'reason'),
        'error', public.jina_dashboard_bounded_text(source->'error'),
        'github_review_url', public.jina_dashboard_bounded_text(source->'github_review_url', 2048),
        'publishable_findings_count', public.jina_dashboard_number(source->'publishable_findings_count'),
        'inline_comment_count', public.jina_dashboard_number(source->'inline_comment_count'),
        'file_comment_count', public.jina_dashboard_number(source->'file_comment_count')
      ))
  end
$$;


--
-- Name: jina_dashboard_number(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.jina_dashboard_number(value jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  select case when jsonb_typeof(value) = 'number' then value end
$$;


--
-- Name: jina_dashboard_project_review_event(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.jina_dashboard_project_review_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.dashboard_payload_json is null
     or (
       tg_op = 'UPDATE'
       and (new.status, new.payload_json) is distinct from (old.status, old.payload_json)
       and new.dashboard_payload_json is not distinct from old.dashboard_payload_json
     ) then
    new.dashboard_payload_json := jina_dashboard_event_payload_projection(new.status, new.payload_json);
  end if;
  return new;
end
$$;


--
-- Name: jina_dashboard_project_review_run(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.jina_dashboard_project_review_run() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.result_json is null then
    new.dashboard_result_json := null;
  elsif new.dashboard_result_json is null
     or (
       tg_op = 'UPDATE'
       and new.result_json is distinct from old.result_json
       and new.dashboard_result_json is not distinct from old.dashboard_result_json
     ) then
    new.dashboard_result_json := jina_dashboard_review_result_projection(new.result_json);
  end if;
  return new;
end
$$;


--
-- Name: jina_dashboard_review_result_projection(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.jina_dashboard_review_result_projection(source jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  select case
    when source is null or jsonb_typeof(source) <> 'object' then null
    else jsonb_strip_nulls(jsonb_build_object(
      'status', public.jina_dashboard_bounded_text(source->'status'),
      'error', public.jina_dashboard_bounded_text(source->'error')
    ))
  end
$$;


--
-- Name: protect_github_webhook_inbox_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_github_webhook_inbox_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    if new.github_delivery_id <> old.github_delivery_id
       or new.github_event <> old.github_event
       or new.payload_sha256 <> old.payload_sha256
       or new.payload_ciphertext <> old.payload_ciphertext
       or new.encryption_key_version <> old.encryption_key_version
       or new.received_at <> old.received_at then
        raise exception 'GitHub webhook inbox delivery identity is immutable';
    end if;
    if old.processed_workflow_id is not null
       and new.processed_workflow_id is distinct from old.processed_workflow_id then
        raise exception 'GitHub webhook inbox workflow identity is immutable';
    end if;
    return new;
end
$$;


--
-- Name: clerk_tenant_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clerk_tenant_memberships (
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    clerk_user_id text NOT NULL,
    github_user_id bigint NOT NULL,
    github_login text NOT NULL,
    role text NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT clerk_tenant_memberships_clerk_user_id_check CHECK ((length(btrim(clerk_user_id)) > 0)),
    CONSTRAINT clerk_tenant_memberships_github_login_check CHECK ((length(btrim(github_login)) > 0)),
    CONSTRAINT clerk_tenant_memberships_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text])))
);


--
-- Name: context_execution_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.context_execution_profiles (
    tenant_id uuid NOT NULL,
    build_id text NOT NULL,
    settings jsonb NOT NULL,
    credential_kind text NOT NULL,
    encrypted_credential text,
    credential_revision text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT context_execution_profiles_check CHECK ((((credential_kind = ANY (ARRAY['managed'::text, 'unavailable'::text])) AND (encrypted_credential IS NULL)) OR ((credential_kind = ANY (ARRAY['openai'::text, 'openrouter'::text, 'codex'::text])) AND (encrypted_credential IS NOT NULL)))),
    CONSTRAINT context_execution_profiles_credential_kind_check CHECK ((credential_kind = ANY (ARRAY['managed'::text, 'openai'::text, 'openrouter'::text, 'codex'::text, 'unavailable'::text])))
);


--
-- Name: dashboard_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dashboard_sessions (
    id text NOT NULL,
    session_json jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid NOT NULL
);


--
-- Name: github_webhook_inbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.github_webhook_inbox (
    github_delivery_id text NOT NULL,
    github_event text NOT NULL,
    action text,
    installation_id bigint,
    repository_id bigint,
    repository_full_name text,
    pull_request_number bigint,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    payload_sha256 character(64) NOT NULL,
    payload_ciphertext bytea NOT NULL,
    encryption_key_version text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_id uuid,
    lease_expires_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    processed_workflow_id text,
    last_error_code text,
    last_error_at timestamp with time zone,
    completed_at timestamp with time zone,
    CONSTRAINT github_webhook_inbox_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT github_webhook_inbox_check1 CHECK ((((status = ANY (ARRAY['completed'::text, 'dead_letter'::text])) AND (completed_at IS NOT NULL)) OR ((status <> ALL (ARRAY['completed'::text, 'dead_letter'::text])) AND (completed_at IS NULL)))),
    CONSTRAINT github_webhook_inbox_encryption_key_version_check CHECK ((encryption_key_version ~ '^[1-9][0-9]*$'::text)),
    CONSTRAINT github_webhook_inbox_github_delivery_id_check CHECK (((length(github_delivery_id) >= 1) AND (length(github_delivery_id) <= 128))),
    CONSTRAINT github_webhook_inbox_github_event_check CHECK (((length(github_event) >= 1) AND (length(github_event) <= 128))),
    CONSTRAINT github_webhook_inbox_installation_id_check CHECK (((installation_id IS NULL) OR (installation_id > 0))),
    CONSTRAINT github_webhook_inbox_lease_shape CHECK ((((status = 'leased'::text) AND (lease_id IS NOT NULL) AND (lease_expires_at IS NOT NULL)) OR ((status <> 'leased'::text) AND (lease_id IS NULL) AND (lease_expires_at IS NULL)))),
    CONSTRAINT github_webhook_inbox_payload_sha256_check CHECK ((payload_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT github_webhook_inbox_pull_request_number_check CHECK (((pull_request_number IS NULL) OR (pull_request_number > 0))),
    CONSTRAINT github_webhook_inbox_repository_full_name_check CHECK (((repository_full_name IS NULL) OR (repository_full_name ~ '^[^/[:space:]]+/[^/[:space:]]+$'::text))),
    CONSTRAINT github_webhook_inbox_repository_id_check CHECK (((repository_id IS NULL) OR (repository_id > 0))),
    CONSTRAINT github_webhook_inbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'leased'::text, 'completed'::text, 'retry_wait'::text, 'dead_letter'::text])))
);


--
-- Name: github_webhook_redelivery_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.github_webhook_redelivery_requests (
    github_delivery_id text NOT NULL,
    provider_delivery_id bigint NOT NULL,
    attempt_count integer DEFAULT 1 NOT NULL,
    last_requested_at timestamp with time zone DEFAULT now() NOT NULL,
    last_http_status integer,
    last_result_at timestamp with time zone,
    CONSTRAINT github_webhook_redelivery_requests_attempt_count_check CHECK ((attempt_count > 0)),
    CONSTRAINT github_webhook_redelivery_requests_github_delivery_id_check CHECK (((length(github_delivery_id) >= 1) AND (length(github_delivery_id) <= 128))),
    CONSTRAINT github_webhook_redelivery_requests_last_http_status_check CHECK (((last_http_status >= 100) AND (last_http_status <= 599))),
    CONSTRAINT github_webhook_redelivery_requests_provider_delivery_id_check CHECK ((provider_delivery_id > 0))
);


--
-- Name: installations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.installations (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    github_installation_id bigint NOT NULL,
    permissions_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    suspended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    github_account_id bigint,
    github_account_login text,
    github_account_type text,
    installed_by_github_user_id bigint,
    installer_verified_at timestamp with time zone,
    deleted_at timestamp with time zone
);


--
-- Name: pull_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pull_requests (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    repository_id uuid NOT NULL,
    pr_number bigint NOT NULL,
    title text NOT NULL,
    author_login text,
    head_sha text NOT NULL,
    base_sha text,
    state text NOT NULL,
    draft boolean DEFAULT false NOT NULL,
    html_url text,
    updated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    head_ref text,
    base_ref text
);


--
-- Name: repositories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.repositories (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    github_repo_id bigint NOT NULL,
    owner text NOT NULL,
    name text NOT NULL,
    default_branch text NOT NULL,
    private boolean DEFAULT true NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    settings_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    installation_id uuid NOT NULL
);


--
-- Name: review_findings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review_findings (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    review_run_id uuid NOT NULL,
    fingerprint text NOT NULL,
    file_path text,
    line_number bigint,
    severity text NOT NULL,
    category text NOT NULL,
    body text NOT NULL,
    github_comment_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: review_llm_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review_llm_usage (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    review_run_id uuid NOT NULL,
    stage text NOT NULL,
    operation text NOT NULL,
    provider text DEFAULT 'openrouter'::text NOT NULL,
    key_source text NOT NULL,
    sandbox_id text NOT NULL,
    request_seq integer NOT NULL,
    model text,
    generation_id text,
    dedupe_key text NOT NULL,
    prompt_tokens bigint,
    completion_tokens bigint,
    total_tokens bigint,
    reasoning_tokens bigint,
    cached_tokens bigint,
    cache_write_tokens bigint,
    openrouter_cost numeric(18,8),
    upstream_inference_cost numeric(18,8),
    customer_share numeric(5,4),
    ai_credits_charged integer,
    raw_usage_json jsonb NOT NULL,
    raw_response_metadata_json jsonb,
    billing_status text DEFAULT 'pending_outcome'::text NOT NULL,
    autumn_event_id text,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    billed_at timestamp with time zone,
    claimed_at timestamp with time zone,
    is_byok boolean DEFAULT false NOT NULL,
    billable_cost numeric(18,8)
);


--
-- Name: review_run_billing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review_run_billing (
    review_run_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    rate_mode text NOT NULL,
    key_source text,
    infra_credits_charged integer,
    ai_credits_charged_total integer DEFAULT 0 NOT NULL,
    infra_billing_status text DEFAULT 'pending'::text NOT NULL,
    infra_autumn_event_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    infra_claimed_at timestamp with time zone
);


--
-- Name: review_run_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review_run_events (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    review_run_id uuid NOT NULL,
    status text NOT NULL,
    payload_json jsonb,
    trigger_run_id text,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    dashboard_payload_json jsonb,
    CONSTRAINT review_run_events_dashboard_projection_present CHECK (((status <> ALL (ARRAY['runtime_review_completed'::text, 'github_runtime_review_published'::text, 'github_runtime_review_publish_skipped'::text, 'github_runtime_review_publish_failed'::text])) OR (jsonb_typeof(payload_json) <> 'object'::text) OR (dashboard_payload_json IS NOT NULL)))
);


--
-- Name: review_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review_runs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    repository_id uuid NOT NULL,
    pull_request_id uuid,
    trigger text NOT NULL,
    status text NOT NULL,
    idempotency_key text NOT NULL,
    trigger_run_id text,
    sandbox_id text,
    head_sha text NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    delivery_id text,
    source_event text,
    bot_type text DEFAULT 'code_review'::text NOT NULL,
    bot_status text DEFAULT 'queued'::text NOT NULL,
    result_json jsonb,
    error text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    model_settings_snapshot jsonb,
    dashboard_result_json jsonb,
    orchestrator text DEFAULT 'trigger'::text NOT NULL,
    board_workflow_id text,
    manual_command_tag text,
    review_instructions text,
    CONSTRAINT review_runs_board_binding_check CHECK (((orchestrator <> 'board'::text) OR (board_workflow_id IS NOT NULL))),
    CONSTRAINT review_runs_dashboard_projection_present CHECK (((result_json IS NULL) OR (jsonb_typeof(result_json) <> 'object'::text) OR (dashboard_result_json IS NOT NULL))),
    CONSTRAINT review_runs_orchestrator_check CHECK ((orchestrator = ANY (ARRAY['trigger'::text, 'board'::text])))
);


--
-- Name: tenant_billing_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_billing_policy (
    tenant_id uuid NOT NULL,
    subsidy_rate numeric(5,4) DEFAULT 0.3000 NOT NULL,
    infra_credits_per_run integer DEFAULT 100 NOT NULL,
    overage_infra_credits_per_run integer DEFAULT 150 NOT NULL,
    overage_subsidy_rate numeric(5,4) DEFAULT 0.0000 NOT NULL,
    notes text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    auto_review_limit_credits integer,
    auto_review_limit_enabled boolean DEFAULT false NOT NULL,
    CONSTRAINT tenant_billing_policy_auto_review_limit_nonneg CHECK (((auto_review_limit_credits IS NULL) OR (auto_review_limit_credits >= 0))),
    CONSTRAINT tenant_billing_policy_infra_credits_nonneg CHECK ((infra_credits_per_run >= 0)),
    CONSTRAINT tenant_billing_policy_overage_infra_credits_nonneg CHECK ((overage_infra_credits_per_run >= 0)),
    CONSTRAINT tenant_billing_policy_overage_subsidy_rate_range CHECK (((overage_subsidy_rate >= (0)::numeric) AND (overage_subsidy_rate <= (1)::numeric))),
    CONSTRAINT tenant_billing_policy_subsidy_rate_range CHECK (((subsidy_rate >= (0)::numeric) AND (subsidy_rate <= (1)::numeric)))
);


--
-- Name: tenant_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_integrations (
    tenant_id uuid NOT NULL,
    openrouter_api_key text,
    openrouter_key_source text,
    openrouter_key_label text,
    openrouter_connected_at timestamp with time zone,
    configured_by_user_id bigint,
    configured_by_login text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    openai_api_key text,
    openai_connected_at timestamp with time zone,
    anthropic_api_key text,
    anthropic_connected_at timestamp with time zone
);


--
-- Name: tenant_model_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_model_settings (
    tenant_id uuid NOT NULL,
    planner_model text,
    investigation_model text,
    review_model text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    review_trigger_mode text,
    model_provider text DEFAULT 'managed'::text NOT NULL,
    context_model text,
    planner_effort text,
    investigation_effort text,
    review_effort text,
    context_effort text,
    context_harness_owner_user_id uuid,
    review_fallback_policy text DEFAULT 'fail_notify'::text NOT NULL,
    context_fallback_policy text DEFAULT 'fail_notify'::text NOT NULL,
    CONSTRAINT tenant_model_settings_context_effort_check CHECK (((context_effort IS NULL) OR (context_effort = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text])))),
    CONSTRAINT tenant_model_settings_context_fallback_policy_check CHECK ((context_fallback_policy = ANY (ARRAY['fail_notify'::text, 'managed'::text]))),
    CONSTRAINT tenant_model_settings_investigation_effort_check CHECK (((investigation_effort IS NULL) OR (investigation_effort = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text])))),
    CONSTRAINT tenant_model_settings_planner_effort_check CHECK (((planner_effort IS NULL) OR (planner_effort = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text])))),
    CONSTRAINT tenant_model_settings_provider_check CHECK ((model_provider = ANY (ARRAY['codex'::text, 'byok'::text, 'managed'::text]))),
    CONSTRAINT tenant_model_settings_review_effort_check CHECK (((review_effort IS NULL) OR (review_effort = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text])))),
    CONSTRAINT tenant_model_settings_review_fallback_policy_check CHECK ((review_fallback_policy = ANY (ARRAY['fail_notify'::text, 'managed'::text])))
);


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    github_account_id bigint,
    github_account_login text,
    github_account_type text,
    plan text DEFAULT 'free'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    kind text,
    name text,
    personal_owner_user_id uuid,
    clerk_organization_id text,
    CONSTRAINT tenants_kind_valid CHECK (((kind IS NULL) OR (kind = ANY (ARRAY['personal'::text, 'team'::text]))))
);


--
-- Name: user_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_identities (
    user_id uuid NOT NULL,
    provider text NOT NULL,
    provider_user_id text NOT NULL,
    provider_login text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_identities_provider_check CHECK ((length(btrim(provider)) > 0)),
    CONSTRAINT user_identities_provider_user_id_check CHECK ((length(btrim(provider_user_id)) > 0))
);


--
-- Name: user_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_integrations (
    github_user_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    github_login text,
    codex_harness_auth text,
    codex_harness_connected_at timestamp with time zone,
    user_id uuid
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    display_name text,
    avatar_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: clerk_tenant_memberships clerk_tenant_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clerk_tenant_memberships
    ADD CONSTRAINT clerk_tenant_memberships_pkey PRIMARY KEY (tenant_id, clerk_user_id);


--
-- Name: clerk_tenant_memberships clerk_tenant_memberships_tenant_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clerk_tenant_memberships
    ADD CONSTRAINT clerk_tenant_memberships_tenant_id_user_id_key UNIQUE (tenant_id, user_id);


--
-- Name: context_execution_profiles context_execution_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.context_execution_profiles
    ADD CONSTRAINT context_execution_profiles_pkey PRIMARY KEY (tenant_id, build_id);


--
-- Name: dashboard_sessions dashboard_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_sessions
    ADD CONSTRAINT dashboard_sessions_pkey PRIMARY KEY (id);


--
-- Name: github_webhook_inbox github_webhook_inbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_webhook_inbox
    ADD CONSTRAINT github_webhook_inbox_pkey PRIMARY KEY (github_delivery_id);


--
-- Name: github_webhook_redelivery_requests github_webhook_redelivery_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_webhook_redelivery_requests
    ADD CONSTRAINT github_webhook_redelivery_requests_pkey PRIMARY KEY (github_delivery_id);


--
-- Name: installations installations_github_installation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.installations
    ADD CONSTRAINT installations_github_installation_id_key UNIQUE (github_installation_id);


--
-- Name: installations installations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.installations
    ADD CONSTRAINT installations_pkey PRIMARY KEY (id);


--
-- Name: pull_requests pull_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pull_requests
    ADD CONSTRAINT pull_requests_pkey PRIMARY KEY (id);


--
-- Name: pull_requests pull_requests_repository_id_pr_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pull_requests
    ADD CONSTRAINT pull_requests_repository_id_pr_number_key UNIQUE (repository_id, pr_number);


--
-- Name: repositories repositories_github_repo_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repositories
    ADD CONSTRAINT repositories_github_repo_id_key UNIQUE (github_repo_id);


--
-- Name: repositories repositories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repositories
    ADD CONSTRAINT repositories_pkey PRIMARY KEY (id);


--
-- Name: review_findings review_findings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_findings
    ADD CONSTRAINT review_findings_pkey PRIMARY KEY (id);


--
-- Name: review_findings review_findings_review_run_id_fingerprint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_findings
    ADD CONSTRAINT review_findings_review_run_id_fingerprint_key UNIQUE (review_run_id, fingerprint);


--
-- Name: review_llm_usage review_llm_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_llm_usage
    ADD CONSTRAINT review_llm_usage_pkey PRIMARY KEY (id);


--
-- Name: review_llm_usage review_llm_usage_review_run_id_dedupe_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_llm_usage
    ADD CONSTRAINT review_llm_usage_review_run_id_dedupe_key_key UNIQUE (review_run_id, dedupe_key);


--
-- Name: review_run_billing review_run_billing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_run_billing
    ADD CONSTRAINT review_run_billing_pkey PRIMARY KEY (review_run_id);


--
-- Name: review_run_events review_run_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_run_events
    ADD CONSTRAINT review_run_events_pkey PRIMARY KEY (id);


--
-- Name: review_runs review_runs_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_runs
    ADD CONSTRAINT review_runs_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: review_runs review_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_runs
    ADD CONSTRAINT review_runs_pkey PRIMARY KEY (id);


--
-- Name: tenant_billing_policy tenant_billing_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_billing_policy
    ADD CONSTRAINT tenant_billing_policy_pkey PRIMARY KEY (tenant_id);


--
-- Name: tenant_integrations tenant_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_integrations
    ADD CONSTRAINT tenant_integrations_pkey PRIMARY KEY (tenant_id);


--
-- Name: tenant_model_settings tenant_model_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_model_settings
    ADD CONSTRAINT tenant_model_settings_pkey PRIMARY KEY (tenant_id);


--
-- Name: tenants tenants_github_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_github_account_id_key UNIQUE (github_account_id);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: user_identities user_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_identities
    ADD CONSTRAINT user_identities_pkey PRIMARY KEY (provider, provider_user_id);


--
-- Name: user_identities user_identities_user_id_provider_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_identities
    ADD CONSTRAINT user_identities_user_id_provider_key UNIQUE (user_id, provider);


--
-- Name: user_integrations user_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_integrations
    ADD CONSTRAINT user_integrations_pkey PRIMARY KEY (github_user_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_clerk_tenant_memberships_clerk_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clerk_tenant_memberships_clerk_user ON public.clerk_tenant_memberships USING btree (clerk_user_id);


--
-- Name: idx_clerk_tenant_memberships_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clerk_tenant_memberships_user ON public.clerk_tenant_memberships USING btree (user_id, tenant_id);


--
-- Name: idx_dashboard_sessions_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dashboard_sessions_expires ON public.dashboard_sessions USING btree (expires_at);


--
-- Name: idx_dashboard_sessions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dashboard_sessions_user ON public.dashboard_sessions USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: idx_github_webhook_inbox_ready; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_github_webhook_inbox_ready ON public.github_webhook_inbox USING btree (status, available_at, received_at, github_delivery_id) WHERE (status = ANY (ARRAY['pending'::text, 'retry_wait'::text, 'leased'::text]));


--
-- Name: idx_github_webhook_inbox_repository_pr_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_github_webhook_inbox_repository_pr_order ON public.github_webhook_inbox USING btree (installation_id, repository_id, pull_request_number, received_at, github_delivery_id);


--
-- Name: idx_github_webhook_redelivery_requested_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_github_webhook_redelivery_requested_at ON public.github_webhook_redelivery_requests USING btree (last_requested_at);


--
-- Name: idx_installations_github_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_installations_github_account ON public.installations USING btree (github_account_id) WHERE (github_account_id IS NOT NULL);


--
-- Name: idx_installations_id_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_installations_id_tenant ON public.installations USING btree (id, tenant_id);


--
-- Name: idx_installations_installed_by_github_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_installations_installed_by_github_user ON public.installations USING btree (installed_by_github_user_id) WHERE (installed_by_github_user_id IS NOT NULL);


--
-- Name: idx_pull_requests_author_login; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pull_requests_author_login ON public.pull_requests USING btree (lower(author_login)) WHERE (author_login IS NOT NULL);


--
-- Name: idx_pull_requests_tenant_repo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pull_requests_tenant_repo ON public.pull_requests USING btree (tenant_id, repository_id);


--
-- Name: idx_repositories_installation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_repositories_installation_id ON public.repositories USING btree (installation_id) WHERE (installation_id IS NOT NULL);


--
-- Name: idx_repositories_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_repositories_tenant_id ON public.repositories USING btree (tenant_id);


--
-- Name: idx_review_findings_tenant_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_review_findings_tenant_run ON public.review_findings USING btree (tenant_id, review_run_id);


--
-- Name: idx_review_llm_usage_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_review_llm_usage_pending ON public.review_llm_usage USING btree (billing_status) WHERE (billing_status = 'pending'::text);


--
-- Name: idx_review_llm_usage_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_review_llm_usage_run ON public.review_llm_usage USING btree (review_run_id, recorded_at);


--
-- Name: idx_review_llm_usage_tracking; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_review_llm_usage_tracking ON public.review_llm_usage USING btree (claimed_at) WHERE (billing_status = 'tracking'::text);


--
-- Name: idx_review_run_billing_infra_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_review_run_billing_infra_pending ON public.review_run_billing USING btree (infra_billing_status) WHERE (infra_billing_status = 'pending'::text);


--
-- Name: idx_review_run_billing_infra_tracking; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_review_run_billing_infra_tracking ON public.review_run_billing USING btree (infra_claimed_at) WHERE (infra_billing_status = 'tracking'::text);


--
-- Name: idx_review_run_events_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_review_run_events_run ON public.review_run_events USING btree (review_run_id, recorded_at);


--
-- Name: idx_review_runs_board_workflow; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_review_runs_board_workflow ON public.review_runs USING btree (board_workflow_id) WHERE (board_workflow_id IS NOT NULL);


--
-- Name: idx_review_runs_manual_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_review_runs_manual_scope ON public.review_runs USING btree (repository_id, pull_request_id, created_at DESC, id DESC) WHERE (manual_command_tag IS NOT NULL);


--
-- Name: idx_review_runs_pull_request; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_review_runs_pull_request ON public.review_runs USING btree (pull_request_id) WHERE (pull_request_id IS NOT NULL);


--
-- Name: idx_review_runs_tenant_repo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_review_runs_tenant_repo ON public.review_runs USING btree (tenant_id, repository_id);


--
-- Name: idx_tenants_clerk_organization; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_tenants_clerk_organization ON public.tenants USING btree (clerk_organization_id) WHERE (clerk_organization_id IS NOT NULL);


--
-- Name: idx_tenants_personal_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_tenants_personal_owner ON public.tenants USING btree (personal_owner_user_id) WHERE ((kind = 'personal'::text) AND (personal_owner_user_id IS NOT NULL));


--
-- Name: idx_user_integrations_internal_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_user_integrations_internal_user ON public.user_integrations USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: idx_user_integrations_login; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_user_integrations_login ON public.user_integrations USING btree (lower(github_login));


--
-- Name: github_webhook_inbox github_webhook_inbox_identity_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER github_webhook_inbox_identity_immutable BEFORE UPDATE ON public.github_webhook_inbox FOR EACH ROW EXECUTE FUNCTION public.protect_github_webhook_inbox_identity();


--
-- Name: review_run_events review_run_events_dashboard_projection; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER review_run_events_dashboard_projection BEFORE INSERT OR UPDATE OF status, payload_json, dashboard_payload_json ON public.review_run_events FOR EACH ROW EXECUTE FUNCTION public.jina_dashboard_project_review_event();


--
-- Name: review_runs review_runs_dashboard_projection; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER review_runs_dashboard_projection BEFORE INSERT OR UPDATE OF result_json, dashboard_result_json ON public.review_runs FOR EACH ROW EXECUTE FUNCTION public.jina_dashboard_project_review_run();


--
-- Name: clerk_tenant_memberships clerk_tenant_memberships_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clerk_tenant_memberships
    ADD CONSTRAINT clerk_tenant_memberships_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: clerk_tenant_memberships clerk_tenant_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clerk_tenant_memberships
    ADD CONSTRAINT clerk_tenant_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: context_execution_profiles context_execution_profiles_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.context_execution_profiles
    ADD CONSTRAINT context_execution_profiles_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: dashboard_sessions dashboard_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_sessions
    ADD CONSTRAINT dashboard_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: installations installations_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.installations
    ADD CONSTRAINT installations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: pull_requests pull_requests_repository_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pull_requests
    ADD CONSTRAINT pull_requests_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;


--
-- Name: pull_requests pull_requests_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pull_requests
    ADD CONSTRAINT pull_requests_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: repositories repositories_installation_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repositories
    ADD CONSTRAINT repositories_installation_tenant_fk FOREIGN KEY (installation_id, tenant_id) REFERENCES public.installations(id, tenant_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: repositories repositories_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repositories
    ADD CONSTRAINT repositories_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: review_findings review_findings_review_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_findings
    ADD CONSTRAINT review_findings_review_run_id_fkey FOREIGN KEY (review_run_id) REFERENCES public.review_runs(id) ON DELETE CASCADE;


--
-- Name: review_findings review_findings_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_findings
    ADD CONSTRAINT review_findings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: review_llm_usage review_llm_usage_review_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_llm_usage
    ADD CONSTRAINT review_llm_usage_review_run_id_fkey FOREIGN KEY (review_run_id) REFERENCES public.review_runs(id) ON DELETE CASCADE;


--
-- Name: review_llm_usage review_llm_usage_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_llm_usage
    ADD CONSTRAINT review_llm_usage_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: review_run_billing review_run_billing_review_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_run_billing
    ADD CONSTRAINT review_run_billing_review_run_id_fkey FOREIGN KEY (review_run_id) REFERENCES public.review_runs(id) ON DELETE CASCADE;


--
-- Name: review_run_billing review_run_billing_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_run_billing
    ADD CONSTRAINT review_run_billing_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: review_run_events review_run_events_review_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_run_events
    ADD CONSTRAINT review_run_events_review_run_id_fkey FOREIGN KEY (review_run_id) REFERENCES public.review_runs(id) ON DELETE CASCADE;


--
-- Name: review_runs review_runs_board_workflow_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_runs
    ADD CONSTRAINT review_runs_board_workflow_fk FOREIGN KEY (board_workflow_id) REFERENCES jina_runtime.board_workflows(id) ON DELETE RESTRICT;


--
-- Name: review_runs review_runs_pull_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_runs
    ADD CONSTRAINT review_runs_pull_request_id_fkey FOREIGN KEY (pull_request_id) REFERENCES public.pull_requests(id) ON DELETE SET NULL;


--
-- Name: review_runs review_runs_repository_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_runs
    ADD CONSTRAINT review_runs_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;


--
-- Name: review_runs review_runs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_runs
    ADD CONSTRAINT review_runs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tenant_billing_policy tenant_billing_policy_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_billing_policy
    ADD CONSTRAINT tenant_billing_policy_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tenant_integrations tenant_integrations_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_integrations
    ADD CONSTRAINT tenant_integrations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tenant_model_settings tenant_model_settings_context_harness_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_model_settings
    ADD CONSTRAINT tenant_model_settings_context_harness_owner_user_id_fkey FOREIGN KEY (context_harness_owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: tenant_model_settings tenant_model_settings_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_model_settings
    ADD CONSTRAINT tenant_model_settings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tenants tenants_personal_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_personal_owner_user_id_fkey FOREIGN KEY (personal_owner_user_id) REFERENCES public.users(id);


--
-- Name: user_identities user_identities_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_identities
    ADD CONSTRAINT user_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_integrations user_integrations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_integrations
    ADD CONSTRAINT user_integrations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--
