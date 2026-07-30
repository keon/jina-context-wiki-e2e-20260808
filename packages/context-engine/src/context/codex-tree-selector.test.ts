import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexCliContextTreeSelector } from "./codex-tree-selector.js";
import type { ContextSearchSelectionInput } from "./catalog.js";

test("Codex selector streams exact turn usage with a valid tree selection", async () => {
  await withSelectorBinary(
    [
      event({ type: "item.completed", item: { type: "agent_message", text: '{"nodeIds":["node-1"]}' } }),
      event({
        type: "turn.completed",
        usage: { input_tokens: 91, cached_input_tokens: 40, output_tokens: 17 }
      })
    ],
    0,
    async (binary) => {
      const result = await new CodexCliContextTreeSelector({ binary }).select(selectionInput());
      assert.deepEqual(result, {
        selection: { nodeIds: ["node-1"] },
        modelUsageObserved: true,
        modelUsage: { inputTokens: 91, cachedInputTokens: 40, outputTokens: 17 }
      });
    }
  );
});

test("Codex selector carries completed usage through invalid selection and process failure fallbacks", async () => {
  const usageEvent = event({
    type: "turn.completed",
    usage: { input_tokens: 55, cached_input_tokens: 20, output_tokens: 8 }
  });
  await withSelectorBinary(
    [event({ type: "item.completed", item: { type: "agent_message", text: "not-json" } }), usageEvent],
    0,
    async (binary) => {
      const result = await new CodexCliContextTreeSelector({ binary }).select(selectionInput());
      assert.equal(result.selection, undefined);
      assert.equal(result.modelUsageObserved, true);
      assert.deepEqual(result.modelUsage, { inputTokens: 55, cachedInputTokens: 20, outputTokens: 8 });
      assert.match(result.degradedReason ?? "", /did not return JSON/);
    }
  );
  await withSelectorBinary([usageEvent], 7, async (binary) => {
    const result = await new CodexCliContextTreeSelector({ binary }).select(selectionInput());
    assert.equal(result.selection, undefined);
    assert.equal(result.modelUsageObserved, true);
    assert.deepEqual(result.modelUsage, { inputTokens: 55, cachedInputTokens: 20, outputTokens: 8 });
    assert.match(result.degradedReason ?? "", /exited with 7/);
  });
});

test("Codex selector reports an explicit unobserved attempt when no turn completed", async () => {
  await withSelectorBinary(
    [event({ type: "item.completed", item: { type: "agent_message", text: '{"nodeIds":["node-1"]}' } })],
    0,
    async (binary) => {
      const result = await new CodexCliContextTreeSelector({ binary }).select(selectionInput());
      assert.deepEqual(result, {
        modelUsageObserved: false,
        degradedReason: "Codex tree selector emitted no valid turn.completed usage"
      });
    }
  );
});

function selectionInput(): ContextSearchSelectionInput {
  return {
    repository: "acme/widget",
    release: {
      id: "release-1",
      repository: "acme/widget",
      ref: "main",
      commitSha: "1".repeat(40),
      createdAt: "2026-07-29T00:00:00.000Z",
      completeness: "complete",
      contextStatus: "available"
    },
    query: "How is the cache invalidated?",
    tree: [
      {
        id: "node-1",
        documentId: "document-1",
        title: "Cache invalidation",
        summary: "Invalidation after commits",
        depth: 0
      }
    ],
    limit: 4
  };
}

function event(value: unknown): string {
  return JSON.stringify(value);
}

async function withSelectorBinary(
  events: readonly string[],
  exitCode: number,
  assertion: (binary: string) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "jina-context-selector-"));
  const binary = join(root, "fake-codex");
  const source = [
    "#!/usr/bin/env node",
    ...events.map((line) => `process.stdout.write(${JSON.stringify(`${line}\n`)});`),
    `process.exitCode = ${exitCode};`
  ].join("\n");
  try {
    await writeFile(binary, source, "utf8");
    await chmod(binary, 0o700);
    await assertion(binary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
