import { execFileSync } from "node:child_process";
import {
  createReviewHarness,
  isHarnessType,
  type HarnessType,
  type ReviewResult
} from "@jina/ai";
import {
  applyCommand,
  findTask,
  markOutboxDispatched,
  nextPendingOutboxMessage,
  reduceBoard,
  type CommandActor,
  type TaskId
} from "@jina/board";
import { aiCreditsForCost, defaultBillingPolicy, infraCreditsForRun } from "@jina/policy";
import { buildPublicationKey, upsertPublication } from "@jina/publication";
import { buildFindingFingerprint, upsertFindingThread } from "@jina/review";
import { nowIso } from "@jina/shared-kernel";
import { ingestPullRequestReview } from "../ingest/pull-request.js";
import { createWorkflowState, findPullRequest, type WorkflowState } from "../state.js";

interface CliOptions {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly post: boolean;
  readonly dryRun: boolean;
  readonly harness: HarnessType;
  readonly model?: string;
}

const RUN_ACTOR: CommandActor = { type: "run", id: "cli-review" };

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  console.log(`Fetching ${options.repository}#${options.pullRequestNumber} via gh ...`);
  const pr = gh<{ number: number; title: string; headRefOid: string; url: string }>([
    "pr", "view", String(options.pullRequestNumber),
    "--repo", options.repository,
    "--json", "number,title,headRefOid,url"
  ]);
  const diff = execFileSync(
    "gh",
    ["pr", "diff", String(options.pullRequestNumber), "--repo", options.repository],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  );

  console.log(`PR: ${pr.title}`);
  console.log(`Head: ${pr.headRefOid}  Diff: ${diff.length} chars  Harness: ${options.harness}`);

  // Webhook ingest: plan the pipeline on the board.
  let state = ingestPullRequestReview(
    createWorkflowState(),
    {
      tenantId: "cli",
      repository: options.repository,
      pullRequestNumber: pr.number,
      headSha: pr.headRefOid,
      needsExternalContext: false
    },
    nowIso()
  );

  // This process is the relay + runtime: drain the outbox, execute each run.
  let review: ReviewResult | undefined;
  for (;;) {
    const message = nextPendingOutboxMessage(state.board);
    if (!message) {
      break;
    }
    state = { ...state, board: markOutboxDispatched(state.board, message.id, nowIso()) };

    switch (message.topic) {
      case "run-review": {
        const result = await runReview(state, message.payload.taskId, { ...options, title: pr.title, diff });
        state = result.state;
        review = result.review ?? review;
        break;
      }
      case "run-publish":
        state = runPublish(state, message.payload.taskId, options, review);
        break;
      default:
        console.log(`Skipping unsupported topic in CLI mode: ${message.topic}`);
    }
  }

  printBoard(state);
  if (review) {
    printRunReport(review);
  }
}

async function runReview(
  state: WorkflowState,
  taskId: TaskId,
  input: CliOptions & { readonly title: string; readonly diff: string }
): Promise<{ state: WorkflowState; review?: ReviewResult }> {
  const task = findTask(state.board, taskId);
  if (!task || task.status !== "queued") {
    return { state };
  }

  let board = applyCommand(
    state.board,
    { command: "TransitionTask", taskId, toStatus: "in_progress" },
    { actor: RUN_ACTOR, now: nowIso() }
  ).state;

  const review = input.dryRun
    ? dryRunReview(input.harness, input.title)
    : await createReviewHarness(input.harness).review({
        repository: input.repository,
        pullRequestNumber: input.pullRequestNumber,
        title: input.title,
        diff: input.diff,
        ...(input.model ? { model: input.model } : {})
      });

  console.log(`Review complete (${review.harnessType}): ${review.findings.length} finding(s)`);

  // Observability: every harness step lands on the task timeline as run.step.
  for (const step of review.steps) {
    board = applyCommand(
      board,
      {
        command: "CommentTask",
        taskId,
        eventType: "run.step",
        payload: { seq: step.seq, stepType: step.type, detail: step.detail, ...(step.model ? { model: step.model } : {}) }
      },
      { actor: RUN_ACTOR, now: nowIso() }
    ).state;
  }

  const headSha = String(task.metadata.headSha ?? "");
  let findings = state.findings;
  let threads = state.findingThreads;
  for (const finding of review.findings) {
    const fingerprint = buildFindingFingerprint({
      repoId: input.repository,
      path: finding.filePath,
      rule: finding.category,
      normalizedMessage: finding.title.toLowerCase()
    });
    findings = [...findings, { taskId, fingerprint, title: finding.title, headSha }];
    threads = upsertFindingThread(threads, fingerprint, headSha);
  }

  board = applyCommand(
    board,
    {
      command: "CommentTask",
      taskId,
      eventType: "review.completed",
      payload: { findingCount: review.findings.length, harnessType: review.harnessType }
    },
    { actor: RUN_ACTOR, now: nowIso() }
  ).state;
  board = applyCommand(board, { command: "TransitionTask", taskId, toStatus: "done" }, { actor: RUN_ACTOR, now: nowIso() })
    .state;

  return {
    state: { ...state, board: reduceBoard(board, nowIso()), findings, findingThreads: threads },
    review
  };
}

function runPublish(
  state: WorkflowState,
  taskId: TaskId,
  options: CliOptions,
  review: ReviewResult | undefined
): WorkflowState {
  const task = findTask(state.board, taskId);
  if (!task || task.status !== "queued" || !review) {
    return state;
  }

  const headSha = String(task.metadata.headSha ?? "");
  const pr = findPullRequest(state, options.repository, options.pullRequestNumber);
  if (pr && headSha !== pr.headSha) {
    return state;
  }

  let board = applyCommand(
    state.board,
    { command: "TransitionTask", taskId, toStatus: "in_progress" },
    { actor: RUN_ACTOR, now: nowIso() }
  ).state;

  const key = buildPublicationKey(`${options.repository}#${options.pullRequestNumber}`, headSha, "summary");
  const body = renderReviewBody(review, headSha, key);

  console.log("");
  console.log("================ REVIEW ================");
  console.log(body);
  console.log("=========================================");

  if (options.post) {
    execFileSync(
      "gh",
      ["pr", "comment", String(options.pullRequestNumber), "--repo", options.repository, "--body", body],
      { encoding: "utf8" }
    );
    console.log("Posted as a PR comment.");
  } else {
    console.log("(not posted — pass --post to publish this as a PR comment)");
  }

  const upserted = upsertPublication(state.publications, { key, headSha, target: "summary" });

  board = applyCommand(
    board,
    {
      command: "CommentTask",
      taskId,
      eventType: "publish.completed",
      payload: { publicationKey: key, action: upserted.action, posted: options.post }
    },
    { actor: RUN_ACTOR, now: nowIso() }
  ).state;
  board = applyCommand(board, { command: "TransitionTask", taskId, toStatus: "done" }, { actor: RUN_ACTOR, now: nowIso() })
    .state;

  return { ...state, board: reduceBoard(board, nowIso()), publications: upserted.records };
}

function renderReviewBody(review: ReviewResult, headSha: string, publicationKey: string): string {
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  const sorted = [...review.findings].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  const findingLines = sorted.map((finding) => {
    const location = finding.lineStart > 0 ? `${finding.filePath}:${finding.lineStart}` : finding.filePath;
    return `- **[${finding.severity}]** \`${location}\` — ${finding.title} _(confidence ${finding.confidence.toFixed(2)})_\n  ${finding.body}`;
  });

  return [
    `### Jina review (advisory)`,
    ``,
    review.summary,
    ``,
    sorted.length === 0 ? `No findings.` : `**Findings (${sorted.length})**`,
    ...findingLines,
    ``,
    `<sub>head \`${headSha.slice(0, 12)}\` · ${review.harnessType} · advisory only — no code was executed</sub>`,
    `<!-- ${publicationKey} -->`
  ].join("\n");
}

function printRunReport(review: ReviewResult): void {
  console.log("");
  console.log("Run trace:");
  for (const step of review.steps) {
    console.log(`  ${String(step.seq).padStart(2)}. [${step.type}] ${step.detail}`);
  }

  console.log("Model usage:");
  let totalCost = 0;
  let costKnown = false;
  for (const usage of review.usage) {
    const cost = usage.costUsd !== undefined ? `$${usage.costUsd.toFixed(4)}` : "cost n/a";
    if (usage.costUsd !== undefined) {
      totalCost += usage.costUsd;
      costKnown = true;
    }
    console.log(
      `  ${usage.provider}/${usage.model} [${usage.operation}] ${usage.promptTokens} in / ${usage.completionTokens} out tokens, ${cost} (dedupe ${usage.dedupeKey})`
    );
  }

  // The CLI always runs on the developer's own key: own-harness rates.
  const infra = infraCreditsForRun(defaultBillingPolicy, "included");
  console.log(`Credits (own-harness, included rates): ${infra} infra + 0 AI = ${infra}`);
  if (costKnown) {
    const managedAi = aiCreditsForCost(totalCost, defaultBillingPolicy, "included", "managed");
    console.log(`  (managed equivalent at default 30% subsidy: ${infra + managedAi} credits for $${totalCost.toFixed(4)} of AI cost)`);
  }
}

function dryRunReview(harness: HarnessType, title: string): ReviewResult {
  return {
    harnessType: harness,
    summary: `Dry run — no model was called. PR titled "${title}" was fetched and pushed through the board pipeline.`,
    findings: [
      {
        title: "Dry-run placeholder finding",
        body: "This finding is canned; run without --dry-run to review with the model.",
        severity: "low",
        confidence: 0.0,
        filePath: "dry-run",
        lineStart: 0,
        category: "dry-run"
      }
    ],
    steps: [
      { seq: 1, at: nowIso(), type: "note", detail: "dry run: harness not invoked" }
    ],
    usage: []
  };
}

function printBoard(state: WorkflowState): void {
  console.log("");
  console.log("Board:");
  for (const task of state.board.tasks) {
    console.log(`  ${task.type.padEnd(11)} ${task.status.padEnd(11)} attempt=${task.attempt} ${task.title}`);
  }
  const stepEvents = state.board.events.filter((event) => event.type === "run.step").length;
  console.log(`Findings: ${state.findings.length} (threads: ${state.findingThreads.length})`);
  console.log(`Run steps on the board: ${stepEvents}`);
  console.log(`Publications: ${state.publications.map((p) => `${p.key} [${p.status}]`).join(", ") || "none"}`);
}

function gh<T>(args: readonly string[]): T {
  return JSON.parse(execFileSync("gh", [...args], { encoding: "utf8" })) as T;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const positional: string[] = [];
  let post = false;
  let dryRun = false;
  let harness: HarnessType = "openrouter-chat";
  let model: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--post") post = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--model") {
      const next = argv[i + 1];
      if (next) {
        model = next;
        i += 1;
      }
    } else if (arg === "--harness") {
      const next = argv[i + 1];
      if (next && isHarnessType(next)) {
        harness = next;
        i += 1;
      } else {
        console.error(`Unknown harness: ${next ?? "(missing)"} — expected openrouter-chat or codex-cli`);
        process.exit(2);
      }
    } else if (arg !== undefined) positional.push(arg);
  }

  const [repository, prNumber] = positional;
  if (!repository || !prNumber || !/^\d+$/.test(prNumber)) {
    console.error("Usage: review-pr <owner/repo> <pr-number> [--dry-run] [--post] [--harness openrouter-chat|codex-cli] [--model <slug>]");
    process.exit(2);
  }

  return {
    repository,
    pullRequestNumber: Number(prNumber),
    post,
    dryRun,
    harness,
    ...(model ? { model } : {})
  };
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`review-pr failed: ${message}`);
  if (/OPENROUTER_API_KEY|authentication|401/i.test(message)) {
    console.error("Hint: export OPENROUTER_API_KEY=<your key> (create one at openrouter.ai, or connect via the dashboard later).");
  }
  if (/gh: command not found|ENOENT/.test(message)) {
    console.error("Hint: this command needs the GitHub CLI (`gh`) and, for --harness codex-cli, the Codex CLI.");
  }
  process.exit(1);
});
