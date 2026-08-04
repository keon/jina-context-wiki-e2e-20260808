export type ReviewEvent = {
  status: string;
  payload?: unknown;
  trigger_run_id?: string;
  recorded_at: string;
};

export type ProjectRecord = {
  github_repo_id?: number;
  full_name: string;
  owner: string;
  name: string;
  private?: boolean;
};

export type FindingRecord = {
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

export type ReviewRunRecord = {
  review_run_id: string;
  trigger_run_id?: string;
  delivery_id?: string;
  source_event?: string;
  trigger?: string;
  status: string;
  bot: {
    type: string;
    status: string;
  };
  installation?: {
    github_installation_id?: number;
  };
  repository: {
    github_repo_id?: number;
    owner?: string;
    name?: string;
    full_name?: string;
    private?: boolean;
  };
  pull_request: {
    number?: number;
    title?: string;
    html_url?: string;
    author?: string;
    head_sha?: string;
    base_sha?: string;
    head_ref?: string;
    base_ref?: string;
  };
  result?: unknown;
  error?: string;
  // Per-run credit billing (from review_run_billing). Absent when the run has no billing row.
  // infra/ai/total are null until charges settle; key_source explains a 0 AI charge (harness/user =
  // own compute, managed = Jina-billed).
  billing?: {
    key_source?: string;
    rate_mode?: string;
    infra_credits: number | null;
    ai_credits: number | null;
    total_credits: number | null;
    infra_status?: string;
  };
  events: ReviewEvent[];
  created_at: string;
  updated_at: string;
  finished_at?: string;
};

export type DashboardData = {
  generated_at: string;
  bots: Array<{
    id: string;
    type: string;
    repository?: string;
    pull_request?: number;
    status: string;
    last_run_at: string;
    last_error?: string;
  }>;
  review_runs: ReviewRunRecord[];
  issues: FindingRecord[];
  pagination?: {
    limit: number;
    next_cursor?: string;
  };
};

export function buildDashboard(
  reviewRuns: ReviewRunRecord[],
  issues: FindingRecord[] = [],
  pagination?: DashboardData["pagination"],
): DashboardData {
  const bots = reviewRuns.map((run) => ({
    id: `code_review:${run.repository.github_repo_id ?? run.repository.full_name ?? run.review_run_id}`,
    type: run.bot.type,
    repository: run.repository.full_name,
    pull_request: run.pull_request.number,
    status: run.bot.status,
    last_run_at: run.updated_at,
    last_error: run.error,
  }));

  return {
    generated_at: new Date().toISOString(),
    bots,
    review_runs: reviewRuns,
    issues,
    pagination,
  };
}
