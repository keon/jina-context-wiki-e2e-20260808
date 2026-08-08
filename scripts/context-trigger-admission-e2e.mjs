#!/usr/bin/env node

import { createHmac, randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HELP = `Usage: context-trigger-admission-e2e.mjs [options]

Required (or use the matching environment variables):
  --api-url URL             Explicit loopback API (JINA_API_URL)
  --tenant ID               Tenant ID (JINA_TENANT_ID)
  --internal-token TOKEN    Local internal credential (INTERNAL_API_TOKEN)
  --webhook-secret SECRET   Local GitHub webhook secret (GITHUB_WEBHOOK_SECRET)
  --repository OWNER/REPO
  --branch BRANCH           Current branch, with or without refs/heads/
  --current-sha SHA         Current full branch SHA
  --pr-number N             Real pull-request number
  --pr-head-sha SHA         Current full PR head SHA; must differ from current SHA
  --issue-number N          Genuinely new issue number for this local Board state
  --report PATH             Retained machine-readable JSON report

Optional:
  --principal ID            Default: tenant:<tenant>
  --run-id ID               Default: a random UUID
  --repository-id N         GitHub repository ID for shared-tenancy fixtures
  --installation-id N       GitHub installation ID for shared-tenancy fixtures
  --issue-title TEXT        Default: Context trigger acceptance issue <number>
  --timeout-ms N            Default: 10000
  --max-response-bytes N    Default: 4194304

The harness sends signed webhook fixtures only to the loopback API. It never
contacts GitHub, posts a comment, claims worker work, invokes a model, or starts
an API/worker process. Run it against an isolated API-only local state.
`;

export async function runContextTriggerAdmissionAcceptance(options, dependencies = {}) {
  const config = normalizeOptions(options);
  assertLoopbackHttp(config.apiUrl);
  const fetchImplementation = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const actions = [];
  const violations = [];
  let currentRoots = [];
  let baselineRoots = [];
  let requestSequence = 0;

  const request = async (path, input = {}) => {
    requestSequence += 1;
    const started = performance.now();
    const bodyText = input.rawBody ?? (input.body === undefined ? undefined : JSON.stringify(input.body));
    try {
      const response = await fetchImplementation(new URL(path, config.apiUrl), {
        method: input.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(input.auth === false ? {} : { authorization: `Bearer ${config.internalToken}` }),
          ...(input.auth === false
            ? {}
            : {
                "x-jina-tenant-id": config.tenantId,
                "x-jina-principal-id": config.principalId
              }),
          "x-request-id": `context-trigger-admission-${process.pid}-${requestSequence}`,
          ...(bodyText === undefined ? {} : { "content-type": "application/json" }),
          ...(input.headers ?? {})
        },
        ...(bodyText === undefined ? {} : { body: bodyText }),
        signal: AbortSignal.timeout(config.timeoutMs)
      });
      const responseBody = await readBoundedResponseBody(response, config.maxResponseBytes);
      if (responseBody.error) {
        return {
          status: response.status,
          latencyMs: rounded(performance.now() - started),
          bytes: responseBody.bytes,
          error: responseBody.error
        };
      }
      let body;
      try {
        body = responseBody.text ? JSON.parse(responseBody.text) : {};
      } catch {
        return {
          status: response.status,
          latencyMs: rounded(performance.now() - started),
          bytes: responseBody.bytes,
          error: "invalid_json"
        };
      }
      return {
        status: response.status,
        latencyMs: rounded(performance.now() - started),
        bytes: responseBody.bytes,
        body
      };
    } catch (error) {
      return {
        status: 0,
        latencyMs: rounded(performance.now() - started),
        bytes: 0,
        error: requestErrorCode(error)
      };
    }
  };

  const readRoots = async () => {
    const response = await request("/board");
    if (response.status !== 200 || response.error) {
      throw new Error("Board snapshot did not return a bounded JSON HTTP 200 response");
    }
    const board = requiredObject(response.body, "Board response");
    return requiredArray(board.tasks, "Board tasks")
      .map((task) => requiredObject(task, "Board task"))
      .filter(
        (task) =>
          task.type === "build-context" &&
          String(requiredObject(task.metadata, "Board task metadata").repository).toLowerCase() === config.repository
      )
      .map(rootSummary)
      .sort(compareRoots);
  };

  const executeAction = async (spec, invoke) => {
    const before = await readRoots();
    if (!sameRootIds(before, currentRoots)) {
      addViolation(
        violations,
        "concurrent_board_mutation",
        `${spec.name}: Board roots changed outside the harness action`
      );
    }
    const response = await invoke();
    const after = await readRoots();
    const beforeIds = new Set(before.map((root) => root.id));
    const afterIds = new Set(after.map((root) => root.id));
    const created = after.filter((root) => !beforeIds.has(root.id));
    const removed = before.filter((root) => !afterIds.has(root.id));
    const record = {
      name: spec.name,
      channel: spec.channel,
      ...(spec.event ? { event: spec.event } : {}),
      ...(spec.deliveryId ? { deliveryId: spec.deliveryId } : {}),
      expected: {
        httpStatus: spec.status,
        buildDelta: spec.delta,
        ...(spec.root ? { root: spec.root } : {}),
        ...(spec.requestKey ? { requestKey: spec.requestKey } : {}),
        ...(spec.idempotency ? { idempotency: spec.idempotency } : {})
      },
      observed: {
        httpStatus: response.status,
        latencyMs: response.latencyMs,
        bytes: response.bytes,
        ...(response.error ? { error: response.error } : {}),
        ...responseSummary(response.body),
        buildDelta: created.length,
        newBuilds: created
      }
    };
    actions.push(record);

    if (response.status !== spec.status || response.error) {
      addViolation(
        violations,
        "unexpected_http_status",
        `${spec.name}: expected HTTP ${spec.status}, received ${response.status}${response.error ? ` (${response.error})` : ""}`
      );
    }
    if (created.length !== spec.delta) {
      addViolation(
        violations,
        "unexpected_build_delta",
        `${spec.name}: expected ${spec.delta} new build root(s), observed ${created.length}`
      );
    }
    if (removed.length > 0) {
      addViolation(
        violations,
        "build_root_removed",
        `${spec.name}: ${removed.length} existing build root(s) disappeared`
      );
    }
    if (spec.root && created.length === 1) {
      validateRoot(spec.name, created[0], spec.root, violations);
    }
    if (spec.response === "created" && response.body?.outcome !== "created") {
      addViolation(violations, "webhook_outcome", `${spec.name}: signed trigger did not report outcome=created`);
    }
    if (spec.response === "delivery-duplicate" && response.body?.duplicate !== true) {
      addViolation(violations, "delivery_idempotency", `${spec.name}: replay did not report duplicate=true`);
    }
    if (spec.response === "request-key-duplicate" && response.body?.outcome !== "duplicate") {
      addViolation(
        violations,
        "request_key_idempotency",
        `${spec.name}: distinct delivery did not collapse to outcome=duplicate`
      );
    }
    if (spec.response === "manual-created") {
      const responseBuild = optionalObject(response.body?.build);
      if (!responseBuild || created.length !== 1 || responseBuild.id !== created[0].id) {
        addViolation(
          violations,
          "manual_response_identity",
          `${spec.name}: manual response did not identify the exact new build`
        );
      }
    }
    if (spec.response === "manual-duplicate") {
      const responseBuild = optionalObject(response.body?.build);
      if (response.body?.duplicate !== true || !responseBuild || responseBuild.id !== spec.existingBuildId) {
        addViolation(
          violations,
          "request_key_idempotency",
          `${spec.name}: manual request-key replay did not return the original build`
        );
      }
    }
    currentRoots = after;
    return { response, created };
  };

  try {
    baselineRoots = await readRoots();
    currentRoots = baselineRoots;
    let branchSequence = refFrontier(baselineRoots, config.branch);
    let pullSequence = refFrontier(baselineRoots, config.pullRef);

    const manualRequestKey = `context-trigger-acceptance:${config.runId}:manual`;
    branchSequence += 1;
    const manual = await executeAction(
      {
        name: "manual",
        channel: "api",
        status: 202,
        delta: 1,
        requestKey: manualRequestKey,
        response: "manual-created",
        root: expectedRoot(config, {
          ref: config.branch,
          refSequence: branchSequence,
          commitSha: config.currentSha,
          trigger: "manual"
        })
      },
      () =>
        request("/wiki/build", {
          method: "POST",
          body: {
            repository: config.repositoryInput,
            ref: config.branch,
            commitSha: config.currentSha,
            requestKey: manualRequestKey,
            ...(config.installationId ? { githubInstallationId: config.installationId } : {})
          }
        })
    );
    const manualBuildId = manual.created[0]?.id;

    await executeAction(
      {
        name: "manual_request_key_replay",
        channel: "api",
        status: 200,
        delta: 0,
        requestKey: manualRequestKey,
        idempotency: "same request key returns the original build and sequence",
        response: "manual-duplicate",
        existingBuildId: manualBuildId
      },
      () =>
        request("/wiki/build", {
          method: "POST",
          body: {
            repository: config.repositoryInput,
            ref: config.branch,
            commitSha: config.currentSha,
            requestKey: manualRequestKey,
            ...(config.installationId ? { githubInstallationId: config.installationId } : {})
          }
        })
    );

    const pushDelivery = deliveryId(config, "push");
    const pushPayload = pushFixture(config);
    branchSequence += 1;
    await executeAction(
      {
        name: "push",
        channel: "signed_webhook",
        event: "push",
        deliveryId: pushDelivery,
        status: 202,
        delta: 1,
        requestKey: `github:push:${config.repository}:${config.branch}:${config.currentSha}:${pushDelivery}`,
        response: "created",
        root: expectedRoot(config, {
          ref: config.branch,
          refSequence: branchSequence,
          commitSha: config.currentSha,
          trigger: "push"
        })
      },
      () => signedWebhook(request, config, "push", pushDelivery, pushPayload)
    );

    await executeAction(
      {
        name: "push_duplicate_delivery",
        channel: "signed_webhook",
        event: "push",
        deliveryId: pushDelivery,
        status: 200,
        delta: 0,
        idempotency: "same delivery ID is acknowledged without new Board work",
        response: "delivery-duplicate"
      },
      () => signedWebhook(request, config, "push", pushDelivery, pushPayload)
    );

    const openedDelivery = deliveryId(config, "pr-opened");
    const openedPayload = pullRequestFixture(config, "opened", config.currentSha);
    pullSequence += 1;
    await executeAction(
      {
        name: "pull_request_opened",
        channel: "signed_webhook",
        event: "pull_request.opened",
        deliveryId: openedDelivery,
        status: 202,
        delta: 1,
        requestKey: `github:pull:${config.repository}:${config.prNumber}:${config.currentSha}:${openedDelivery}`,
        response: "created",
        root: expectedRoot(config, {
          ref: config.pullRef,
          refSequence: pullSequence,
          commitSha: config.currentSha,
          trigger: "pull_request"
        })
      },
      () => signedWebhook(request, config, "pull_request", openedDelivery, openedPayload)
    );

    const synchronizeDelivery = deliveryId(config, "pr-synchronize");
    const synchronizePayload = pullRequestFixture(config, "synchronize", config.prHeadSha);
    pullSequence += 1;
    await executeAction(
      {
        name: "pull_request_synchronize",
        channel: "signed_webhook",
        event: "pull_request.synchronize",
        deliveryId: synchronizeDelivery,
        status: 202,
        delta: 1,
        requestKey: `github:pull:${config.repository}:${config.prNumber}:${config.prHeadSha}:${synchronizeDelivery}`,
        response: "created",
        root: expectedRoot(config, {
          ref: config.pullRef,
          refSequence: pullSequence,
          commitSha: config.prHeadSha,
          trigger: "pull_request"
        })
      },
      () => signedWebhook(request, config, "pull_request", synchronizeDelivery, synchronizePayload)
    );

    const issueDelivery = deliveryId(config, "issue-opened");
    const issuePayload = issueFixture(config);
    branchSequence += 1;
    await executeAction(
      {
        name: "issue_opened",
        channel: "signed_webhook",
        event: "issues.opened",
        deliveryId: issueDelivery,
        status: 202,
        delta: 1,
        requestKey: `github:issue:${config.repository}:${config.issueNumber}`,
        response: "created",
        root: expectedRoot(config, {
          ref: config.branch,
          refSequence: branchSequence,
          commitSha: null,
          trigger: "issue"
        })
      },
      () => signedWebhook(request, config, "issues", issueDelivery, issuePayload)
    );

    const issueReplayDelivery = deliveryId(config, "issue-distinct-replay");
    await executeAction(
      {
        name: "issue_request_key_replay",
        channel: "signed_webhook",
        event: "issues.opened",
        deliveryId: issueReplayDelivery,
        status: 202,
        delta: 0,
        requestKey: `github:issue:${config.repository}:${config.issueNumber}`,
        idempotency: "same issue with a distinct delivery collapses through the provider request key",
        response: "request-key-duplicate"
      },
      () => signedWebhook(request, config, "issues", issueReplayDelivery, issuePayload)
    );

    const commentDelivery = deliveryId(config, "issue-comment");
    await executeAction(
      {
        name: "issue_comment_noop",
        channel: "signed_webhook",
        event: "issue_comment.created",
        deliveryId: commentDelivery,
        status: 202,
        delta: 0,
        idempotency: "signed comment delivery is persisted but creates no Context build"
      },
      () => signedWebhook(request, config, "issue_comment", commentDelivery, issueCommentFixture(config))
    );

    const staleDelivery = deliveryId(config, "pr-stale-distinct");
    const stalePayload = pullRequestFixture(config, "synchronize", config.currentSha);
    pullSequence += 1;
    await executeAction(
      {
        name: "out_of_order_distinct_delivery",
        channel: "signed_webhook",
        event: "pull_request.synchronize",
        deliveryId: staleDelivery,
        status: 202,
        delta: 1,
        requestKey: `github:pull:${config.repository}:${config.prNumber}:${config.currentSha}:${staleDelivery}`,
        idempotency:
          "a distinct stale-head delivery receives a new sequence; snapshot fencing must later reject a non-current remote head",
        response: "created",
        root: expectedRoot(config, {
          ref: config.pullRef,
          refSequence: pullSequence,
          commitSha: config.currentSha,
          trigger: "pull_request"
        })
      },
      () => signedWebhook(request, config, "pull_request", staleDelivery, stalePayload)
    );

    await executeAction(
      {
        name: "delayed_opened_delivery_replay",
        channel: "signed_webhook",
        event: "pull_request.opened",
        deliveryId: openedDelivery,
        status: 200,
        delta: 0,
        idempotency: "an original delivery replayed after newer heads retains its first sequence",
        response: "delivery-duplicate"
      },
      () => signedWebhook(request, config, "pull_request", openedDelivery, openedPayload)
    );
  } catch (error) {
    addViolation(violations, "acceptance_contract", safeErrorMessage(error));
  }

  const finishedAt = now().toISOString();
  const expectedBuildDelta = actions.reduce((sum, action) => sum + action.expected.buildDelta, 0);
  const actualBuildDelta = actions.reduce((sum, action) => sum + action.observed.buildDelta, 0);
  return {
    schemaVersion: "context-trigger-admission-e2e-v1",
    status: violations.length === 0 ? "passed" : "failed",
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    target: {
      apiUrl: config.apiUrl,
      tenantId: config.tenantId,
      repositoryInput: config.repositoryInput,
      repository: config.repository,
      branchInput: config.branchInput,
      branch: config.branch,
      currentSha: config.currentSha,
      pullRequest: {
        number: config.prNumber,
        ref: config.pullRef,
        headSha: config.prHeadSha
      },
      issue: { number: config.issueNumber },
      runId: config.runId
    },
    safety: {
      loopbackOnly: true,
      githubRequests: 0,
      githubCommentsCreated: 0,
      workerClaims: 0,
      modelInvocations: 0
    },
    baseline: {
      buildRoots: baselineRoots.length,
      scopedRoots: baselineRoots
    },
    actions,
    final: {
      buildRoots: currentRoots.length,
      scopedRoots: currentRoots,
      expectedBuildDelta,
      actualBuildDelta
    },
    violations
  };
}

async function signedWebhook(request, config, eventName, delivery, payload) {
  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", config.webhookSecret).update(rawBody).digest("hex")}`;
  return request("/webhooks/github", {
    auth: false,
    method: "POST",
    rawBody,
    headers: {
      "x-github-event": eventName,
      "x-github-delivery": delivery,
      "x-hub-signature-256": signature
    }
  });
}

function pushFixture(config) {
  return {
    ref: `refs/heads/${config.branch}`,
    before: "0".repeat(40),
    after: config.currentSha,
    deleted: false,
    ...providerFixture(config)
  };
}

function pullRequestFixture(config, action, headSha) {
  return {
    action,
    number: config.prNumber,
    pull_request: {
      number: config.prNumber,
      title: `Context trigger acceptance PR ${config.prNumber}`,
      head: { sha: headSha },
      base: { sha: config.currentSha },
      draft: false
    },
    ...providerFixture(config)
  };
}

function issueFixture(config) {
  return {
    action: "opened",
    issue: {
      number: config.issueNumber,
      title: config.issueTitle
    },
    ...providerFixture(config)
  };
}

function issueCommentFixture(config) {
  return {
    action: "created",
    issue: { number: config.issueNumber },
    comment: {
      id: config.issueNumber * 1_000 + 1,
      body: "Local Context trigger acceptance no-op fixture."
    },
    ...providerFixture(config)
  };
}

function providerFixture(config) {
  return {
    repository: {
      full_name: config.repositoryInput,
      default_branch: config.branch,
      ...(config.repositoryId ? { id: config.repositoryId } : {})
    },
    ...(config.installationId ? { installation: { id: config.installationId } } : {})
  };
}

function deliveryId(config, suffix) {
  return `context-trigger-${config.runId}-${suffix}`;
}

function expectedRoot(config, input) {
  return {
    tenantId: config.tenantId,
    repository: config.repository,
    ...input
  };
}

function validateRoot(action, actual, expected, violations) {
  for (const key of ["tenantId", "repository", "ref", "refSequence", "trigger"]) {
    if (actual[key] !== expected[key]) {
      addViolation(
        violations,
        "build_root_contract",
        `${action}: expected ${key}=${expected[key]}, observed ${actual[key]}`
      );
    }
  }
  if (expected.commitSha === null) {
    if (actual.commitSha !== undefined) {
      addViolation(violations, "build_root_contract", `${action}: issue build unexpectedly retained a commit SHA`);
    }
  } else if (actual.commitSha !== expected.commitSha) {
    addViolation(
      violations,
      "build_root_contract",
      `${action}: expected commitSha=${expected.commitSha}, observed ${actual.commitSha}`
    );
  }
}

function rootSummary(task) {
  const metadata = requiredObject(task.metadata, "Board task metadata");
  const refSequence = Number(metadata.refSequence);
  if (!Number.isSafeInteger(refSequence) || refSequence < 1) {
    throw new Error("Board build root has an invalid refSequence");
  }
  return {
    id: requiredString(task.id, "Board build id"),
    tenantId: requiredString(metadata.tenantId, "Board build tenantId"),
    repository: requiredString(metadata.repository, "Board build repository"),
    ref: requiredString(metadata.ref, "Board build ref"),
    refSequence,
    ...(typeof metadata.commitSha === "string" ? { commitSha: metadata.commitSha } : {}),
    trigger: requiredString(metadata.trigger, "Board build trigger"),
    status: requiredString(task.status, "Board build status")
  };
}

function refFrontier(roots, ref) {
  return roots.filter((root) => root.ref === ref).reduce((maximum, root) => Math.max(maximum, root.refSequence), 0);
}

function sameRootIds(left, right) {
  return left.length === right.length && left.every((root, index) => root.id === right[index]?.id);
}

function compareRoots(left, right) {
  return left.ref.localeCompare(right.ref) || left.refSequence - right.refSequence || left.id.localeCompare(right.id);
}

function responseSummary(value) {
  const body = optionalObject(value);
  if (!body) return {};
  return {
    ...(typeof body.outcome === "string" ? { outcome: body.outcome } : {}),
    ...(typeof body.duplicate === "boolean" ? { duplicate: body.duplicate } : {}),
    ...(typeof body.deliveryId === "string" ? { responseDeliveryId: body.deliveryId } : {}),
    ...(optionalObject(body.build) && typeof body.build.id === "string" ? { responseBuildId: body.build.id } : {})
  };
}

function normalizeOptions(options) {
  const tenantId = requiredOption(options.tenantId, "tenantId");
  const repositoryInput = requiredOption(options.repository, "repository");
  const repository = repositoryInput.toLowerCase();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error("repository must be owner/name");
  }
  const branchInput = requiredOption(options.branch, "branch");
  const branch = normalizeBranch(branchInput);
  const currentSha = gitSha(options.currentSha, "currentSha");
  const prHeadSha = gitSha(options.prHeadSha, "prHeadSha");
  if (currentSha === prHeadSha) {
    throw new Error("prHeadSha must differ from currentSha for synchronize/out-of-order proof");
  }
  const prNumber = positiveInteger(options.prNumber, "prNumber");
  const issueNumber = positiveInteger(options.issueNumber, "issueNumber");
  const repositoryId =
    options.repositoryId === undefined ? undefined : positiveInteger(options.repositoryId, "repositoryId");
  const installationId =
    options.installationId === undefined ? undefined : positiveInteger(options.installationId, "installationId");
  const runId = (options.runId?.trim() || randomUUID()).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(runId)) {
    throw new Error("runId must be 1-80 lowercase-safe identifier characters");
  }
  return {
    apiUrl: requiredOption(options.apiUrl, "apiUrl").replace(/\/$/, ""),
    tenantId,
    principalId: options.principalId?.trim() || `tenant:${tenantId}`,
    internalToken: requiredOption(options.internalToken, "internalToken"),
    webhookSecret: requiredOption(options.webhookSecret, "webhookSecret"),
    repositoryInput,
    repository,
    branchInput,
    branch,
    currentSha,
    prNumber,
    prHeadSha,
    pullRef: `pull/${prNumber}/head`,
    issueNumber,
    issueTitle: options.issueTitle?.trim() || `Context trigger acceptance issue ${issueNumber}`,
    runId,
    repositoryId,
    installationId,
    timeoutMs: boundedInteger(options.timeoutMs ?? 10_000, "timeoutMs", 500, 120_000),
    maxResponseBytes: boundedInteger(
      options.maxResponseBytes ?? 4 * 1024 * 1024,
      "maxResponseBytes",
      1_024,
      32 * 1024 * 1024
    )
  };
}

function normalizeBranch(value) {
  const branch = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{") ||
    branch.endsWith("/") ||
    branch.endsWith(".")
  ) {
    throw new Error("branch is not a safe branch ref");
  }
  return branch;
}

function gitSha(value, label) {
  const normalized = requiredOption(value, label).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`${label} must be a full 40-character Git SHA`);
  }
  return normalized;
}

function assertLoopbackHttp(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:") throw new Error("API URL must use loopback HTTP");
  if (parsed.username || parsed.password) {
    throw new Error("API URL must not contain credentials");
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("API URL must be explicitly loopback; external targets are forbidden");
  }
}

async function readBoundedResponseBody(response, maximumBytes) {
  const advertisedBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedBytes) && advertisedBytes > maximumBytes) {
    await cancelBody(response.body);
    return { text: "", bytes: advertisedBytes, error: "response_too_large" };
  }
  if (!response.body) return { text: "", bytes: 0 };
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) {
        await cancelBody(reader);
        return { text: "", bytes, error: "response_too_large" };
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks, bytes).toString("utf8"), bytes };
}

async function cancelBody(body) {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    return;
  }
}

function addViolation(violations, code, message) {
  const violation = { code, message: String(message).slice(0, 500) };
  if (!violations.some((current) => current.code === violation.code && current.message === violation.message)) {
    violations.push(violation);
  }
}

function requestErrorCode(error) {
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && /timeout/i.test(error.message)) return "timeout";
  return "request_failed";
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function optionalObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function requiredArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function requiredOption(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function boundedInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function cliOptions(argv, environment) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) throw new Error(`unexpected argument ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values[name.slice(2)] = value;
    index += 1;
  }
  return {
    apiUrl: values["api-url"] ?? environment.JINA_API_URL,
    tenantId: values.tenant ?? environment.JINA_TENANT_ID ?? environment.JINA_CONTEXT_TENANT_ID,
    principalId: values.principal ?? environment.CONTEXT_TRIGGER_ADMISSION_PRINCIPAL_ID,
    internalToken: values["internal-token"] ?? environment.JINA_INTERNAL_TOKEN ?? environment.INTERNAL_API_TOKEN,
    webhookSecret: values["webhook-secret"] ?? environment.GITHUB_WEBHOOK_SECRET,
    repository: values.repository ?? environment.CONTEXT_TRIGGER_ADMISSION_REPOSITORY,
    branch: values.branch ?? environment.CONTEXT_TRIGGER_ADMISSION_BRANCH,
    currentSha: values["current-sha"] ?? environment.CONTEXT_TRIGGER_ADMISSION_CURRENT_SHA,
    prNumber: values["pr-number"] ?? environment.CONTEXT_TRIGGER_ADMISSION_PR_NUMBER,
    prHeadSha: values["pr-head-sha"] ?? environment.CONTEXT_TRIGGER_ADMISSION_PR_HEAD_SHA,
    issueNumber: values["issue-number"] ?? environment.CONTEXT_TRIGGER_ADMISSION_ISSUE_NUMBER,
    issueTitle: values["issue-title"] ?? environment.CONTEXT_TRIGGER_ADMISSION_ISSUE_TITLE,
    runId: values["run-id"] ?? environment.CONTEXT_TRIGGER_ADMISSION_RUN_ID,
    repositoryId: values["repository-id"] ?? environment.CONTEXT_TRIGGER_ADMISSION_REPOSITORY_ID,
    installationId: values["installation-id"] ?? environment.CONTEXT_TRIGGER_ADMISSION_INSTALLATION_ID,
    timeoutMs: values["timeout-ms"] ?? environment.CONTEXT_TRIGGER_ADMISSION_TIMEOUT_MS,
    maxResponseBytes: values["max-response-bytes"] ?? environment.CONTEXT_TRIGGER_ADMISSION_MAX_RESPONSE_BYTES,
    reportPath: values.report ?? environment.CONTEXT_TRIGGER_ADMISSION_REPORT
  };
}

async function writeReport(reportPath, report) {
  const destination = resolve(requiredOption(reportPath, "report"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600
  });
  await chmod(destination, 0o600);
  return destination;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  let options;
  try {
    const arguments_ = process.argv.slice(2).filter((value) => value !== "--");
    if (arguments_.includes("--help") || arguments_.includes("-h")) {
      process.stdout.write(HELP);
      process.exit(0);
    }
    options = cliOptions(arguments_, process.env);
    const report = await runContextTriggerAdmissionAcceptance(options);
    const destination = await writeReport(options.reportPath, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`Retained Context trigger-admission report: ${destination}\n`);
    if (report.status !== "passed") process.exitCode = 1;
  } catch (error) {
    const failed = {
      schemaVersion: "context-trigger-admission-e2e-v1",
      status: "failed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      violations: [{ code: "harness_configuration", message: safeErrorMessage(error) }]
    };
    try {
      if (options?.reportPath) await writeReport(options.reportPath, failed);
    } catch {
      // Preserve the original bounded diagnostic.
    }
    process.stderr.write(`Context trigger-admission acceptance failed: ${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
