import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  AGENT_KNOWLEDGE_CODEX_ARGS,
  createRepositoryArchive,
  findExistingCodex,
  checkpointClaimVerifier,
  isTransientKnowledgeGenerationFailure,
  keepsPartialCatalog,
  MAX_RUN_BUDGET_SECONDS,
  runBudgetSeconds,
  KNOWLEDGE_PROMPT_STDIN_REDIRECT
} from "./knowledge-document-executor.js";

const execFileAsync = promisify(execFile);

test("knowledge generation retry classification is bounded to transient failures", () => {
  assert.equal(isTransientKnowledgeGenerationFailure("HTTP 503 from sandbox gateway"), true);
  assert.equal(isTransientKnowledgeGenerationFailure("stream disconnected while reconnecting"), true);
  assert.equal(isTransientKnowledgeGenerationFailure("output failed JSON schema validation"), false);
  assert.equal(isTransientKnowledgeGenerationFailure("permission denied"), false);
  // Verbatim from the deploy this was found in: the sandbox SDK words a gateway
  // failure this way, and the old pattern only matched the "http 502" wording.
  assert.equal(isTransientKnowledgeGenerationFailure("Request failed with status code 502"), true);
  assert.equal(isTransientKnowledgeGenerationFailure("Request failed with status code 429"), true);
  // Also verbatim, and deliberately not transient: retrying a run that used its
  // whole wall clock costs another full DAYTONA_RUN_TIMEOUT_SECONDS, and the
  // pages it already wrote are kept instead.
  assert.equal(isTransientKnowledgeGenerationFailure("command execution timeout"), false);
  assert.equal(isTransientKnowledgeGenerationFailure("Request failed with status code 400"), false);
});

test("a run killed by its wall clock keeps the pages already written to disk", () => {
  // The production failure this exists for: derivation ran the full
  // DAYTONA_RUN_TIMEOUT_SECONDS and threw, discarding every finished page.
  assert.equal(keepsPartialCatalog(1), true);
  assert.equal(keepsPartialCatalog(12), true);
  // Nothing written means the run failed before producing anything, and an empty
  // catalog would publish as "no knowledge" instead of surfacing the failure.
  assert.equal(keepsPartialCatalog(0), false);
});

test("a run takes the budget it was handed, bounded by the sandbox ceiling", () => {
  const previous = process.env.DAYTONA_RUN_TIMEOUT_SECONDS;
  process.env.DAYTONA_RUN_TIMEOUT_SECONDS = "2400";
  try {
    // What the caller has left, not a fixed per-run value, so a repair run
    // cannot restart the clock on a stage that is already nearly spent.
    assert.equal(runBudgetSeconds({ budgetSeconds: 5400 }), 5400);
    assert.equal(runBudgetSeconds({ budgetSeconds: 600 }), 600);
    // No caller value falls back to the deployment default.
    assert.equal(runBudgetSeconds({}), 2400);
    // The ceiling binds whatever a build asked for.
    assert.equal(runBudgetSeconds({ budgetSeconds: 99_999 }), MAX_RUN_BUDGET_SECONDS);
    // Nonsense does not disable the timeout, which would hand the sandbox an
    // unbounded run and hold the lease until it expired.
    assert.equal(runBudgetSeconds({ budgetSeconds: 0 }), 2400);
    assert.equal(runBudgetSeconds({ budgetSeconds: -1 }), 2400);
    assert.equal(runBudgetSeconds({ budgetSeconds: Number.NaN }), 2400);
  } finally {
    if (previous === undefined) delete process.env.DAYTONA_RUN_TIMEOUT_SECONDS;
    else process.env.DAYTONA_RUN_TIMEOUT_SECONDS = previous;
  }
});

test("a claim the checkpoint does not make is dropped, not fatal", async () => {
  const repository = await mkdtemp(join(tmpdir(), "jina-claim-verify-"));
  try {
    await writeFile(join(repository, "outbox.ts"), "line one\nlease expiry releases the row\nline three\n");
    const verify = checkpointClaimVerifier(repository);
    assert.ok(verify);
    // The claim occurs verbatim in the range it names.
    assert.equal(verify({ path: "outbox.ts", startLine: 2, endLine: 2, claim: "lease expiry releases the row" }), true);
    // The production failure: a plausible claim the cited lines do not make.
    assert.equal(
      verify({ path: "outbox.ts", startLine: 1, endLine: 1, claim: "lease expiry releases the row" }),
      false
    );
    // A range past the end of the file, and a file that is not there at all.
    assert.equal(verify({ path: "outbox.ts", startLine: 1, endLine: 99, claim: "line one" }), false);
    assert.equal(verify({ path: "absent.ts", startLine: 1, endLine: 1, claim: "line one" }), false);
    // Paths come from an untrusted agent, so one that escapes the checkout must
    // verify nothing rather than read the host filesystem.
    assert.equal(verify({ path: "../../etc/passwd", startLine: 1, endLine: 1, claim: "root user entry" }), false);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("snapshot reuse accepts only an absolute working Codex path", async () => {
  const found = await findExistingCodex({
    process: {
      async executeCommand() {
        return { exitCode: 0, result: "/opt/codex/bin/codex\n" };
      }
    }
  });
  assert.equal(found, "/opt/codex/bin/codex");

  const missing = await findExistingCodex({
    process: {
      async executeCommand() {
        return { exitCode: 0, result: "codex\n" };
      }
    }
  });
  assert.equal(missing, undefined);
});

test("agentic knowledge generation enables only read-only local shell exploration", () => {
  assert.ok(AGENT_KNOWLEDGE_CODEX_ARGS.includes("--ignore-user-config"));
  assert.ok(AGENT_KNOWLEDGE_CODEX_ARGS.includes("--ignore-rules"));
  assert.ok(AGENT_KNOWLEDGE_CODEX_ARGS.includes("--strict-config"));
  assert.ok(AGENT_KNOWLEDGE_CODEX_ARGS.includes("--skip-git-repo-check"));
  assert.ok(AGENT_KNOWLEDGE_CODEX_ARGS.includes("--enable shell_tool"));
  // Subagents are enabled on purpose: pages are independent, and writing them
  // one after another spends the budget on the first few. They inherit this
  // sandbox, so the reach of the run is unchanged.
  assert.ok(AGENT_KNOWLEDGE_CODEX_ARGS.includes("--enable multi_agent"));
  assert.equal(AGENT_KNOWLEDGE_CODEX_ARGS.includes("--disable multi_agent" as never), false);
  for (const feature of [
    "shell_snapshot",
    "apps",
    "browser_use",
    "computer_use",
    "image_generation",
    "unified_exec",
    "plugins",
    "remote_plugin",
    "hooks",
    "in_app_browser",
    "code_mode_host",
    "workspace_dependencies",
    "skill_mcp_dependency_install"
  ]) {
    assert.ok(AGENT_KNOWLEDGE_CODEX_ARGS.includes(`--disable ${feature}` as never));
  }
  assert.ok(AGENT_KNOWLEDGE_CODEX_ARGS.includes('-c web_search="disabled"'));
  assert.ok(AGENT_KNOWLEDGE_CODEX_ARGS.includes('-c approval_policy="never"'));
  assert.ok(AGENT_KNOWLEDGE_CODEX_ARGS.includes("-c project_doc_max_bytes=0"));
  assert.ok(AGENT_KNOWLEDGE_CODEX_ARGS.includes('-c shell_environment_policy.inherit="none"'));
});

test("knowledge prompts stream over stdin instead of expanding into argv", () => {
  assert.equal(KNOWLEDGE_PROMPT_STDIN_REDIRECT, "< '/home/daytona/context-engine/prompt.txt'");
  assert.equal(KNOWLEDGE_PROMPT_STDIN_REDIRECT.includes("$("), false);
});

test("repository archives are pinned to the requested commit and exclude worktree and Git metadata", async () => {
  const repository = await mkdtemp(join(tmpdir(), "jina-agent-archive-test-"));
  let archive: Awaited<ReturnType<typeof createRepositoryArchive>> | undefined;
  try {
    await execFileAsync("git", ["init", "-q", repository]);
    await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "Archive Test"]);
    await writeFile(join(repository, "README.md"), "checkpoint content\n");
    await execFileAsync("git", ["-C", repository, "add", "README.md"]);
    await execFileAsync("git", ["-C", repository, "commit", "-q", "-m", "checkpoint"]);
    const { stdout } = await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"]);
    const checkpoint = stdout.trim();
    await writeFile(join(repository, "README.md"), "uncommitted content\n");
    await writeFile(join(repository, "untracked-secret.txt"), "must not be archived\n");

    archive = await createRepositoryArchive(repository, checkpoint);
    const listing = (await execFileAsync("tar", ["-tzf", archive.path])).stdout;
    const readme = (await execFileAsync("tar", ["-xOzf", archive.path, "README.md"])).stdout;
    assert.equal(readme, "checkpoint content\n");
    assert.doesNotMatch(listing, /\.git|untracked-secret/);
  } finally {
    if (archive) await rm(archive.directory, { recursive: true, force: true });
    await rm(repository, { recursive: true, force: true });
  }
});
