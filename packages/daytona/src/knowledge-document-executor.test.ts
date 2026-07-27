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
  isTransientKnowledgeGenerationFailure,
  KNOWLEDGE_PROMPT_STDIN_REDIRECT
} from "./knowledge-document-executor.js";

const execFileAsync = promisify(execFile);

test("knowledge generation retry classification is bounded to transient failures", () => {
  assert.equal(isTransientKnowledgeGenerationFailure("HTTP 503 from sandbox gateway"), true);
  assert.equal(isTransientKnowledgeGenerationFailure("stream disconnected while reconnecting"), true);
  assert.equal(isTransientKnowledgeGenerationFailure("output failed JSON schema validation"), false);
  assert.equal(isTransientKnowledgeGenerationFailure("permission denied"), false);
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
  for (const feature of [
    "shell_snapshot",
    "multi_agent",
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
