export type DashboardResponse = {
  generated_at: string;
  bots: BotStatus[];
  review_runs: ReviewRun[];
  issues: ReviewIssue[];
  projects: DashboardProject[];
  teams: DashboardTeam[];
  filters?: { project?: string; team?: string };
  pagination?: {
    limit: number;
    next_cursor?: string;
  };
};

export type ReviewRunDetailResponse = {
  review_run: ReviewRun;
};

type DashboardProject = {
  id: string;
  github_repo_id?: number;
  full_name: string;
  owner: string;
  name: string;
  private?: boolean;
  html_url?: string;
  source: "github" | "observed";
};

type DashboardTeam = {
  id: string;
  github_team_id: number;
  name: string;
  slug: string;
  html_url?: string;
  organization: { id?: number; login: string; avatar_url?: string };
  project_full_names: string[];
};

export type ViewerResponse = {
  auth: { mode: "disabled" | "github" | "clerk"; enabled: boolean };
  github_app?: { install_url?: string; installed?: boolean };
  authenticated: boolean;
  user?: {
    /** Legacy GitHub id retained during the rolling identity transition. */
    id: number;
    /** Stable Jina user id for new consumers. */
    internal_id?: string;
    login: string;
    name?: string | null;
    avatar_url?: string;
    html_url?: string;
  };
  organizations: Array<{ id: number; login: string; avatar_url?: string }>;
  teams: DashboardTeam[];
  projects: DashboardProject[];
};

export type DashboardFilters = { project: string; team: string };

type BotStatus = {
  id: string;
  type: string;
  repository?: string;
  pull_request?: number;
  status: string;
  last_run_at: string;
  last_error?: string;
};

export type ReviewRun = {
  review_run_id: string;
  trigger_run_id?: string;
  delivery_id?: string;
  status: string;
  // Per-run credit billing. Absent for runs with no billing row; credits are null until settled.
  billing?: {
    key_source?: string;
    rate_mode?: string;
    infra_credits: number | null;
    ai_credits: number | null;
    total_credits: number | null;
    infra_status?: string;
  };
  bot: { type: string; status: string };
  repository: { github_repo_id?: number; full_name?: string; owner?: string; name?: string };
  pull_request: {
    number?: number;
    title?: string;
    html_url?: string;
    author?: string;
    head_sha?: string;
    head_ref?: string;
    base_ref?: string;
  };
  result?: {
    status?: string;
    changed_files?: string[];
    diff_stat?: string;
    codegraph_context?: string;
    review_mode?: "scenario" | "qa";
    run_plan?: {
      verb?: "run" | "answer";
      mode?: "scenario" | "qa";
      stages?: {
        generate?: boolean;
        simulate?: boolean;
        finalReview?: boolean;
      };
      reasoning?: string;
    };
    review_gate?: {
      blocking_level: string;
      conclusion: string;
      blocking: boolean;
      blocking_count: number;
      scenario_counts: { total: number; high: number; medium: number; low: number; unknown: number };
    };
    review_markdown?: string;
    markdown_preview?: string;
    scenario_json?: ScenarioGenerationJson;
    simulation?: ScenarioSimulationResult;
    final_review?: {
      status: "passed" | "issues_found" | "warned";
      summary: string;
      markdown: string;
      findings: ReviewIssue[];
      error?: string;
    };
    findings?: ReviewIssue[];
    github_comment_url?: string;
    github_check_run_url?: string;
    publish_error?: string;
    simulation_error?: string;
    final_review_error?: string;
    error?: string;
  };
  error?: string;
  events: ReviewEvent[];
  created_at: string;
  updated_at: string;
  finished_at?: string;
};

type ScenarioGenerationJson = {
  schemaVersion?: number;
  pr?: {
    owner?: string;
    repo?: string;
    number?: number;
    url?: string;
  };
  scenarios?: GeneratedScenarioJson[];
};

type GeneratedScenarioJson = {
  id?: string;
  title?: string;
  summary?: string;
  riskLevel?: "high" | "medium" | "low" | "unknown";
  surface?: string[];
  riskTypes?: string[];
  evidenceSources?: string[];
  files?: string[];
  symbols?: string[];
  preconditions?: string[];
  steps?: string[];
  expectedOutcome?: string[];
  rationale?: string;
};

export type ReviewIssue = {
  id: string;
  review_run_id: string;
  fingerprint: string;
  file_path?: string;
  line_number?: number;
  severity: string;
  category: string;
  body: string;
  github_comment_id?: number;
  created_at: string;
  repository?: string;
  pull_request?: number;
  pull_request_title?: string;
  pull_request_url?: string;
};

export type ReviewEvent = {
  status: string;
  payload?: unknown;
  trigger_run_id?: string;
  recorded_at: string;
};

export type Tone = "ok" | "warn" | "bad" | "info" | "";

export type ScenarioDisplayStatus = "blocking" | "generated" | "running" | "queued" | "complete" | "pass" | "fail" | "warn";

export type ScenarioSimulationStatus = "pass" | "fail" | "warn";

type ScenarioSimulationResult = {
  mode: string;
  status: "passed" | "failed" | "warned";
  commit: string;
  started_at?: string;
  completed_at: string;
  duration_ms?: number;
  concurrency?: number;
  max_rounds_per_step: number;
  provider_config?: {
    codex_model?: string;
    codex_effort?: string;
    claude_model?: string;
    claude_effort?: string;
    judge_provider?: "claude" | "codex";
  };
  model_concurrency?: number;
  no_target_code_execution: boolean;
  counts: { total: number; pass: number; fail: number; warn: number };
  scenarios: ScenarioSimulationScenario[];
  error?: string;
};

export type ScenarioSimulationScenario = {
  id: string;
  index: number;
  lineage_key: string;
  title: string;
  risk: "high" | "medium" | "low" | "unknown";
  status: ScenarioSimulationStatus;
  final_verdict: string;
  confidence: number;
  total_steps: number;
  executed_steps: number[];
  source_files: string[];
  steps: ScenarioSimulationStep[];
  duration_ms?: number;
  warning?: string;
};

export type ScenarioSimulationStep = {
  step_index: number;
  step_text: string;
  step_status: string;
  scenario_verdict: string;
  consensus_reached: boolean;
  predicted_output: string;
  state_changes: unknown[];
  boundary_findings: unknown[];
  source_citations: unknown[];
  confidence: number;
  duration_ms?: number;
  rounds?: number;
};

export type ScenarioTrailEntry = {
  marker: string;
  type: "setup" | "action" | "assertion" | "observation" | "context";
  description: string;
  detail?: string;
};

export type InstallationResult = { action: string; installationId?: string };
