import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApiServer, type ApiSnapshot, type ApiStateStore } from "./server.js";

const SECRET = "test-webhook-secret";

test("signed GitHub App deliveries create idempotent PR and issue tasks", async (context) => {
  const server = createApiServer({ githubWebhookSecret: SECRET });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const issuePayload = issueOpenedPayload();

  const rejected = await deliver(baseUrl, "issues", "delivery-bad", issuePayload, "wrong-secret");
  assert.equal(rejected.status, 401);

  const issue = await deliver(baseUrl, "issues", "delivery-issue-1", issuePayload);
  assert.equal(issue.status, 202);
  assert.equal((await issue.json() as { outcome: string }).outcome, "created");

  const repeatedDelivery = await deliver(baseUrl, "issues", "delivery-issue-1", issuePayload);
  assert.equal(repeatedDelivery.status, 200);
  assert.equal((await repeatedDelivery.json() as { duplicate: boolean }).duplicate, true);

  const sameIssueNewDelivery = await deliver(baseUrl, "issues", "delivery-issue-redelivery", issuePayload);
  assert.equal((await sameIssueNewDelivery.json() as { outcome: string }).outcome, "duplicate");

  const pullRequest = await deliver(baseUrl, "pull_request", "delivery-pr-1", pullRequestPayload(42, "abc123"));
  assert.equal(pullRequest.status, 202);
  assert.equal((await pullRequest.json() as { createdTaskIds: string[] }).createdTaskIds.length, 3);

  await deliver(baseUrl, "pull_request", "delivery-pr-2", pullRequestPayload(43, "other123"));
  await deliver(baseUrl, "pull_request", "delivery-pr-1-sync", pullRequestPayload(42, "def456", "synchronize"));

  const boardResponse = await fetch(`${baseUrl}/board`);
  const board = await boardResponse.json() as {
    tasks: Array<{ type: string; status: string; metadata: Record<string, unknown> }>;
    outbox: Array<{ topic: string }>;
  };

  assert.equal(board.tasks.filter((task) => task.type === "issue_triage").length, 1);
  assert.equal(board.tasks.find((task) => task.type === "issue_triage")?.status, "triage");
  assert.equal(board.tasks.filter((task) => task.type === "pr_review").length, 3);
  assert.equal(
    board.tasks
      .filter((task) => task.metadata.pullRequestNumber === 43)
      .some((task) => task.status === "superseded"),
    false,
    "synchronizing one PR must not supersede another PR's tasks"
  );
  assert.equal(
    board.tasks.find(
      (task) => task.type === "review_pass" && task.metadata.pullRequestNumber === 42 && task.metadata.headSha === "def456"
    )?.status,
    "queued"
  );
  assert.equal(board.outbox.filter((message) => message.topic === "run-review").length, 3);
});

test("durable state survives an API server restart", async () => {
  const stateStore = new MemoryStateStore();
  const first = createApiServer({ githubWebhookSecret: SECRET, stateStore });
  const firstUrl = await listen(first);

  const created = await deliver(firstUrl, "issues", "delivery-persisted", issueOpenedPayload());
  assert.equal(created.status, 202);
  await close(first);

  const second = createApiServer({ githubWebhookSecret: SECRET, stateStore });
  const secondUrl = await listen(second);
  try {
    const board = await fetch(`${secondUrl}/board`).then(
      (response) => response.json() as Promise<{ tasks: Array<{ type: string }> }>
    );
    assert.equal(board.tasks.filter((task) => task.type === "issue_triage").length, 1);

    const duplicate = await deliver(secondUrl, "issues", "delivery-persisted", issueOpenedPayload());
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json() as { duplicate: boolean }).duplicate, true);

    const health = await fetch(`${secondUrl}/health`).then(
      (response) => response.json() as Promise<{ storage: string }>
    );
    assert.equal(health.storage, "postgres");
  } finally {
    await close(second);
  }
});

async function listen(server: ReturnType<typeof createApiServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createApiServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

class MemoryStateStore implements ApiStateStore {
  private snapshot?: ApiSnapshot;
  private readonly deliveries = new Set<string>();

  async load(): Promise<ApiSnapshot | undefined> {
    return this.snapshot;
  }

  async hasDelivery(deliveryId: string): Promise<boolean> {
    return this.deliveries.has(deliveryId);
  }

  async ping(): Promise<void> {}

  async save(snapshot: ApiSnapshot, deliveryId?: string): Promise<boolean> {
    if (deliveryId && this.deliveries.has(deliveryId)) {
      return false;
    }
    if (deliveryId) {
      this.deliveries.add(deliveryId);
    }
    this.snapshot = structuredClone(snapshot);
    return true;
  }

  async close(): Promise<void> {}
}

async function deliver(
  baseUrl: string,
  eventName: string,
  deliveryId: string,
  payload: unknown,
  secret = SECRET
): Promise<Response> {
  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return fetch(`${baseUrl}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": eventName,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature
    },
    body: rawBody
  });
}

function issueOpenedPayload(): unknown {
  return {
    action: "opened",
    issue: {
      number: 7,
      title: "Investigate flaky test",
      html_url: "https://github.com/omlabs/example/issues/7",
      user: { login: "octocat" }
    },
    repository: { id: 10, full_name: "omlabs/example" },
    installation: { id: 99 },
    sender: { login: "octocat" }
  };
}

function pullRequestPayload(number: number, headSha: string, action = "opened"): unknown {
  return {
    action,
    number,
    pull_request: {
      number,
      title: "Make it work",
      html_url: `https://github.com/omlabs/example/pull/${number}`,
      draft: false,
      user: { login: "octocat" },
      head: { sha: headSha }
    },
    repository: { id: 10, full_name: "omlabs/example" },
    installation: { id: 99 },
    sender: { login: "octocat" }
  };
}
