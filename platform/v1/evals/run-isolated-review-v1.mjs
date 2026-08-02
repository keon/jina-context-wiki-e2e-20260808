#!/usr/bin/env node
/**
 * Run the active review runtime implementation pipeline against one Golden
 * Dataset 1 PR while keeping golden reference issues out of the subprocess.
 *
 * This is the v1 local eval harness for the consolidated Trigger `review`
 * workflow's runtime-review implementation:
 *
 *   intent -> expectation plan -> expectation agents -> reviewer -> readiness
 *
 * It intentionally does not enqueue Trigger.dev, call the internal API, create
 * Daytona sandboxes, or publish GitHub reviews/comments. It runs the
 * implementation source locally in a temporary worker copy and writes artifacts
 * under evals/runs.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_DATASET = join(SCRIPT_DIR, "golden-dataset-1.json");
const DEFAULT_TMP_EVAL_DIR = join(REPO_ROOT, "tmp", "evals", "review-runtime-v1");
const DEFAULT_METHOD = "trigger-review-runtime-v1-current-2026-06-29";
const DEFAULT_HISTORY_MARKDOWN = [
  "No GitHub PR thread/history context supplied for isolated review-runtime eval.",
  "The subprocess must use only PR metadata, the checked-out repository, diff, and CodeGraph context.",
].join("\n");

function usage() {
  return `Usage:
  node evals/run-isolated-review-v1.mjs --repo owner/repo --pr 1234
  node evals/run-isolated-review-v1.mjs --repo owner/repo --rank E1

Options:
  --repo owner/repo       Repository slug from Golden Dataset 1. Required when rank is ambiguous.
  --pr N                 Pull request number from Golden Dataset 1.
  --rank RANK            Golden Dataset rank, e.g. E1. If rank appears in multiple repos, --repo is required.
  --dataset FILE         Golden dataset JSON. Default: ${DEFAULT_DATASET}
  --no-dataset           Run an arbitrary PR that is not in the golden dataset; skips golden leakage scan.
  --out DIR              Output directory. Default:
                         evals/runs/golden-dataset-1/<repo-safe>/pr-<N>/review-runtime-v1
                         With --no-dataset: tmp/evals/review-runtime-v1/<repo-safe>/pr-<N>
  --method NAME          Method label for metadata. Default: ${DEFAULT_METHOD}
  --dry-run              Write inputs and isolation report, but do not run review.
  --force                Remove an existing output directory before writing.
  --allow-leakage        Warn instead of failing if output mentions withheld golden data.
  --github-token TOKEN   GitHub token for API metadata and git clone. Default: env, gh auth, or git credentials.
  --clone-token TOKEN    Optional separate token for git clone. Default: GITHUB_CLONE_TOKEN or github token.
  --codex-bin BIN        Codex CLI used by the runtime implementation. Default: CODEX_BIN or codex.
  --codegraph-bin BIN    CodeGraph CLI used by the runtime implementation. Default: CODEGRAPH_BIN or codegraph.
  --tsx-bin CMD          TypeScript runner command. Default: TSX_BIN or "npx --yes tsx".
  --timeout-ms N         Subprocess timeout. Default: ISOLATED_REVIEW_RUNTIME_TIMEOUT_MS or 3600000.
  --no-github-api        Do not fetch PR metadata; requires --head-sha and --base-ref.
  --head-sha SHA         Override PR head SHA, or provide it when --no-github-api is used.
  --base-sha SHA         Override historical PR base SHA. Default: fetched from GitHub PR metadata.
  --base-ref REF         Override base ref, or provide it when --no-github-api is used.
  --head-ref REF         Override head ref.
  --title TITLE          Override PR title.
  --author LOGIN         Override PR author.
  --max-expectations N   Eval-only cap on expectation count. Default: production uncapped.
  --area-concurrency N   Eval-only cap on parallel expectation agents. Default: production uncapped.
  --task-concurrency N   Eval-only cap on parallel tool calls per agent. Default: production uncapped.
  --max-mental-trace N   Eval-only cap on mental_trace calls per agent. Default: production uncapped.
  --max-agent-iterations N
                         Eval-only cap on agent iterations. Default: production uncapped.
  --help                 Show this help.

Isolation:
  The golden dataset is used only by this parent harness to select the target PR
  and to run post-review leakage checks. The review subprocess receives only PR
  metadata, source/diff/CodeGraph context, and credentials. It does not receive
  reference issues, evidence summaries, fix PRs, golden ranks, or bucket data.

Credential resolution is non-interactive:
  --github-token / GITHUB_TOKEN / GH_TOKEN, then gh auth token, then git credential fill.
`;
}

function parseArgs(argv) {
  const args = {
    repo: "",
    pr: 0,
    rank: "",
    dataset: DEFAULT_DATASET,
    noDataset: false,
    out: "",
    method: DEFAULT_METHOD,
    dryRun: false,
    force: false,
    allowLeakage: false,
    githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
    cloneToken: process.env.GITHUB_CLONE_TOKEN || "",
    codexBin: process.env.CODEX_BIN || "codex",
    codegraphBin: process.env.CODEGRAPH_BIN || "codegraph",
    tsxBin: process.env.TSX_BIN || "npx --yes tsx",
    timeoutMs: Number.parseInt(process.env.ISOLATED_REVIEW_RUNTIME_TIMEOUT_MS || "3600000", 10),
    noGithubApi: false,
    headSha: "",
    baseSha: "",
    baseRef: "",
    headRef: "",
    title: "",
    author: "",
    maxExpectations: 0,
    areaConcurrency: 0,
    taskConcurrency: 0,
    maxMentalTrace: 0,
    maxAgentIterations: 0,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (a === "--repo") args.repo = argv[++i] || "";
    else if (a === "--pr") args.pr = numberArg(a, argv[++i]);
    else if (a === "--rank") args.rank = argv[++i] || "";
    else if (a === "--dataset") args.dataset = resolve(argv[++i] || "");
    else if (a === "--no-dataset") args.noDataset = true;
    else if (a === "--out") args.out = resolve(argv[++i] || "");
    else if (a === "--method") args.method = argv[++i] || DEFAULT_METHOD;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--force") args.force = true;
    else if (a === "--allow-leakage") args.allowLeakage = true;
    else if (a === "--github-token") args.githubToken = argv[++i] || "";
    else if (a === "--clone-token") args.cloneToken = argv[++i] || "";
    else if (a === "--codex-bin") args.codexBin = argv[++i] || "";
    else if (a === "--codegraph-bin") args.codegraphBin = argv[++i] || "";
    else if (a === "--tsx-bin") args.tsxBin = argv[++i] || "";
    else if (a === "--timeout-ms") args.timeoutMs = numberArg(a, argv[++i]);
    else if (a === "--no-github-api") args.noGithubApi = true;
    else if (a === "--head-sha") args.headSha = argv[++i] || "";
    else if (a === "--base-sha") args.baseSha = argv[++i] || "";
    else if (a === "--base-ref") args.baseRef = argv[++i] || "";
    else if (a === "--head-ref") args.headRef = argv[++i] || "";
    else if (a === "--title") args.title = argv[++i] || "";
    else if (a === "--author") args.author = argv[++i] || "";
    else if (a === "--max-expectations") args.maxExpectations = numberArg(a, argv[++i]);
    else if (a === "--area-concurrency") args.areaConcurrency = numberArg(a, argv[++i]);
    else if (a === "--task-concurrency") args.taskConcurrency = numberArg(a, argv[++i]);
    else if (a === "--max-mental-trace") args.maxMentalTrace = numberArg(a, argv[++i]);
    else if (a === "--max-agent-iterations") args.maxAgentIterations = numberArg(a, argv[++i]);
    else throw new Error(`Unknown argument: ${a}\n${usage()}`);
  }

  if (args.noDataset && args.rank) throw new Error("--rank cannot be used with --no-dataset");
  if (!args.noDataset && !existsSync(args.dataset)) throw new Error(`Missing dataset file: ${args.dataset}`);
  if (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 1000) {
    throw new Error("--timeout-ms must be at least 1000");
  }
  return args;
}

function numberArg(name, value) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

async function resolveLocalCredentials(args) {
  if (!args.githubToken) args.githubToken = await resolveGithubToken();
  if (!args.cloneToken) args.cloneToken = process.env.GITHUB_CLONE_TOKEN || args.githubToken;
  return args;
}

async function resolveGithubToken() {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  if (fromEnv.trim()) return fromEnv.trim();

  const ghToken = await tryCommand("gh", ["auth", "token"], {
    env: process.env,
    timeoutMs: 10_000,
  });
  if (ghToken.stdout.trim()) return ghToken.stdout.trim();

  const gitCredential = await tryCommand("git", ["credential", "fill"], {
    env: process.env,
    input: "protocol=https\nhost=github.com\n\n",
    timeoutMs: 10_000,
  });
  const parsed = parseGitCredential(gitCredential.stdout);
  return parsed.password || parsed.oauth_token || parsed.token || "";
}

function parseGitCredential(text) {
  const result = {};
  for (const line of String(text || "").split("\n")) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    result[line.slice(0, index)] = line.slice(index + 1);
  }
  return result;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse JSON from ${path}: ${error.message}`);
  }
}

function resolveDatasetTarget(dataset, args) {
  let match;
  if (args.rank) {
    const matches = findDatasetEntriesByRank(dataset, args.rank, args.repo);
    if (matches.length === 0) {
      throw new Error(`No Golden Dataset 1 entry found for rank ${args.rank}${args.repo ? ` in ${args.repo}` : ""}`);
    }
    if (matches.length > 1) {
      const choices = matches
        .map((item) => `${item.repoResult.repository}#${item.entry.introducing_pr?.number}`)
        .join(", ");
      throw new Error(`Rank ${args.rank} is ambiguous; pass --repo. Matches: ${choices}`);
    }
    match = matches[0];
    args.repo = match.repoResult.repository;
    args.pr = match.entry.introducing_pr?.number || 0;
  }

  if (!args.repo) throw new Error(`--repo is required\n${usage()}`);
  if (!args.pr) throw new Error(`--pr or --rank is required\n${usage()}`);

  const byPr = findDatasetEntry(dataset, args.repo, args.pr);
  if (!byPr) throw new Error(`No Golden Dataset 1 entry found for ${args.repo} PR #${args.pr}`);
  if (match && byPr.entry !== match.entry) {
    throw new Error(`--rank ${args.rank} does not match ${args.repo} PR #${args.pr}`);
  }
  return byPr;
}

function findDatasetEntry(dataset, repo, prNumber) {
  for (const repoResult of asArray(dataset.repo_results)) {
    if (repoResult.repository !== repo) continue;
    for (const entry of asArray(repoResult.entries)) {
      if (entry?.introducing_pr?.number === prNumber) return { repoResult, entry };
    }
  }
  return undefined;
}

function findDatasetEntriesByRank(dataset, rank, repo) {
  const normalizedRank = String(rank || "").trim().toUpperCase();
  const matches = [];
  for (const repoResult of asArray(dataset.repo_results)) {
    if (repo && repoResult.repository !== repo) continue;
    for (const entry of asArray(repoResult.entries)) {
      if (String(entry?.rank || "").trim().toUpperCase() === normalizedRank) {
        matches.push({ repoResult, entry });
      }
    }
  }
  return matches;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

async function fetchPullRequestMetadata(args, datasetEntry = {}) {
  const [owner, name] = args.repo.split("/");
  const fallback = {
    title: args.title || datasetEntry.introducing_pr?.title || "",
    author: args.author || "",
    headSha: args.headSha || "",
    baseSha: args.baseSha || "",
    headRef: args.headRef || "",
    baseRef: args.baseRef || "",
    repository: { owner, name, fullName: args.repo },
  };

  if (args.noGithubApi) {
    if (!fallback.headSha || !fallback.baseRef) {
      throw new Error("--head-sha and --base-ref are required with --no-github-api");
    }
    return fallback;
  }

  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "jina-simulation-evals",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (args.githubToken) headers.Authorization = `Bearer ${args.githubToken}`;

  const response = await fetch(`https://api.github.com/repos/${args.repo}/pulls/${args.pr}`, { headers });
  if (!response.ok) {
    throw new Error(`GitHub PR metadata request failed: ${response.status} ${await response.text()}`);
  }
  const pr = await response.json();
  return {
    title: args.title || stringValue(pr.title) || fallback.title,
    author: args.author || stringValue(pr.user?.login) || fallback.author,
    headSha: args.headSha || stringValue(pr.head?.sha) || fallback.headSha,
    baseSha: args.baseSha || stringValue(pr.base?.sha) || fallback.baseSha,
    headRef: args.headRef || stringValue(pr.head?.ref) || fallback.headRef,
    baseRef: args.baseRef || stringValue(pr.base?.ref) || fallback.baseRef,
    repository: { owner, name, fullName: args.repo },
  };
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function buildReviewInput(args, prMetadata) {
  const [owner, name] = args.repo.split("/");
  if (!owner || !name) throw new Error(`Invalid --repo value: ${args.repo}`);
  if (!prMetadata.headSha) throw new Error("Could not determine PR head SHA; use --head-sha");
  if (!prMetadata.baseRef) throw new Error("Could not determine PR base ref; use --base-ref");

  return {
    repository: { owner, name, fullName: args.repo },
    token: args.githubToken,
    cloneToken: args.cloneToken || args.githubToken,
    pullRequestNumber: args.pr,
    title: prMetadata.title,
    author: prMetadata.author,
    headSha: prMetadata.headSha,
    baseSha: prMetadata.baseSha,
    baseRef: prMetadata.baseRef,
    headRef: prMetadata.headRef,
    historyMarkdown: DEFAULT_HISTORY_MARKDOWN,
  };
}

function redactReviewInput(input) {
  return {
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    title: input.title,
    author: input.author,
    headSha: input.headSha,
    baseSha: input.baseSha,
    baseRef: input.baseRef,
    headRef: input.headRef,
    historyMarkdown: input.historyMarkdown,
    token_present: Boolean(input.token),
    clone_token_present: Boolean(input.cloneToken),
  };
}

function prepareOutputDir(args) {
  const out = args.out || (args.noDataset
    ? join(DEFAULT_TMP_EVAL_DIR, safeName(args.repo), `pr-${args.pr}`)
    : join(SCRIPT_DIR, "runs", "golden-dataset-1", safeName(args.repo), `pr-${args.pr}`, "review-runtime-v1"));
  if (existsSync(out) && args.force) {
    assertSafeOutputRemoval(out);
    rmSync(out, { recursive: true, force: true });
  }
  mkdirSync(out, { recursive: true });
  return out;
}

function assertSafeOutputRemoval(out) {
  const resolved = resolve(out);
  const protectedPaths = new Set([
    resolve("/"),
    REPO_ROOT,
    SCRIPT_DIR,
    resolve(REPO_ROOT, "trigger"),
    resolve(REPO_ROOT, "api"),
    resolve(REPO_ROOT, "dashboard"),
  ]);
  if (protectedPaths.has(resolved)) throw new Error(`Refusing to remove protected output path: ${resolved}`);
}

function safeName(value) {
  return String(value || "item")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

function buildIsolationReport(args, datasetMatch, reviewInput) {
  const referenceIssues = datasetMatch ? asArray(datasetMatch.entry.introduced_issues) : [];
  const fixPrs = datasetMatch ? asArray(datasetMatch.entry.fix_prs) : [];
  return {
    isolation_model: datasetMatch
      ? "parent harness selects target from golden dataset; child review subprocess receives only production PR input"
      : "parent harness selects arbitrary PR; child review subprocess receives only production PR input",
    review_subprocess_cwd: "temporary directory outside evals/",
    implementation_pipeline: "temporary worker copy of trigger/src/runtime-review/index.ts#runRuntimeReview",
    trigger_workflow_context: {
      active_parent_task: "review",
      covered_stage: "review-runtime",
      covered_pipeline: "intent -> expectation plan -> expectation agents -> final runtime review",
      omitted_side_effects: [
        "Trigger.dev enqueue/batch orchestration",
        "internal API prepare/event/complete calls",
        "Daytona sandbox creation",
        "GitHub progress comments",
        "GitHub PR reviews/comments",
      ],
    },
    eval_local_worker_patches: [
      "remove git clone --depth=100 in the temporary worker copy so older golden PRs have a merge base",
      "pin the temporary worker's origin/<base-ref> to the PR metadata base SHA for historical merged PRs",
      "increase temporary worker git checkout/diff timeouts for golden-dataset clones",
      "copy the temporary runtime workspace into the eval output directory before cleanup",
      "add an eval-isolation prompt boundary in the temporary worker copy without editing production source",
      "optionally honor eval-only caps for expectation count, concurrency, mental traces, and agent iterations",
    ],
    review_input: redactReviewInput(reviewInput),
    withheld_from_review: datasetMatch
      ? {
          dataset_file: basename(args.dataset),
          rank: datasetMatch.entry.rank,
          bucket: datasetMatch.entry.bucket,
          complexity_rationale: true,
          reference_issue_count: referenceIssues.length,
          reference_issue_numbers: referenceIssues.map((issue) => issue.number).filter(Boolean),
          reference_issue_titles: true,
          reference_issue_urls: true,
          evidence_summary: true,
          fix_pr_count: fixPrs.length,
          fix_pr_urls: true,
        }
      : {
          dataset_file: null,
          rank: null,
          bucket: null,
          reference_issue_count: null,
          note: "No golden dataset entry was used for this arbitrary-PR run.",
        },
    post_review_uses_of_golden_data: datasetMatch ? ["leakage scan"] : [],
  };
}

async function runReviewSubprocess(args, reviewInput, out) {
  const workerDir = mkdtempSync(join(tmpdir(), "jina-isolated-review-runtime-v1-"));
  const runnerPath = join(workerDir, "runner.ts");
  const inputPath = join(workerDir, "input.json");
  const resultPath = join(workerDir, "result.json");
  const artifactDir = join(out, "runtime-workspace");

  writeWorkerSources(workerDir, args);
  writeFileSync(inputPath, `${JSON.stringify({ input: reviewInput }, null, 2)}\n`);
  writeFileSync(runnerPath, runnerSource(workerDir, inputPath, resultPath));

  try {
    const tsx = splitCommand(args.tsxBin);
    const child = await runCommand(tsx.command, [...tsx.args, runnerPath], {
      cwd: workerDir,
      env: isolatedEnv(args, artifactDir),
      timeoutMs: args.timeoutMs,
      maxBufferBytes: 48 * 1024 * 1024,
    });
    writeFileSync(join(out, "review-subprocess.stdout.txt"), child.stdout);
    writeFileSync(join(out, "review-subprocess.stderr.txt"), child.stderr);
    return readJson(resultPath);
  } finally {
    rmSync(workerDir, { recursive: true, force: true });
  }
}

function writeWorkerSources(workerDir, args) {
  mkdirSync(join(workerDir, "shared"), { recursive: true });
  mkdirSync(join(workerDir, "runtime-review"), { recursive: true });
  writeFileSync(join(workerDir, "shared", "utils.ts"), readFileSync(join(REPO_ROOT, "trigger", "src", "shared", "utils.ts"), "utf8"));
  writeFileSync(join(workerDir, "runtime-review", "index.ts"), patchedRuntimeReviewSource(args));
}

function patchedRuntimeReviewSource(args) {
  const sourcePath = join(REPO_ROOT, "trigger", "src", "runtime-review", "index.ts");
  let source = readFileSync(sourcePath, "utf8");

  source = source.replace(
    `import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";`,
    `import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";`,
  );
  source = source.replace(
    `["clone", "--no-tags", "--depth=100", repoUrl, input.repoDir]`,
    `["clone", "--no-tags", repoUrl, input.repoDir]`,
  );
  source = addEvalGitTimeouts(source);
  source = addEvalBaseShaCheckout(source);
  source = addEvalRuntimeCaps(source);
  source = addEvalArtifactCopy(source);
  source = addEvalIsolationPromptBoundary(source);

  if (args.codexBin && args.codexBin !== "codex") {
    // No source patch is needed; CODEX_BIN is set in the subprocess env.
  }
  return source;
}

function addEvalBaseShaCheckout(source) {
  source = source.replace(
    `      baseRef: input.baseRef,
      repoDir,
    });`,
    `      baseRef: input.baseRef,
      baseSha: (input as RuntimeReviewInput & { baseSha?: string }).baseSha,
      repoDir,
    });`,
  );
  source = source.replace(
    `  baseRef: string;
  repoDir: string;
}): Promise<void> {`,
    `  baseRef: string;
  baseSha?: string;
  repoDir: string;
}): Promise<void> {`,
  );

  const original = `  await runCommand("git", ["fetch", "--no-tags", "origin", \`+refs/heads/\${input.baseRef}:refs/remotes/origin/\${input.baseRef}\`], {
    cwd: input.repoDir,
    env: gitEnv,
    timeoutMs: evalGitTimeoutMs(),
  });
`;
  const replacement = `  if (input.baseSha?.trim()) {
    await runCommand("git", ["update-ref", \`refs/remotes/origin/\${input.baseRef}\`, input.baseSha.trim()], {
      cwd: input.repoDir,
      timeoutMs: evalGitTimeoutMs(),
    });
  } else {
    await runCommand("git", ["fetch", "--no-tags", "origin", \`+refs/heads/\${input.baseRef}:refs/remotes/origin/\${input.baseRef}\`], {
      cwd: input.repoDir,
      env: gitEnv,
      timeoutMs: evalGitTimeoutMs(),
    });
  }
`;
  if (!source.includes(original)) {
    throw new Error("Could not patch historical base SHA checkout in trigger/src/runtime-review/index.ts");
  }
  return source.replace(original, replacement);
}

function addEvalGitTimeouts(source) {
  source = source.replaceAll("timeoutMs: 120_000", "timeoutMs: evalGitTimeoutMs()");
  source = source.replaceAll("timeoutMs: 60_000", "timeoutMs: evalGitTimeoutMs()");
  const anchor = `async function checkoutPullRequest(input: {
`;
  const helper = `function evalGitTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.EVAL_REVIEW_GIT_TIMEOUT_MS || "600000", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 600_000;
}

`;
  if (!source.includes(anchor)) {
    throw new Error("Could not locate checkoutPullRequest for git timeout patch in trigger/src/runtime-review/index.ts");
  }
  return source.replace(anchor, `${helper}${anchor}`);
}

function addEvalRuntimeCaps(source) {
  const original = `export function runtimeReviewOptions(env: NodeJS.ProcessEnv = process.env): RuntimeReviewOptions {
  const all = Number.MAX_SAFE_INTEGER;
  return {
    profile: "prod",
    areaConcurrency: all,
    taskConcurrency: all,
    maxAreas: all,
    maxProbesPerArea: all,
    maxMentalTraceCalls: all,
    maxAgentIterations: all,
    plannerModel: runtimePlannerModel(env),
    plannerEffort: "medium",
    agentModel: runtimeAgentModel(env),
    agentEffort: "medium",
    mentalTraceModel: runtimeMentalTraceModel(env),
    mentalTraceEffort: "low",
  };
}
`;
  const replacement = `export function runtimeReviewOptions(env: NodeJS.ProcessEnv = process.env): RuntimeReviewOptions {
  const all = Number.MAX_SAFE_INTEGER;
  return {
    profile: "prod",
    areaConcurrency: evalPositiveInt(env, "EVAL_RUNTIME_REVIEW_AREA_CONCURRENCY") ?? all,
    taskConcurrency: evalPositiveInt(env, "EVAL_RUNTIME_REVIEW_TASK_CONCURRENCY") ?? all,
    maxAreas: evalPositiveInt(env, "EVAL_RUNTIME_REVIEW_MAX_EXPECTATIONS") ?? all,
    maxProbesPerArea: all,
    maxMentalTraceCalls: evalPositiveInt(env, "EVAL_RUNTIME_REVIEW_MAX_MENTAL_TRACE_CALLS") ?? all,
    maxAgentIterations: evalPositiveInt(env, "EVAL_RUNTIME_REVIEW_MAX_AGENT_ITERATIONS") ?? all,
    plannerModel: runtimePlannerModel(env),
    plannerEffort: "medium",
    agentModel: runtimeAgentModel(env),
    agentEffort: "medium",
    mentalTraceModel: runtimeMentalTraceModel(env),
    mentalTraceEffort: "low",
  };
}

function evalPositiveInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
`;
  if (!source.includes(original)) {
    throw new Error("Could not patch runtimeReviewOptions in trigger/src/runtime-review/index.ts");
  }
  return source.replace(original, replacement);
}

function addEvalArtifactCopy(source) {
  const original = `  } finally {
    await cleanupTransientPath(workspace, "runtime_review_workspace");
  }
}
`;
  const replacement = `  } finally {
    const evalArtifactDir = process.env.EVAL_RUNTIME_REVIEW_ARTIFACTS_DIR?.trim();
    if (evalArtifactDir) {
      await mkdir(evalArtifactDir, { recursive: true })
        .then(() => cp(workspace, evalArtifactDir, { recursive: true, force: true }))
        .catch((error) => {
          console.warn("__JINA_EVAL_ARTIFACT_COPY_FAILED__" + errorMessage(error));
        });
    }
    await cleanupTransientPath(workspace, "runtime_review_workspace");
  }
}
`;
  if (!source.includes(original)) {
    throw new Error("Could not patch runtime workspace artifact copy in trigger/src/runtime-review/index.ts");
  }
  return source.replace(original, replacement);
}

function addEvalIsolationPromptBoundary(source) {
  const boundary = [
    "Eval isolation:",
    "- Do not browse GitHub, the web, or external issue/PR pages.",
    "- Do not inspect evaluation datasets, golden datasets, known regression issue mappings, reference issues, fix PRs, or prior eval outputs.",
    "- Use only the supplied PR metadata, checked-out source, local git diff/history available in the checkout, and CodeGraph/local command output.",
  ].join("\\n");

  const sharedContextAnchor = `Raw file instructions:
- Truncated prompt context is orientation only; inspect raw files before relying on exact source behavior.`;
  if (source.includes(sharedContextAnchor)) {
    return source.replace(
      sharedContextAnchor,
      `Raw file instructions:
${boundary}
- Truncated prompt context is orientation only; inspect raw files before relying on exact source behavior.`,
    );
  }

  const legacyAnchor = `- Do not request any custom tool except mental_trace.\\n\\nCodeGraph CLI path:`;
  if (source.includes(legacyAnchor)) {
    return source.replace(
      legacyAnchor,
      `- Do not request any custom tool except mental_trace.\\n\\n${boundary}\\n\\nCodeGraph CLI path:`,
    );
  }

  throw new Error("Could not inject eval isolation boundary into trigger/src/runtime-review/index.ts");
}

function runnerSource(workerDir, inputPath, resultPath) {
  const reviewPath = pathToFileURL(join(workerDir, "runtime-review", "index.ts")).href;
  return `import { readFile, writeFile } from "node:fs/promises";
import { runRuntimeReview } from ${JSON.stringify(reviewPath)};

async function main() {
  const request = JSON.parse(await readFile(${JSON.stringify(inputPath)}, "utf8"));
  const result = await runRuntimeReview(request.input);
  await writeFile(${JSON.stringify(resultPath)}, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({
    status: result.status,
    summary: result.summary,
    changedFiles: result.changedFiles?.length ?? 0,
    expectations: result.plan?.areas?.length ?? 0,
    areas: result.areas?.length ?? 0,
    findings: result.findings?.length ?? 0
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
`;
}

function splitCommand(value) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) throw new Error("Empty command");
  return { command: parts[0], args: parts.slice(1) };
}

function isolatedEnv(args, artifactDir) {
  const keep = [
    "PATH",
    "HOME",
    "TMPDIR",
    "SHELL",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "npm_config_cache",
    "NPM_CONFIG_CACHE",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
  ];
  const env = {};
  for (const key of keep) {
    if (process.env[key]) env[key] = process.env[key];
  }
  for (const key of [
    "CODEX_API_KEY",
    "OPENAI_API_KEY",
    "CODEX_REVIEW_TIMEOUT_MS",
    "CODEGRAPH_TIMEOUT_MS",
    "RUNTIME_PLANNER_MODEL",
    "RUNTIME_AGENT_MODEL",
    "RUNTIME_MENTAL_TRACE_MODEL",
    "REVIEW_CODEX_MODEL",
    "EVAL_REVIEW_GIT_TIMEOUT_MS",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.CODEX_BIN = args.codexBin || "codex";
  env.CODEGRAPH_BIN = args.codegraphBin || "codegraph";
  env.EVAL_RUNTIME_REVIEW_ARTIFACTS_DIR = artifactDir;
  if (args.maxExpectations) env.EVAL_RUNTIME_REVIEW_MAX_EXPECTATIONS = String(args.maxExpectations);
  if (args.areaConcurrency) env.EVAL_RUNTIME_REVIEW_AREA_CONCURRENCY = String(args.areaConcurrency);
  if (args.taskConcurrency) env.EVAL_RUNTIME_REVIEW_TASK_CONCURRENCY = String(args.taskConcurrency);
  if (args.maxMentalTrace) env.EVAL_RUNTIME_REVIEW_MAX_MENTAL_TRACE_CALLS = String(args.maxMentalTrace);
  if (args.maxAgentIterations) env.EVAL_RUNTIME_REVIEW_MAX_AGENT_ITERATIONS = String(args.maxAgentIterations);
  return env;
}

function runCommand(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const maxBufferBytes = options.maxBufferBytes ?? 24 * 1024 * 1024;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= maxBufferBytes) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= maxBufferBytes) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} exited with ${code}: ${stderr || stdout}`));
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function tryCommand(command, args, options) {
  try {
    return await runCommand(command, args, options);
  } catch {
    return { stdout: "", stderr: "" };
  }
}

function scanForGoldenLeakage(datasetMatch, result) {
  const text = JSON.stringify(result, null, 2);
  const lower = text.toLowerCase();
  const findings = [];
  const bannedFieldNames = [
    "targeted_issue_numbers",
    "targetedIssueNumbers",
    "reference_issues",
    "referenceIssues",
    "introduced_issues",
    "introducedIssues",
    "fix_prs",
    "fixPrs",
    "evidence_summary",
    "evidenceSummary",
    "known_attributed_closed_issue_count",
  ];
  for (const name of bannedFieldNames) {
    if (text.includes(`"${name}"`)) findings.push({ type: "banned_field", value: name });
  }

  for (const issue of asArray(datasetMatch.entry.introduced_issues)) {
    addLeakIfPresent(findings, lower, issue.url, "reference_issue_url");
    addLeakIfPresent(findings, lower, issue.title, "reference_issue_title");
    if (issue.number) {
      addLeakIfPresent(findings, lower, `issues/${issue.number}`, "reference_issue_path");
      addLeakIfPresent(findings, lower, `#${issue.number}`, "reference_issue_number");
    }
  }
  for (const fix of asArray(datasetMatch.entry.fix_prs)) {
    addLeakIfPresent(findings, lower, fix.url, "fix_pr_url");
    if (fix.number) addLeakIfPresent(findings, lower, `pull/${fix.number}`, "fix_pr_path");
  }
  return findings;
}

function addLeakIfPresent(findings, lowerText, value, type) {
  if (typeof value !== "string" && typeof value !== "number") return;
  const needle = String(value).trim().toLowerCase();
  if (needle && lowerText.includes(needle)) findings.push({ type, value: String(value) });
}

function writeReviewArtifacts(out, result) {
  writeFileSync(join(out, "review-runtime-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(out, "review-runtime.md"), `${String(result.markdown || "").trim()}\n`);
  writeFileSync(join(out, "runtime-plan.json"), `${JSON.stringify(result.plan ?? null, null, 2)}\n`);
  writeFileSync(join(out, "runtime-findings.json"), `${JSON.stringify(result.findings ?? [], null, 2)}\n`);
  writeFileSync(join(out, "runtime-summary.json"), `${JSON.stringify({
    status: result.status,
    summary: result.summary,
    commit: result.commit,
    changed_file_count: Array.isArray(result.changedFiles) ? result.changedFiles.length : 0,
    changed_files: result.changedFiles ?? [],
    expectation_count: Array.isArray(result.plan?.areas) ? result.plan.areas.length : 0,
    area_count: Array.isArray(result.areas) ? result.areas.length : 0,
    finding_count: Array.isArray(result.findings) ? result.findings.length : 0,
    error: result.error,
  }, null, 2)}\n`);
}

async function main() {
  const args = await resolveLocalCredentials(parseArgs(process.argv.slice(2)));
  if (args.noDataset) {
    if (!args.repo) throw new Error(`--repo is required with --no-dataset\n${usage()}`);
    if (!args.pr) throw new Error(`--pr is required with --no-dataset\n${usage()}`);
  }
  const dataset = args.noDataset ? undefined : readJson(args.dataset);
  const datasetMatch = dataset ? resolveDatasetTarget(dataset, args) : undefined;
  const prMetadata = await fetchPullRequestMetadata(args, datasetMatch?.entry);
  const reviewInput = buildReviewInput(args, prMetadata);
  const out = prepareOutputDir(args);

  writeFileSync(join(out, "review-input.json"), `${JSON.stringify(redactReviewInput(reviewInput), null, 2)}\n`);
  writeFileSync(join(out, "isolation-report.json"), `${JSON.stringify(buildIsolationReport(args, datasetMatch, reviewInput), null, 2)}\n`);
  writeFileSync(join(out, "metadata.json"), `${JSON.stringify({
    generated_at: new Date().toISOString(),
    repository: args.repo,
    pr_number: args.pr,
    rank: datasetMatch?.entry.rank ?? null,
    bucket: datasetMatch?.entry.bucket ?? null,
    dataset_file: datasetMatch ? args.dataset : null,
    method: args.method,
    dry_run: args.dryRun,
    model_config: runtimeModelConfig(),
    tool_config: {
      codex_bin: args.codexBin,
      codegraph_bin: args.codegraphBin,
    },
    eval_caps: {
      max_expectations: args.maxExpectations || null,
      area_concurrency: args.areaConcurrency || null,
      task_concurrency: args.taskConcurrency || null,
      max_mental_trace: args.maxMentalTrace || null,
      max_agent_iterations: args.maxAgentIterations || null,
    },
    golden_reference_metadata_reserved_for_post_review: datasetMatch
      ? {
          rank: datasetMatch.entry.rank,
          bucket: datasetMatch.entry.bucket,
          reference_issue_count: asArray(datasetMatch.entry.introduced_issues).length,
          fix_pr_count: asArray(datasetMatch.entry.fix_prs).length,
        }
      : null,
  }, null, 2)}\n`);

  if (args.dryRun) {
    console.log(`Dry run wrote review input and isolation report to ${out}`);
    return;
  }
  if (!args.githubToken) {
    throw new Error("No GitHub credential could be resolved non-interactively from --github-token, GITHUB_TOKEN, GH_TOKEN, gh auth token, or git credential fill.");
  }

  const result = await runReviewSubprocess(args, reviewInput, out);
  writeReviewArtifacts(out, result);

  if (datasetMatch) {
    const leakageFindings = scanForGoldenLeakage(datasetMatch, result);
    writeFileSync(join(out, "leakage-scan.json"), `${JSON.stringify({
      passed: leakageFindings.length === 0,
      finding_count: leakageFindings.length,
      findings: leakageFindings,
    }, null, 2)}\n`);
    if (leakageFindings.length && !args.allowLeakage) {
      throw new Error(`Review output mentions withheld golden data; see ${join(out, "leakage-scan.json")}`);
    }
  } else {
    writeFileSync(join(out, "leakage-scan.json"), `${JSON.stringify({
      passed: true,
      skipped: true,
      reason: "No golden dataset entry was used for this arbitrary-PR run.",
      finding_count: 0,
      findings: [],
    }, null, 2)}\n`);
  }

  console.log(`Wrote isolated review-runtime v1 output to ${out}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

function runtimeModelConfig() {
  return {
    planner_model: process.env.RUNTIME_PLANNER_MODEL || "gpt-5.5",
    agent_model: process.env.RUNTIME_AGENT_MODEL || "gpt-5.4",
    mental_trace_model: process.env.RUNTIME_MENTAL_TRACE_MODEL || "gpt-5.4-mini",
    planner_effort: "medium",
    agent_effort: "medium",
    mental_trace_effort: "low",
  };
}
