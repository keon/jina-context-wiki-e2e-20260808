import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findExistingCodex,
  isTransientKnowledgeGenerationFailure,
  KNOWLEDGE_PROMPT_STDIN_REDIRECT,
  UNTRUSTED_KNOWLEDGE_CODEX_ARGS
} from "./knowledge-document-executor.js";

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

test("untrusted evidence generation disables every agentic tool surface", () => {
  assert.ok(UNTRUSTED_KNOWLEDGE_CODEX_ARGS.includes("--ignore-user-config"));
  assert.ok(UNTRUSTED_KNOWLEDGE_CODEX_ARGS.includes("--strict-config"));
  for (const feature of [
    "shell_tool",
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
    assert.ok(UNTRUSTED_KNOWLEDGE_CODEX_ARGS.includes(`--disable ${feature}` as never));
  }
  assert.ok(UNTRUSTED_KNOWLEDGE_CODEX_ARGS.includes('-c web_search="disabled"'));
});

test("knowledge prompts stream over stdin instead of expanding into argv", () => {
  assert.equal(KNOWLEDGE_PROMPT_STDIN_REDIRECT, "< '/home/daytona/context-engine/prompt.txt'");
  assert.equal(KNOWLEDGE_PROMPT_STDIN_REDIRECT.includes("$("), false);
});
