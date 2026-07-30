import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runContextTriggerAdmissionAcceptance } from "./context-trigger-admission-e2e.mjs";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = `tenant:${TENANT}`;
const INTERNAL_TOKEN = "trigger-admission-internal";
const WEBHOOK_SECRET = "trigger-admission-webhook-secret";
const REPOSITORY_INPUT = "Acme/Context";
const REPOSITORY = "acme/context";
const BRANCH_INPUT = "refs/heads/Main";
const BRANCH = "Main";
const CURRENT_SHA = "a".repeat(40);
const PR_HEAD_SHA = "b".repeat(40);
const PR_NUMBER = 73;
const ISSUE_NUMBER = 991;
const RUN_ID = "acceptance-run";

test("trigger harness proves the exact incremental admission matrix", async () => {
  await withFakeAdmissionServer({}, async ({ apiUrl, state }) => {
    const report = await runContextTriggerAdmissionAcceptance(baseOptions(apiUrl));

    assert.equal(report.status, "passed");
    assert.equal(report.target.repositoryInput, REPOSITORY_INPUT);
    assert.equal(report.target.repository, REPOSITORY);
    assert.equal(report.target.branchInput, BRANCH_INPUT);
    assert.equal(report.target.branch, BRANCH);
    assert.equal(report.actions.length, 11);
    assert.equal(report.final.expectedBuildDelta, 6);
    assert.equal(report.final.actualBuildDelta, 6);
    assert.deepEqual(
      report.actions.map((action) => [action.name, action.expected.buildDelta, action.observed.buildDelta]),
      [
        ["manual", 1, 1],
        ["manual_request_key_replay", 0, 0],
        ["push", 1, 1],
        ["push_duplicate_delivery", 0, 0],
        ["pull_request_opened", 1, 1],
        ["pull_request_synchronize", 1, 1],
        ["issue_opened", 1, 1],
        ["issue_request_key_replay", 0, 0],
        ["issue_comment_noop", 0, 0],
        ["out_of_order_distinct_delivery", 1, 1],
        ["delayed_opened_delivery_replay", 0, 0]
      ]
    );

    const created = report.actions
      .flatMap((action) => action.observed.newBuilds)
      .map((root) => ({
        ref: root.ref,
        refSequence: root.refSequence,
        commitSha: root.commitSha,
        trigger: root.trigger
      }));
    assert.deepEqual(created, [
      { ref: BRANCH, refSequence: 5, commitSha: CURRENT_SHA, trigger: "manual" },
      { ref: BRANCH, refSequence: 6, commitSha: CURRENT_SHA, trigger: "push" },
      {
        ref: `pull/${PR_NUMBER}/head`,
        refSequence: 3,
        commitSha: CURRENT_SHA,
        trigger: "pull_request"
      },
      {
        ref: `pull/${PR_NUMBER}/head`,
        refSequence: 4,
        commitSha: PR_HEAD_SHA,
        trigger: "pull_request"
      },
      { ref: BRANCH, refSequence: 7, commitSha: undefined, trigger: "issue" },
      {
        ref: `pull/${PR_NUMBER}/head`,
        refSequence: 5,
        commitSha: CURRENT_SHA,
        trigger: "pull_request"
      }
    ]);
    assert.equal(state.invalidSignatures, 0);
    assert.equal(state.webhooks.length, 9);
    assert.deepEqual(
      state.webhooks.map((entry) => entry.event),
      [
        "push",
        "push",
        "pull_request",
        "pull_request",
        "issues",
        "issues",
        "issue_comment",
        "pull_request",
        "pull_request"
      ]
    );
    assert.equal(state.issueComments.length, 1);
    assert.equal(state.externalRequests, 0);

    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(INTERNAL_TOKEN), false);
    assert.equal(serialized.includes(WEBHOOK_SECRET), false);
    assert.equal(serialized.includes("x-hub-signature-256"), false);
  });
});

test("trigger harness fails when a signed issue comment creates a build", async () => {
  await withFakeAdmissionServer({ commentCreatesBuild: true }, async ({ apiUrl }) => {
    const report = await runContextTriggerAdmissionAcceptance(baseOptions(apiUrl));
    assert.equal(report.status, "failed");
    const comment = report.actions.find((action) => action.name === "issue_comment_noop");
    assert.ok(comment);
    assert.equal(comment.expected.buildDelta, 0);
    assert.equal(comment.observed.buildDelta, 1);
    assert.ok(
      report.violations.some(
        (violation) => violation.code === "unexpected_build_delta" && violation.message.includes("issue_comment_noop")
      )
    );
  });
});

test("trigger harness refuses non-loopback targets and a degenerate PR transition", async () => {
  let fetched = false;
  await assert.rejects(
    () =>
      runContextTriggerAdmissionAcceptance(
        {
          ...baseOptions("https://example.com")
        },
        {
          fetch: async () => {
            fetched = true;
            throw new Error("must not fetch");
          }
        }
      ),
    /loopback/
  );
  assert.equal(fetched, false);

  await assert.rejects(
    () =>
      runContextTriggerAdmissionAcceptance({
        ...baseOptions("http://127.0.0.1:3000"),
        prHeadSha: CURRENT_SHA
      }),
    /must differ/
  );
});

test("CLI retains a mode-0600 secret-free failure report and exits nonzero", async () => {
  await withFakeAdmissionServer({ commentCreatesBuild: true }, async ({ apiUrl }) => {
    const directory = await mkdtemp(join(tmpdir(), "jina-trigger-admission-"));
    const reportPath = join(directory, "trigger-admission.json");
    try {
      await writeFile(reportPath, "stale\n", { mode: 0o644 });
      await chmod(reportPath, 0o644);
      const result = await runProcess(process.execPath, [
        "scripts/context-trigger-admission-e2e.mjs",
        "--",
        "--api-url",
        apiUrl,
        "--tenant",
        TENANT,
        "--internal-token",
        INTERNAL_TOKEN,
        "--webhook-secret",
        WEBHOOK_SECRET,
        "--repository",
        REPOSITORY_INPUT,
        "--branch",
        BRANCH_INPUT,
        "--current-sha",
        CURRENT_SHA,
        "--pr-number",
        String(PR_NUMBER),
        "--pr-head-sha",
        PR_HEAD_SHA,
        "--issue-number",
        String(ISSUE_NUMBER),
        "--run-id",
        `${RUN_ID}-cli`,
        "--report",
        reportPath
      ]);
      assert.equal(result.code, 1, result.stderr);
      const reportText = await readFile(reportPath, "utf8");
      const report = JSON.parse(reportText);
      assert.equal(report.status, "failed");
      assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
      assert.equal(reportText.includes(INTERNAL_TOKEN), false);
      assert.equal(reportText.includes(WEBHOOK_SECRET), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function baseOptions(apiUrl) {
  return {
    apiUrl,
    tenantId: TENANT,
    principalId: PRINCIPAL,
    internalToken: INTERNAL_TOKEN,
    webhookSecret: WEBHOOK_SECRET,
    repository: REPOSITORY_INPUT,
    branch: BRANCH_INPUT,
    currentSha: CURRENT_SHA,
    prNumber: PR_NUMBER,
    prHeadSha: PR_HEAD_SHA,
    issueNumber: ISSUE_NUMBER,
    runId: RUN_ID,
    timeoutMs: 5_000
  };
}

async function withFakeAdmissionServer(configuration, run) {
  const state = {
    roots: [
      fakeRoot("task_baseline_branch", BRANCH, 4, "1".repeat(40), "manual"),
      fakeRoot("task_baseline_pull", `pull/${PR_NUMBER}/head`, 2, "2".repeat(40), "pull_request")
    ],
    deliveries: new Set(),
    requestBuilds: new Map(),
    webhooks: [],
    issueComments: [],
    invalidSignatures: 0,
    externalRequests: 0,
    nextRoot: 1
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/board" && request.method === "GET") {
      if (!isAuthorized(request)) return json(response, 401, { error: "unauthorized" });
      return json(response, 200, { tasks: state.roots });
    }
    if (url.pathname === "/context/build" && request.method === "POST") {
      if (!isAuthorized(request)) return json(response, 401, { error: "unauthorized" });
      const body = await readJson(request);
      const requestKey = String(body.requestKey);
      const existing = state.requestBuilds.get(requestKey);
      if (existing) {
        return json(response, 200, { build: publicBuild(existing), duplicate: true });
      }
      const root = createRoot(state, {
        repository: String(body.repository).toLowerCase(),
        ref: String(body.ref),
        commitSha: String(body.commitSha).toLowerCase(),
        trigger: "manual",
        requestKey
      });
      return json(response, 202, { build: publicBuild(root), duplicate: false });
    }
    if (url.pathname === "/webhooks/github" && request.method === "POST") {
      const rawBody = await readText(request);
      const expected = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex")}`;
      if (request.headers["x-hub-signature-256"] !== expected) {
        state.invalidSignatures += 1;
        return json(response, 401, { accepted: false });
      }
      const event = String(request.headers["x-github-event"]);
      const deliveryId = String(request.headers["x-github-delivery"]);
      state.webhooks.push({ event, deliveryId });
      if (state.deliveries.has(deliveryId)) {
        return json(response, 200, { accepted: true, duplicate: true, deliveryId });
      }
      state.deliveries.add(deliveryId);
      const payload = JSON.parse(rawBody);
      if (event === "issue_comment") {
        state.issueComments.push(payload.comment);
        if (configuration.commentCreatesBuild) {
          createRoot(state, {
            repository: REPOSITORY,
            ref: BRANCH,
            trigger: "issue",
            requestKey: `broken-comment:${deliveryId}`
          });
        }
        return json(response, 202, { accepted: true, deliveryId });
      }

      const admission = webhookAdmission(payload, event, deliveryId);
      const existing = state.requestBuilds.get(admission.requestKey);
      if (existing) {
        return json(response, 202, {
          accepted: true,
          deliveryId,
          outcome: "duplicate",
          createdTaskIds: []
        });
      }
      const root = createRoot(state, admission);
      return json(response, 202, {
        accepted: true,
        deliveryId,
        outcome: "created",
        createdTaskIds: [root.id]
      });
    }
    return json(response, 404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run({ apiUrl: `http://127.0.0.1:${address.port}`, state });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function webhookAdmission(payload, event, deliveryId) {
  const repository = String(payload.repository.full_name).toLowerCase();
  if (event === "push") {
    const ref = String(payload.ref).slice("refs/heads/".length);
    const commitSha = String(payload.after).toLowerCase();
    return {
      repository,
      ref,
      commitSha,
      trigger: "push",
      requestKey: `github:push:${repository}:${ref}:${commitSha}:${deliveryId}`
    };
  }
  if (event === "pull_request") {
    const number = Number(payload.number);
    const commitSha = String(payload.pull_request.head.sha).toLowerCase();
    return {
      repository,
      ref: `pull/${number}/head`,
      commitSha,
      trigger: "pull_request",
      requestKey: `github:pull:${repository}:${number}:${commitSha}:${deliveryId}`
    };
  }
  const issueNumber = Number(payload.issue.number);
  return {
    repository,
    ref: String(payload.repository.default_branch),
    trigger: "issue",
    requestKey: `github:issue:${repository}:${issueNumber}`
  };
}

function createRoot(state, input) {
  const frontier = state.roots
    .filter((root) => root.metadata.repository === input.repository && root.metadata.ref === input.ref)
    .reduce((maximum, root) => Math.max(maximum, Number(root.metadata.refSequence)), 0);
  const root = fakeRoot(`task_created_${state.nextRoot}`, input.ref, frontier + 1, input.commitSha, input.trigger);
  state.nextRoot += 1;
  state.roots.push(root);
  state.requestBuilds.set(input.requestKey, root);
  return root;
}

function fakeRoot(id, ref, refSequence, commitSha, trigger) {
  return {
    id,
    type: "build-context",
    title: `Build ${ref}`,
    status: "triage",
    metadata: {
      tenantId: TENANT,
      repository: REPOSITORY,
      ref,
      refSequence,
      ...(commitSha ? { commitSha } : {}),
      trigger
    }
  };
}

function publicBuild(root) {
  return {
    id: root.id,
    status: root.status,
    ...root.metadata
  };
}

function isAuthorized(request) {
  return (
    request.headers.authorization === `Bearer ${INTERNAL_TOKEN}` &&
    request.headers["x-jina-tenant-id"] === TENANT &&
    request.headers["x-jina-principal-id"] === PRINCIPAL
  );
}

async function readText(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}

async function readJson(request) {
  const body = await readText(request);
  return body ? JSON.parse(body) : {};
}

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

function runProcess(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}
