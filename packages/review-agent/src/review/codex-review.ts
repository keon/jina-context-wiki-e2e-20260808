import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { GitHubRepository } from "../shared/github.js";
import { cleanupTransientPath, type CommandResult, errorMessage, githubGitEnv, runCommand } from "../shared/utils.js";

export type PullRequestReviewInput = {
  repository: GitHubRepository;
  token: string;
  cloneToken?: string;
  pullRequestNumber: number;
  title?: string;
  author?: string;
  headSha: string;
  baseRef: string;
  headRef?: string;
  historyMarkdown: string;
};

export type CodegraphReviewContextResult = {
  commit: string;
  diffStat: string;
  diffPatch: string;
  changedFiles: string[];
  codegraphMarkdown: string;
};

export type ReviewFinding = {
  fingerprint: string;
  file_path?: string;
  line_number?: number;
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: string;
  body: string;
};

type CodegraphContext = {
  markdown: string;
};

type ReusableCheckoutInput = PullRequestReviewInput & { repoDir?: string };

export async function runReviewContext(input: ReusableCheckoutInput): Promise<CodegraphReviewContextResult> {
  if (input.repoDir) {
    await ensurePullRequestCheckout({
      repository: input.repository,
      token: input.token ?? input.cloneToken,
      pullRequestNumber: input.pullRequestNumber,
      baseRef: input.baseRef,
      headSha: input.headSha,
      repoDir: input.repoDir
    });
    return collectReviewContext(input.repoDir, input.baseRef);
  }

  return withTemporaryCheckout(input, "jina-review-context-", (repoDir) =>
    collectReviewContext(repoDir, input.baseRef)
  );
}

const emptyOutputOnError = (error: unknown): CommandResult => ({ stdout: "", stderr: errorMessage(error) });

async function collectReviewContext(repoDir: string, baseRef: string): Promise<CodegraphReviewContextResult> {
  const commit = await gitHead(repoDir);
  const diffStat = await runCommand("git", ["diff", "--stat", `origin/${baseRef}...HEAD`], {
    cwd: repoDir,
    timeoutMs: 60_000
  }).then((result) => result.stdout.trim());
  const diffPatch = await runCommand("git", ["diff", `origin/${baseRef}...HEAD`], {
    cwd: repoDir,
    timeoutMs: 60_000,
    maxBufferBytes: 12 * 1024 * 1024
  }).then((result) => result.stdout.trim());
  const changedFiles = await runCommand("git", ["diff", "--name-only", `origin/${baseRef}...HEAD`], {
    cwd: repoDir,
    timeoutMs: 60_000
  }).then((result) =>
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  );
  const codegraphContext = await buildCodegraphContext(repoDir, changedFiles);

  return {
    commit,
    diffStat,
    diffPatch,
    changedFiles,
    codegraphMarkdown: codegraphContext.markdown
  };
}

async function buildCodegraphContext(repoDir: string, changedFiles: string[]): Promise<CodegraphContext> {
  const command = codegraphCommand();
  try {
    await runCommand(command, ["init", repoDir], {
      timeoutMs: codegraphTimeoutMs(),
      maxBufferBytes: 8 * 1024 * 1024
    });

    const [status, affectedTests, files] = await Promise.all([
      runCommand(command, ["status", "--json", repoDir], {
        timeoutMs: 30_000,
        maxBufferBytes: 2 * 1024 * 1024
      }).catch(emptyOutputOnError),
      runCommand(command, ["affected", "--path", repoDir, "--stdin", "--quiet"], {
        input: changedFiles.join("\n"),
        timeoutMs: 60_000,
        maxBufferBytes: 2 * 1024 * 1024
      }).catch(emptyOutputOnError),
      runCommand(command, ["files", "--path", repoDir, "--format", "flat", "--no-metadata"], {
        timeoutMs: 30_000,
        maxBufferBytes: 2 * 1024 * 1024
      }).catch(emptyOutputOnError)
    ]);

    const affectedTestLines = affectedTests.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 40);

    return {
      markdown: [
        "Codegraph status:",
        fenced(trimForPrompt(status.stdout || status.stderr || "No status output.")),
        "",
        "Codegraph affected test candidates:",
        affectedTestLines.length
          ? affectedTestLines.map((file) => `- ${file}`).join("\n")
          : "- None found by codegraph.",
        "",
        "Codegraph indexed file excerpt:",
        fenced(trimForPrompt(files.stdout || files.stderr || "No file graph output."))
      ].join("\n")
    };
  } catch (error) {
    return {
      markdown: [
        "Codegraph status:",
        `- unavailable: ${errorMessage(error)}`,
        "",
        "Codegraph affected test candidates:",
        "- unavailable"
      ].join("\n")
    };
  }
}

function codegraphCommand(): string {
  return process.env.CODEGRAPH_BIN?.trim() || "codegraph";
}

type PullRequestCheckoutInput = {
  repository: GitHubRepository;
  token: string;
  pullRequestNumber: number;
  baseRef: string;
  headSha?: string;
  repoDir: string;
};

async function ensurePullRequestCheckout(input: PullRequestCheckoutInput): Promise<void> {
  await mkdir(path.dirname(input.repoDir), { recursive: true });
  const gitEnv = githubGitEnv(input.token);
  const repoUrl = `https://github.com/${input.repository.fullName}.git`;

  if (await isGitRepository(input.repoDir)) {
    await runCommand("git", ["remote", "set-url", "origin", repoUrl], {
      cwd: input.repoDir,
      env: gitEnv,
      timeoutMs: 30_000
    });
  } else {
    await rm(input.repoDir, { recursive: true, force: true });
    await runCommand("git", ["clone", "--no-tags", "--depth=100", repoUrl, input.repoDir], {
      env: gitEnv,
      timeoutMs: 120_000
    });
  }

  await runCommand(
    "git",
    [
      "fetch",
      "--no-tags",
      "origin",
      `+refs/pull/${input.pullRequestNumber}/head:refs/remotes/origin/pr/${input.pullRequestNumber}`
    ],
    {
      cwd: input.repoDir,
      env: gitEnv,
      timeoutMs: 120_000
    }
  );
  await runCommand(
    "git",
    ["fetch", "--no-tags", "origin", `+refs/heads/${input.baseRef}:refs/remotes/origin/${input.baseRef}`],
    {
      cwd: input.repoDir,
      env: gitEnv,
      timeoutMs: 120_000
    }
  );
  await runCommand(
    "git",
    ["checkout", "--force", "-B", `pr-${input.pullRequestNumber}`, `refs/remotes/origin/pr/${input.pullRequestNumber}`],
    {
      cwd: input.repoDir,
      timeoutMs: 60_000
    }
  );
  await runCommand("git", ["reset", "--hard", `refs/remotes/origin/pr/${input.pullRequestNumber}`], {
    cwd: input.repoDir,
    timeoutMs: 60_000
  });
  await runCommand("git", ["clean", "-fd"], {
    cwd: input.repoDir,
    timeoutMs: 60_000
  });
  await verifyPullRequestCheckout({ repoDir: input.repoDir, headSha: input.headSha });
}

async function verifyPullRequestCheckout(input: { repoDir: string; headSha?: string }): Promise<void> {
  if (!(await isGitRepository(input.repoDir))) {
    throw new Error(`Expected an initialized git checkout at ${input.repoDir}`);
  }
  if (!input.headSha) {
    return;
  }
  const actual = await gitHead(input.repoDir);
  if (actual !== input.headSha) {
    throw new Error(`Checkout at ${input.repoDir} is ${actual}, expected ${input.headSha}`);
  }
}

async function withTemporaryCheckout<T>(
  input: PullRequestReviewInput,
  prefix: string,
  run: (repoDir: string) => Promise<T>
): Promise<T> {
  const workspace = await mkdtemp(path.join(tmpdir(), prefix));
  const repoDir = path.join(workspace, "repo");

  try {
    await ensurePullRequestCheckout({
      repository: input.repository,
      token: input.token ?? input.cloneToken,
      pullRequestNumber: input.pullRequestNumber,
      baseRef: input.baseRef,
      headSha: input.headSha,
      repoDir
    });
    return await run(repoDir);
  } finally {
    await cleanupTransientPath(workspace, temporaryCheckoutCleanupLabel(prefix));
  }
}

function temporaryCheckoutCleanupLabel(prefix: string): string {
  const normalized = prefix
    .replace(/^jina-/, "")
    .replace(/-$/, "")
    .replaceAll("-", "_");
  return `${normalized || "temporary_checkout"}_workspace`;
}

async function isGitRepository(repoDir: string): Promise<boolean> {
  try {
    const result = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repoDir,
      timeoutMs: 30_000
    });
    return result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function gitHead(repoDir: string): Promise<string> {
  return runCommand("git", ["rev-parse", "HEAD"], { cwd: repoDir, timeoutMs: 30_000 }).then((result) =>
    result.stdout.trim()
  );
}

function codegraphTimeoutMs(): number {
  const raw = process.env.CODEGRAPH_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : 120_000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

function trimForPrompt(value: string): string {
  return value.length > 6_000 ? `${value.slice(0, 6_000)}\n[truncated]` : value;
}

function fenced(value: string): string {
  return `\`\`\`\n${value.trim()}\n\`\`\``;
}
