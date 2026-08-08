export interface DashboardResponse {
  // Newest activity in the payload (max review-run `updated_at` / issue `created_at`), null when the
  // workspace has no rows yet. The API derives this from the data rather than the clock, which is what
  // lets an unchanged poll revalidate to a 304 instead of shipping an identical body every 10s.
  generated_at: string | null;
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
}

export interface ReviewRunDetailResponse {
  review_run: ReviewRun;
}

interface DashboardProject {
  id: string;
  github_repo_id?: number;
  full_name: string;
  owner: string;
  name: string;
  private?: boolean;
  html_url?: string;
  source: "github" | "observed";
}

interface DashboardTeam {
  id: string;
  github_team_id: number;
  name: string;
  slug: string;
  html_url?: string;
  organization: { id?: number; login: string; avatar_url?: string };
  project_full_names: string[];
}

export interface ViewerResponse {
  auth: { mode: "disabled" | "clerk"; enabled: boolean };
  github_app?: { install_url?: string; installed?: boolean } | undefined;
  authenticated: boolean;
  user?: {
    /** Linked GitHub account id used for GitHub-facing account details. */
    id: number;
    /** Stable Jina user id resolved from the Clerk identity. */
    internal_id?: string;
    login: string;
    name?: string | null;
    avatar_url?: string;
    html_url?: string;
  };
  organizations: { id: number; login: string; avatar_url?: string }[];
  teams: DashboardTeam[];
  projects: DashboardProject[];
}

export interface DashboardFilters { project: string; team: string }

interface BotStatus {
  id: string;
  type: string;
  repository?: string;
  pull_request?: number;
  status: string;
  last_run_at: string;
  last_error?: string;
}

export interface ReviewRun {
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
    findings?: ReviewIssue[];
    github_comment_url?: string;
    error?: string;
  };
  error?: string;
  events: ReviewEvent[];
  created_at: string;
  updated_at: string;
  finished_at?: string;
}

export interface ReviewIssue {
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
}

export interface ReviewEvent {
  status: string;
  payload?: unknown;
  trigger_run_id?: string;
  recorded_at: string;
}

export type Tone = "ok" | "warn" | "bad" | "info" | "";

export interface InstallationResult { action: string; installationId?: string | undefined }
