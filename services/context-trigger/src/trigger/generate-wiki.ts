import { batch, logger, tags, task } from "@trigger.dev/sdk";

import { ContextWikiApiClient } from "../shared/api.js";
import {
  type GenerateWikiPayloadV1,
  type JsonValue,
  type WikiStageResult,
  type WikiStageTaskPayload,
  assertBoundedJson,
  assertSameCanonical,
  canonicalSha256,
  parseGenerateWikiPayload,
  parsePageJobs,
  parseWikiCompletedOutput,
  parseWikiStageResult
} from "../shared/contracts.js";
import { wikiFinalize } from "./wiki-finalize.js";
import { wikiPageIndex } from "./wiki-pageindex.js";
import { wikiPlan } from "./wiki-plan.js";
import { wikiProject } from "./wiki-project.js";
import { wikiSnapshot } from "./wiki-snapshot.js";
import { wikiWritePage } from "./wiki-write-page.js";
import { notifyTerminalWikiFailure } from "../workflow/reconciliation.js";

type WikiChildTask =
  | typeof wikiSnapshot
  | typeof wikiPlan
  | typeof wikiWritePage
  | typeof wikiFinalize
  | typeof wikiProject
  | typeof wikiPageIndex;

type WikiChildTaskId =
  "wiki-snapshot" | "wiki-plan" | "wiki-write-page" | "wiki-finalize" | "wiki-project" | "wiki-pageindex";

type ChildRunResult = { ok: boolean; output?: unknown; error?: unknown; taskIdentifier?: string };

export const generateWiki = task({
  id: "generate-wiki",
  queue: { concurrencyLimit: 10 },
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1_000, maxTimeoutInMs: 30_000, randomize: true },
  machine: { preset: "small-1x" },
  maxDuration: 3_600,
  onFailure: async ({
    payload: untrustedPayload,
    ctx
  }: {
    payload: GenerateWikiPayloadV1;
    ctx: { run: { id: string } };
  }) => {
    try {
      const payload = parseGenerateWikiPayload(untrustedPayload);
      const receipt = await notifyTerminalWikiFailure({
        payload,
        triggerParentRunId: ctx.run.id,
        failedAt: new Date().toISOString(),
        api: new ContextWikiApiClient()
      });
      logger.info("generate_wiki_terminal_failure_recorded", {
        trigger_parent_run_id: ctx.run.id,
        board_build_hash: shortHash(payload.request.boardBuildId),
        request_digest: payload.requestDigest,
        outcome: receipt.outcome,
        replay: receipt.replay
      });
    } catch {
      // Trigger ignores hook errors. The five-minute reconciler covers this
      // path and terminal states for which Trigger never invokes onFailure.
      logger.error("generate_wiki_terminal_failure_callback_deferred", {
        trigger_parent_run_id: ctx.run.id
      });
    }
  },
  run: async (untrustedPayload: GenerateWikiPayloadV1, { ctx }) => {
    // Parsing and hashing are effect-free. The claim below must remain the first
    // network or Trigger metadata effect in this task.
    const payload = parseGenerateWikiPayload(untrustedPayload);
    const api = new ContextWikiApiClient();
    const claim = await api.claimBuild({ payload, triggerParentRunId: ctx.run.id });
    assertSameCanonical(claim.request, payload.request, "claimed build request");

    const taskTags = hashedBuildTags(payload);
    await tags.add(taskTags).catch(() => undefined);
    logger.info("generate_wiki_claimed", {
      trigger_parent_run_id: ctx.run.id,
      board_build_hash: shortHash(payload.request.boardBuildId),
      repository_hash: shortHash(payload.request.repository),
      request_digest: payload.requestDigest,
      attempt: payload.attempt
    });

    const snapshot = await runOneChild(
      "wiki-snapshot",
      stagePayload({
        payload,
        executionGrant: claim.executionGrant,
        operationId: operationId(payload.requestDigest, "snapshot"),
        input: {}
      }),
      taskTags
    );

    const plan = await runOneChild(
      "wiki-plan",
      stagePayload({
        payload,
        executionGrant: claim.executionGrant,
        operationId: operationId(payload.requestDigest, "plan"),
        input: { snapshot: snapshot.output }
      }),
      taskTags
    );
    const pageJobs = parsePageJobs(plan.output);

    const writePayloads = pageJobs.map((pageJob, index) =>
      stagePayload({
        payload,
        executionGrant: claim.executionGrant,
        operationId: operationId(payload.requestDigest, "write-page", String(index)),
        input: { snapshot: snapshot.output, plan: plan.output, pageJob }
      })
    );
    assertBoundedJson(writePayloads, 2 * 1024 * 1024, "wiki page batch");
    const pages = await runPageChildren(writePayloads, taskTags);

    const finalize = await runOneChild(
      "wiki-finalize",
      stagePayload({
        payload,
        executionGrant: claim.executionGrant,
        operationId: operationId(payload.requestDigest, "finalize"),
        input: {
          snapshot: snapshot.output,
          plan: plan.output,
          pages: pages.map((page) => page.output)
        }
      }),
      taskTags
    );

    const project = await runOneChild(
      "wiki-project",
      stagePayload({
        payload,
        executionGrant: claim.executionGrant,
        operationId: operationId(payload.requestDigest, "project"),
        input: { finalized: finalize.output }
      }),
      taskTags
    );

    const pageindex = await runOneChild(
      "wiki-pageindex",
      stagePayload({
        payload,
        executionGrant: claim.executionGrant,
        operationId: operationId(payload.requestDigest, "pageindex"),
        input: { projected: project.output }
      }),
      taskTags
    );

    const completed = parseWikiCompletedOutput(pageindex.output);
    assertCompletedIdentity(completed, payload, ctx.run.id);
    const completion = await api.completeBuild({
      boardBuildId: payload.request.boardBuildId,
      executionGrant: claim.executionGrant,
      result: completed
    });
    logger.info("generate_wiki_completed", {
      trigger_parent_run_id: ctx.run.id,
      board_build_hash: shortHash(payload.request.boardBuildId),
      repository_hash: shortHash(payload.request.repository),
      request_digest: payload.requestDigest,
      release_hash: shortHash(completed.releaseId),
      public_snapshot_digest: completed.publicSnapshotDigest,
      page_count: pages.length,
      completion_replay: completion.replay
    });
    return completed;
  }
});

function stagePayload(input: {
  payload: GenerateWikiPayloadV1;
  executionGrant: string;
  operationId: string;
  input: JsonValue;
}): WikiStageTaskPayload {
  return {
    schemaVersion: 1,
    authorityId: input.payload.request.boardBuildId,
    requestDigest: input.payload.requestDigest,
    executionGrant: input.executionGrant,
    operationId: input.operationId,
    input: input.input
  };
}

async function runOneChild(
  id: Exclude<WikiChildTaskId, "wiki-write-page">,
  payload: WikiStageTaskPayload,
  taskTags: string[]
): Promise<WikiStageResult> {
  const result = await batch.triggerAndWait<WikiChildTask>([
    {
      id,
      payload,
      options: childOptions(payload.operationId, taskTags)
    }
  ]);
  const run = result.runs[0] as ChildRunResult | undefined;
  return normalizeChildRun(run, id, payload.operationId);
}

async function runPageChildren(payloads: WikiStageTaskPayload[], taskTags: string[]): Promise<WikiStageResult[]> {
  const result = await batch.triggerAndWait<typeof wikiWritePage>(
    payloads.map((payload) => ({
      id: "wiki-write-page" as const,
      payload,
      options: childOptions(payload.operationId, taskTags)
    }))
  );
  if (result.runs.length !== payloads.length) {
    throw new Error(`wiki-write-page returned ${result.runs.length} runs for ${payloads.length} jobs`);
  }
  return result.runs.map((run, index) =>
    normalizeChildRun(run as ChildRunResult, "wiki-write-page", payloads[index]!.operationId)
  );
}

function normalizeChildRun(run: ChildRunResult | undefined, id: WikiChildTaskId, operationId: string): WikiStageResult {
  if (!run?.ok) {
    throw new Error(`${id} failed${run?.taskIdentifier ? ` (${run.taskIdentifier})` : ""}`);
  }
  const result = parseWikiStageResult(run.output);
  if (result.operationId !== operationId) throw new Error(`${id} returned the wrong operationId`);
  return result;
}

function childOptions(operation: string, taskTags: string[]): { idempotencyKey: string; tags: string[]; ttl: string } {
  return { idempotencyKey: operation, tags: taskTags, ttl: "2h" };
}

function operationId(requestDigest: string, stage: string, suffix?: string): string {
  return `wiki:${requestDigest}:${stage}${suffix === undefined ? "" : `:${suffix}`}`;
}

function hashedBuildTags(payload: GenerateWikiPayloadV1): string[] {
  return [
    "kind:context-wiki-build",
    `build:${shortHash(payload.request.boardBuildId)}`,
    `tenant:${shortHash(payload.request.tenantId)}`,
    `repo:${shortHash(payload.request.repository)}`,
    `ref:${shortHash(payload.request.source.ref)}`
  ];
}

function shortHash(value: string): string {
  return canonicalSha256(value).slice(0, 16);
}

function assertCompletedIdentity(
  completed: ReturnType<typeof parseWikiCompletedOutput>,
  payload: GenerateWikiPayloadV1,
  triggerParentRunId: string
): void {
  const expected = payload.request;
  if (
    completed.boardBuildId !== expected.boardBuildId ||
    completed.triggerParentRunId !== triggerParentRunId ||
    completed.requestDigest !== payload.requestDigest ||
    completed.tenantId !== expected.tenantId ||
    completed.repository !== expected.repository ||
    completed.commitSha !== expected.source.commitSha ||
    completed.locale !== expected.requestedLocale ||
    completed.releaseFamilyId !== expected.releaseFamilyId
  ) {
    throw new Error("pageindex completion does not match the authorized build identity");
  }
}
