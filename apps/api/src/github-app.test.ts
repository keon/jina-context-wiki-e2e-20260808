import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createOntologyGraph, MemoryOntologyGraphStore } from "@jina/ontology";
import { createApiServer, type ApiSnapshot, type ApiStateStore } from "./server.js";

const SECRET = "test-webhook-secret";
const INTERNAL_TOKEN = "test-internal-token";
const TENANT = "github:installation:99";

test("signed GitHub App deliveries create idempotent PR and issue tasks", async (context) => {
  const server = createApiServer({ githubWebhookSecret: SECRET, internalApiToken: INTERNAL_TOKEN, tenantId: TENANT });
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

  assert.equal((await fetch(`${baseUrl}/board`)).status, 401);
  const boardResponse = await authenticatedFetch(`${baseUrl}/board`);
  const board = await boardResponse.json() as {
    tasks: Array<{ type: string; status: string; metadata: Record<string, unknown> }>;
    dependencies: Array<{
      taskId: string;
      dependsOnTaskId: string;
      relationship: string;
      required: boolean;
    }>;
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
  assert.equal(board.dependencies.length, 12);
  assert.equal(
    board.dependencies.some(
      (dependency) => dependency.relationship === "blocks" && dependency.required
    ),
    true
  );

  const taskTypes = await fetch(`${baseUrl}/task-types`).then(
    (response) => response.json() as Promise<Array<{ type: string; kind: string; description: string }>>
  );
  assert.equal(taskTypes.length, 8);
  assert.deepEqual(
    taskTypes.map((definition) => definition.type),
    ["pr_review", "review_pass", "context", "publish", "cleanup", "issue_triage", "human_decision", "ontology_build"]
  );
  assert.equal(taskTypes.every((definition) => definition.kind.length > 0 && definition.description.length > 0), true);
});

test("ontology worker builds and exposes a graph end to end", async () => {
  const server = createApiServer({
    enableDevEndpoints: true,
    tenantId: "default"
  });
  const baseUrl = await listen(server);
  try {
    const created = await fetch(`${baseUrl}/ontology/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: "omxyz/ontology-fixture", ref: "main", requestKey: "test" })
    });
    assert.equal(created.status, 202);
    const createdBody = await created.json() as { task: { id: string } };
    const claim = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: "fixture-worker", topics: ["run-ontology"] })
    });
    assert.equal(claim.status, 200);
    const work = await claim.json() as { message: { id: string; leaseId: string }; task: { id: string } };
    assert.equal(work.task.id, createdBody.task.id);

    const renewed = await fetch(`${baseUrl}/internal/worker/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: work.message.id, leaseId: work.message.leaseId })
    });
    assert.equal(renewed.status, 200);
    const staleRenewal = await fetch(`${baseUrl}/internal/worker/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: work.message.id, leaseId: "wrong-lease" })
    });
    assert.equal(staleRenewal.status, 409);

    const graph = fixtureGraph({ tenantId: "default", repository: "omxyz/ontology-fixture", ref: "main", taskId: work.task.id });
    const completed = await fetch(`${baseUrl}/internal/worker/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageId: work.message.id,
        leaseId: work.message.leaseId,
        taskId: work.task.id,
        outcome: "done",
        graph
      })
    });
    assert.equal(completed.status, 200);

    const ontology = await fetch(`${baseUrl}/ontology`).then(
      (response) => response.json() as Promise<{ latest: { nodes: unknown[]; edges: unknown[] } | null }>
    );
    assert.equal(ontology.latest?.nodes.length, 2);
    assert.equal(ontology.latest?.edges.length, 1);

    const board = await fetch(`${baseUrl}/board`).then(
      (response) => response.json() as Promise<{ tasks: Array<{ type: string; status: string }> }>
    );
    assert.equal(board.tasks.find((task) => task.type === "ontology_build")?.status, "done");
  } finally {
    await close(server);
  }
});

test("durable workers can drain review and publish topics", async () => {
  const server = createApiServer({ enableDevEndpoints: true, tenantId: "default" });
  const baseUrl = await listen(server);
  try {
    const intake = await fetch(`${baseUrl}/dev/webhooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: "omlabs/example", pullRequestNumber: 22, headSha: "sha-22" })
    });
    assert.equal(intake.status, 202);

    const review = await claimTopic(baseUrl, "run-review");
    assert.equal(review.message.topic, "run-review");
    assert.equal(await completeClaim(baseUrl, review, { summary: "Reviewed", findingCount: 0 }), 200);

    const publish = await claimTopic(baseUrl, "run-publish");
    assert.equal(publish.message.topic, "run-publish");
    assert.equal(await completeClaim(baseUrl, publish, { published: true }), 200);

    const board = await fetch(`${baseUrl}/board`).then(
      (response) => response.json() as Promise<{ tasks: Array<{ type: string; status: string }>; publications: unknown[] }>
    );
    assert.equal(board.tasks.find((task) => task.type === "review_pass")?.status, "done");
    assert.equal(board.tasks.find((task) => task.type === "publish")?.status, "done");
    assert.equal(board.tasks.find((task) => task.type === "pr_review")?.status, "done");
    assert.equal(board.publications.length, 1);
  } finally {
    await close(server);
  }
});

test("ontology reads require authentication and cannot cross tenant boundaries", async () => {
  const ontologyStore = new MemoryOntologyGraphStore();
  const tenantAGraph = fixtureGraph({ tenantId: "tenant-a", repository: "omxyz/a", ref: "main", taskId: "task-a" });
  const tenantBGraph = fixtureGraph({ tenantId: "tenant-b", repository: "omxyz/b", ref: "main", taskId: "task-b" });
  await ontologyStore.save(tenantAGraph);
  await ontologyStore.save(tenantBGraph);
  const server = createApiServer({ ontologyStore, internalApiToken: INTERNAL_TOKEN, tenantId: "tenant-a" });
  const baseUrl = await listen(server);
  try {
    assert.equal((await fetch(`${baseUrl}/ontology`)).status, 401);
    const list = await authenticatedFetch(`${baseUrl}/ontology`).then(
      (response) => response.json() as Promise<{ graphs: Array<{ id: string; tenantId: string }> }>
    );
    assert.deepEqual(list.graphs.map((graph) => graph.tenantId), ["tenant-a"]);
    assert.equal((await authenticatedFetch(`${baseUrl}/ontology/graphs/${tenantAGraph.id}`)).status, 200);
    assert.equal((await authenticatedFetch(`${baseUrl}/ontology/graphs/${tenantBGraph.id}`)).status, 404);
  } finally {
    await close(server);
  }
});

test("durable state survives an API server restart", async () => {
  const stateStore = new MemoryStateStore();
  const config = { githubWebhookSecret: SECRET, stateStore, internalApiToken: INTERNAL_TOKEN, tenantId: TENANT };
  const first = createApiServer(config);
  const firstUrl = await listen(first);

  const created = await deliver(firstUrl, "issues", "delivery-persisted", issueOpenedPayload());
  assert.equal(created.status, 202);
  await close(first);

  const second = createApiServer(config);
  const secondUrl = await listen(second);
  try {
    const board = await authenticatedFetch(`${secondUrl}/board`).then(
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

test("configured aliases migrate existing tasks and ontology graphs to the canonical tenant", async () => {
  const stateStore = new MemoryStateStore();
  const ontologyStore = new MemoryOntologyGraphStore();
  const oldTenant = "github:unscoped";
  const first = createApiServer({
    githubWebhookSecret: SECRET,
    stateStore,
    ontologyStore,
    internalApiToken: INTERNAL_TOKEN,
    tenantId: oldTenant
  });
  const firstUrl = await listen(first);
  assert.equal((await deliver(firstUrl, "pull_request", "delivery-old-tenant", pullRequestPayload(55, "old-sha"))).status, 202);
  await ontologyStore.save(fixtureGraph({ tenantId: oldTenant, repository: "omlabs/example", ref: "main", taskId: "old-task" }));
  await close(first);

  const second = createApiServer({
    githubWebhookSecret: SECRET,
    stateStore,
    ontologyStore,
    internalApiToken: INTERNAL_TOKEN,
    tenantId: "omlabs",
    tenantAliases: [oldTenant]
  });
  const secondUrl = await listen(second);
  try {
    const board = await authenticatedFetch(`${secondUrl}/board`).then(
      (response) => response.json() as Promise<{ tasks: Array<{ metadata: Record<string, unknown> }> }>
    );
    assert.equal(board.tasks.length, 3);
    assert.equal(board.tasks.every((task) => task.metadata.tenantId === "omlabs"), true);
    const ontology = await authenticatedFetch(`${secondUrl}/ontology`).then(
      (response) => response.json() as Promise<{ graphs: Array<{ tenantId: string }> }>
    );
    assert.deepEqual(ontology.graphs.map((graph) => graph.tenantId), ["omlabs"]);
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

interface TestClaim {
  readonly message: { readonly id: string; readonly leaseId: string; readonly topic: string };
  readonly task: { readonly id: string };
}

async function claimTopic(baseUrl: string, topic: string): Promise<TestClaim> {
  const response = await fetch(`${baseUrl}/internal/worker/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerId: `test-${topic}`, topics: [topic] })
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<TestClaim>;
}

async function completeClaim(baseUrl: string, work: TestClaim, result: Record<string, unknown>): Promise<number> {
  const response = await fetch(`${baseUrl}/internal/worker/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messageId: work.message.id,
      leaseId: work.message.leaseId,
      taskId: work.task.id,
      outcome: "done",
      result
    })
  });
  return response.status;
}

function fixtureGraph(request: { tenantId: string; repository: string; ref: string; taskId: string }) {
    return createOntologyGraph({
      request,
      commitSha: "fixture-sha",
      generatedAt: new Date().toISOString(),
      executor: "fixture",
      model: "fixture",
      generated: {
        summary: "Fixture repository",
        nodes: [
          { id: "repo", kind: "Repository", label: request.repository, description: "Repository", evidence: ["README.md:1"] },
          { id: "file:README.md", kind: "File", label: "README.md", description: "Documentation", path: "README.md", evidence: ["README.md:1"] }
        ],
        edges: [{ source: "repo", target: "file:README.md", predicate: "CONTAINS", plane: "code", evidence: ["README.md:1"] }]
      }
    });
}

function authenticatedFetch(url: string): Promise<Response> {
  return fetch(url, { headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } });
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
