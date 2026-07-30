import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalCodexAgentStageRunner } from "./local-agent-stage-runner.js";

test("local board stages stream prompts to an isolated Codex process and retain only the final result", async () => {
  const root = await mkdtemp(join(tmpdir(), "jina-stage-runner-test-"));
  const fakeCodex = join(root, "fake-codex.cjs");
  await writeFile(
    fakeCodex,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "const outputIndex = args.indexOf('--output-last-message');",
      "if (outputIndex < 0) process.exit(4);",
      "let prompt = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => { prompt += chunk; });",
      "process.stdin.on('end', () => {",
      "  if (!prompt.includes('bounded fixture stage')) process.exit(5);",
      "  fs.writeFileSync(args[outputIndex + 1], JSON.stringify({ version: 1, ok: true }));",
      "  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');",
      "});"
    ].join("\n"),
    "utf8"
  );
  await chmod(fakeCodex, 0o755);
  try {
    const runner = new LocalCodexAgentStageRunner({
      binary: fakeCodex,
      model: "gpt-5.6-terra",
      effort: "low"
    });
    const result = await runner.run({
      id: "fixture-stage",
      prompt: "Complete the bounded fixture stage.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["version", "ok"],
        properties: {
          version: { type: "integer", const: 1 },
          ok: { type: "boolean", const: true }
        }
      },
      workingDirectory: root,
      readOnly: true,
      budgetSeconds: 30
    });
    assert.deepEqual(result.parsed, { version: 1, ok: true });
    assert.equal(result.text, '{"version":1,"ok":true}');
    assert.ok(result.durationMs >= 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
