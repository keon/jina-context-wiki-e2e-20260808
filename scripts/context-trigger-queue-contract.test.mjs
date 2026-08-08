import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sharedContract = await readFile("packages/shared-kernel/src/wiki-trigger-request.ts", "utf8");
const triggerContract = await readFile("services/context-trigger/src/shared/queue-contract.ts", "utf8");
const triggerTask = await readFile("services/context-trigger/src/trigger/generate-wiki.ts", "utf8");

function queueName(source, label) {
  const match = source.match(/CONTEXT_WIKI_TRIGGER_QUEUE_NAME\s*=\s*"([^"]+)"/);
  assert.ok(match, `${label} must declare CONTEXT_WIKI_TRIGGER_QUEUE_NAME`);
  return match[1];
}

test("wiki dispatch queue is declared and matches the Trigger task queue", () => {
  assert.equal(queueName(triggerContract, "Trigger contract"), queueName(sharedContract, "dispatch contract"));
  assert.match(triggerTask, /\bqueue\(\{\s*name:\s*CONTEXT_WIKI_TRIGGER_QUEUE_NAME,/s);
  assert.match(triggerTask, /\bqueue:\s*contextWikiQueue[,\n]/);
});
