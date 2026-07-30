#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LocalPageIndexClient,
  parseContextOrchestrationState,
  selectContextTreeLexically
} from "../packages/context-engine/dist/index.js";

const deriveDirectory = required("CONTEXT_DERIVE_DIR");
const workerPath = required("CONTEXT_PAGEINDEX_WORKER");
const plan = parseContextOrchestrationState(
  JSON.parse(await readFile(join(deriveDirectory, "derive-state", "plan.json"), "utf8"))
);
const itemById = new Map(plan.items.map((item) => [item.id, item]));
const questions = plan.subjects
  .flatMap((subject) => subject.questions)
  .filter((question) => question.priority === "required" && question.status === "answered");
assert.ok(questions.length > 0, "the completed plan has no answered required maintenance questions");

const documents = await Promise.all(
  plan.items
    .filter((item) => item.status === "complete")
    .map(async (item) => ({
      id: item.id,
      title: item.title,
      body: await readFile(join(deriveDirectory, "derive-output", item.path), "utf8"),
      contextualText: await readFile(join(deriveDirectory, "derive-output", item.path), "utf8"),
      anchors: [],
      aclFingerprint: "local-quality-benchmark"
    }))
);
const pageIndex = new LocalPageIndexClient({
  python: process.env.CONTEXT_PAGEINDEX_PYTHON,
  workerPath,
  timeoutMs: integer("CONTEXT_RETRIEVAL_TREE_TIMEOUT_MS", 60_000)
});
const probe = await pageIndex.probe();
assert.equal(probe.available, true, probe.reason);
const tree = await pageIndex.build(
  {
    tenantId: "local-quality-benchmark",
    repository: plan.repository,
    ref: plan.ref,
    commitSha: plan.commitSha,
    generationId: "local-quality-benchmark",
    adapterVersion: "retrieval-benchmark-v1",
    documents,
    limits: {
      timeoutMs: integer("CONTEXT_RETRIEVAL_TREE_TIMEOUT_MS", 60_000),
      maxDocumentCharacters: 2_000_000,
      maxNodes: 20_000
    }
  },
  AbortSignal.timeout(integer("CONTEXT_RETRIEVAL_TREE_TIMEOUT_MS", 60_000))
);
const selectorTree = tree.nodes.map((node) => ({
  id: node.externalId,
  documentId: node.documentId,
  ...(node.parentExternalId ? { parentId: node.parentExternalId } : {}),
  title: node.title,
  summary: node.summary,
  depth: node.depth
}));
const results = [];
for (const question of questions) {
  try {
    const selection = selectContextTreeLexically(
      question.question,
      selectorTree,
      documents,
      integer("CONTEXT_RETRIEVAL_NODE_LIMIT", 5)
    );
    const nodeIds = new Set(selection.nodeIds);
    const selectedPageIds = [
      ...new Set(tree.nodes.filter((node) => nodeIds.has(node.externalId)).map((node) => node.documentId))
    ];
    const expectedPageIds = question.pageIds.filter((pageId) => itemById.has(pageId));
    results.push({
      questionId: question.id,
      question: question.question,
      expectedPageIds,
      selectedPageIds,
      hit: expectedPageIds.some((pageId) => selectedPageIds.includes(pageId))
    });
  } catch (error) {
    results.push({
      questionId: question.id,
      question: question.question,
      expectedPageIds: question.pageIds,
      selectedPageIds: [],
      hit: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

const hits = results.filter((result) => result.hit).length;
const report = {
  schemaVersion: "context-retrieval-benchmark-v1",
  repository: plan.repository,
  ref: plan.ref,
  commitSha: plan.commitSha,
  deriveDirectory,
  selector: "pageindex-lexical-tree-v1",
  pageIndex: `${tree.adapterName}@${tree.adapterVersion}`,
  treeNodes: tree.nodes.length,
  requiredQuestions: results.length,
  hits,
  hitRate: hits / results.length,
  results
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

const minimumHitRate = number("CONTEXT_RETRIEVAL_MIN_HIT_RATE", 1);
if (report.hitRate < minimumHitRate || results.some((result) => result.error)) process.exitCode = 1;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function number(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`);
  return value;
}
