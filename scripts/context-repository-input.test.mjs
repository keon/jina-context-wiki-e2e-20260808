import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  collectRepositoryInput,
  createPinnedRepositoryCheckout,
  languageForRepositoryPath,
  resolveRepositoryHead
} from "./context-repository-input.mjs";
import {
  agentStageDirectoryForAttempt,
  allocateAttemptBudget,
  withScopedAgentStageResume
} from "./context-repository-run-control.mjs";
import { parseRepositoryHarnessArguments } from "./context-repository-e2e.mjs";

const execFileAsync = promisify(execFile);

async function git(directory, args) {
  const { stdout } = await execFileAsync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout.trim();
}

async function commit(directory, message) {
  await git(directory, ["add", "."]);
  await git(directory, [
    "-c",
    "user.name=Context Harness",
    "-c",
    "user.email=context-harness@example.com",
    "commit",
    "-m",
    message
  ]);
  return git(directory, ["rev-parse", "HEAD"]);
}

test("collectRepositoryInput reads exact HEAD and bounds history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-repository-input-test-"));
  try {
    await git(directory, ["init", "-b", "main"]);
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(join(directory, "src", "first.ts"), "export const first = 1;\n");
    await writeFile(join(directory, "run.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(directory, "run.sh"), 0o755);
    await writeFile(join(directory, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    await symlink("src/first.ts", join(directory, "first-link"));
    const firstSha = await commit(directory, "feat: add first implementation");

    await writeFile(join(directory, "src", "first.ts"), "export const first = 2;\n");
    await writeFile(join(directory, "src", "second.py"), "def second():\n    return 2\n");
    const headSha = await commit(directory, "feat: add second implementation");

    // Dirty working-tree bytes must never leak into the immutable snapshot.
    await writeFile(join(directory, "src", "first.ts"), "export const dirty = true;\n");

    assert.equal(await resolveRepositoryHead(directory), headSha);
    const collected = await collectRepositoryInput({
      repositoryDirectory: directory,
      commitSha: headSha,
      historyLimit: 1,
      maxFileBytes: 1024
    });
    assert.equal(collected.git.history.length, 1);
    assert.equal(collected.git.history[0].sha, headSha);
    assert.deepEqual(collected.git.commit.parentShas, [firstSha]);
    assert.deepEqual(
      collected.git.changes.map(({ kind, path }) => ({ kind, path })),
      [
        { kind: "modify", path: "src/first.ts" },
        { kind: "add", path: "src/second.py" }
      ]
    );

    const byPath = new Map(collected.files.map((file) => [file.path, file]));
    assert.equal(byPath.get("src/first.ts").body, "export const first = 2;\n");
    assert.equal(byPath.get("src/first.ts").language, "typescript");
    assert.equal(byPath.get("src/second.py").language, "python");
    assert.equal(byPath.get("run.sh").executable, true);
    assert.equal(byPath.get("binary.dat").contentOmitted, true);
    assert.equal(byPath.get("first-link").entryType, "symlink");
    assert.equal(byPath.get("first-link").linkTarget, "src/first.ts");

    const checkout = await createPinnedRepositoryCheckout(directory, headSha);
    try {
      assert.equal(await git(checkout.checkoutDirectory, ["rev-parse", "HEAD"]), headSha);
      assert.equal(await git(checkout.checkoutDirectory, ["status", "--porcelain"]), "");
    } finally {
      await rm(checkout.root, { recursive: true, force: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("languageForRepositoryPath handles common repository files", () => {
  assert.equal(languageForRepositoryPath("packages/api/src/server.ts"), "typescript");
  assert.equal(languageForRepositoryPath("Dockerfile"), "dockerfile");
  assert.equal(languageForRepositoryPath("assets/logo.bin"), undefined);
});

test("pnpm option separator is ignored before harness flags", () => {
  const parsed = parseRepositoryHarnessArguments(
    ["--", "--repo-dir", "/tmp/repository", "--repository", "Example/Project", "--resume-run", "/tmp/retained-context"],
    {}
  );
  assert.equal(parsed.repositoryDirectory, "/tmp/repository");
  assert.equal(parsed.repository, "example/project");
  assert.equal(parsed.resumeRunDirectory, "/tmp/retained-context");
});

test("retry attempts receive only the preceding run's private stage directory", async () => {
  const environment = { CONTEXT_RESUME_AGENT_STAGE_DIR: "/caller/original-stage" };
  const priorRun = "/retained/jina-local-derive-prior";
  const observed = [];
  for (const attempt of [1, 2]) {
    const stageDirectory = agentStageDirectoryForAttempt(attempt, attempt === 1 ? undefined : priorRun);
    await withScopedAgentStageResume(
      stageDirectory,
      async () => {
        observed.push(environment.CONTEXT_RESUME_AGENT_STAGE_DIR);
      },
      environment
    );
    assert.equal(environment.CONTEXT_RESUME_AGENT_STAGE_DIR, "/caller/original-stage");
  }
  assert.deepEqual(observed, [undefined, join(priorRun, "derive-state", "agent-stages")]);

  await assert.rejects(
    withScopedAgentStageResume(
      "/retained/failing/derive-state/agent-stages",
      async () => {
        throw new Error("expected test failure");
      },
      environment
    ),
    /expected test failure/
  );
  assert.equal(environment.CONTEXT_RESUME_AGENT_STAGE_DIR, "/caller/original-stage");
});

test("attempt budget reserves 30 percent for the default repair attempt", () => {
  assert.equal(
    allocateAttemptBudget({
      attempt: 1,
      totalAttempts: 2,
      totalBudgetSeconds: 3600,
      remainingSeconds: 3600
    }),
    2520
  );
  assert.equal(
    allocateAttemptBudget({
      attempt: 2,
      totalAttempts: 2,
      totalBudgetSeconds: 3600,
      remainingSeconds: 1080
    }),
    1080
  );
  assert.equal(
    allocateAttemptBudget({
      attempt: 1,
      totalAttempts: 3,
      totalBudgetSeconds: 300,
      remainingSeconds: 300
    }),
    180
  );
});
