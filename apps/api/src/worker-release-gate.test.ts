import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createEmptyBoardState } from "@jina/board";
import { createApiServer, type ApiSnapshot, type ApiStateStore, type WorkerReleaseGuard } from "./server.js";

const INTERNAL_TOKEN = "internal-worker-release-test";
const ACTIVE_RELEASE = {
  releaseId: "release-current",
  credentialSha256: sha256("current-credential-current-credential"),
  service: "jina-context-worker",
  revision: "jina-context-worker-release-current"
} as const;

test("production worker routes reject a stale release generation before mutating Board state", async () => {
  const store = guardedStateStore(ACTIVE_RELEASE);
  const { baseUrl, close } = await runningApi(store, true);
  const initialLoadCount = store.loadCount();
  try {
    for (const [path, body] of [
      ["/internal/worker/claim", { workerId: "stale", topics: ["run-context-input-snapshot"] }],
      [
        "/internal/worker/renew",
        { messageId: "message-1", leaseId: "lease-1", attempt: 1, writeFenceToken: "fence-1" }
      ],
      [
        "/internal/worker/release",
        {
          messageId: "message-1",
          taskId: "task-1",
          leaseId: "lease-1",
          attempt: 1,
          writeFenceToken: "fence-1"
        }
      ],
      [
        "/internal/worker/complete",
        {
          messageId: "message-1",
          taskId: "task-1",
          leaseId: "lease-1",
          attempt: 1,
          writeFenceToken: "fence-1",
          outcome: "failed"
        }
      ]
    ] as const) {
      const response = await workerPost(baseUrl, path, {
        ...body,
        workerReleaseId: "release-stale",
        workerReleaseCredential: "stale-credential-stale-credential",
        workerService: "jina-context-worker",
        workerRevision: "jina-context-worker-release-stale"
      });
      assert.equal(response.status, 409, path);
      assert.equal((await response.json()).code, "worker_release_rejected", path);
    }
    assert.equal(store.mutationCount(), 0);
    assert.equal(store.loadCount(), initialLoadCount);
  } finally {
    await close();
  }
});

test("exact active release reaches the Board transaction and topic/service identity is enforced", async () => {
  const store = guardedStateStore(ACTIVE_RELEASE);
  const { baseUrl, close } = await runningApi(store, true);
  try {
    const accepted = await workerPost(baseUrl, "/internal/worker/claim", {
      workerId: "candidate",
      topics: ["run-context-input-snapshot"],
      ...requestIdentity("current-credential-current-credential")
    });
    assert.equal(accepted.status, 204);
    assert.equal(store.mutationCount(), 0);
    assert.equal(store.verificationCount(), 1);
    assert.equal(store.lastVerification()?.requireClaimAdmission, true);

    const wrongService = await workerPost(baseUrl, "/internal/worker/claim", {
      workerId: "candidate",
      topics: ["run-review"],
      ...requestIdentity("current-credential-current-credential")
    });
    assert.equal(wrongService.status, 409);
    assert.equal((await wrongService.json()).code, "worker_release_rejected");
    assert.equal(store.mutationCount(), 0);
  } finally {
    await close();
  }
});

test("causal graph claims require the causal worker identity and reject Context topics", async () => {
  const activeCausalRelease = {
    releaseId: "causal-release-current",
    credentialSha256: sha256("causal-credential-causal-credential"),
    service: "jina-causal-graph-worker",
    revision: "jina-causal-graph-worker-release-current"
  } as const;
  const store = guardedStateStore(activeCausalRelease);
  const { baseUrl, close } = await runningApi(store, true);
  const identity = {
    workerReleaseId: activeCausalRelease.releaseId,
    workerReleaseCredential: "causal-credential-causal-credential",
    workerService: activeCausalRelease.service,
    workerRevision: activeCausalRelease.revision
  };
  try {
    const accepted = await workerPost(baseUrl, "/internal/worker/claim", {
      workerId: "causal-candidate",
      topics: ["run-causal-graph-history", "run-causal-graph-derive", "run-causal-graph-publication"],
      ...identity
    });
    assert.equal(accepted.status, 204);
    assert.equal(store.verificationCount(), 1);

    const contextTopic = await workerPost(baseUrl, "/internal/worker/claim", {
      workerId: "causal-candidate",
      topics: ["run-context-input-snapshot"],
      ...identity
    });
    assert.equal(contextTopic.status, 409);
    assert.equal((await contextTopic.json()).code, "worker_release_rejected");
  } finally {
    await close();
  }
});

test("local development remains explicitly ungated when the release gate is disabled", async () => {
  const store = guardedStateStore(undefined);
  const { baseUrl, close } = await runningApi(store, false);
  try {
    const response = await workerPost(baseUrl, "/internal/worker/claim", {
      workerId: "local-worker",
      topics: ["run-context-input-snapshot"]
    });
    assert.equal(response.status, 204);
    assert.equal(store.mutationCount(), 0);
  } finally {
    await close();
  }
});

function requestIdentity(credential: string): Record<string, string> {
  return {
    workerReleaseId: ACTIVE_RELEASE.releaseId,
    workerReleaseCredential: credential,
    workerService: ACTIVE_RELEASE.service,
    workerRevision: ACTIVE_RELEASE.revision
  };
}

function guardedStateStore(active: WorkerReleaseGuard | undefined): ApiStateStore & {
  loadCount(): number;
  mutationCount(): number;
  verificationCount(): number;
  lastVerification(): WorkerReleaseGuard | undefined;
} {
  let snapshot: ApiSnapshot = {
    intakeState: { board: createEmptyBoardState() },
    devDeliverySequence: 0
  };
  let loads = 0;
  let mutations = 0;
  let verifications = 0;
  let lastVerification: WorkerReleaseGuard | undefined;
  const assertWorkerRelease = (guard: WorkerReleaseGuard): void => {
    verifications += 1;
    lastVerification = guard;
    if (
      !active ||
      guard.releaseId !== active.releaseId ||
      guard.credentialSha256 !== active.credentialSha256 ||
      guard.service !== active.service ||
      guard.revision !== active.revision
    ) {
      const error = new Error("worker release identity is not active");
      error.name = "WorkerReleaseRejectedError";
      throw error;
    }
  };
  return {
    async load() {
      loads += 1;
      return snapshot;
    },
    async ping() {},
    async hasDelivery() {
      return false;
    },
    async save(next) {
      snapshot = next;
      return true;
    },
    async verifyWorkerRelease(guard) {
      assertWorkerRelease(guard);
    },
    async update<T>(
      operation: (current: ApiSnapshot | undefined) => Promise<{ readonly state: ApiSnapshot; readonly result: T }>,
      _deliveryId?: string,
      guard?: WorkerReleaseGuard
    ) {
      if (guard) assertWorkerRelease(guard);
      mutations += 1;
      const result = await operation(snapshot);
      snapshot = result.state;
      return { committed: true, result: result.result };
    },
    async close() {},
    loadCount() {
      return loads;
    },
    mutationCount() {
      return mutations;
    },
    verificationCount() {
      return verifications;
    },
    lastVerification() {
      return lastVerification;
    }
  };
}

async function runningApi(
  stateStore: ApiStateStore,
  requireWorkerReleaseGate: boolean
): Promise<{ readonly baseUrl: string; readonly close: () => Promise<void> }> {
  const server = createApiServer({
    tenantId: "tenant-release-test",
    internalApiToken: INTERNAL_TOKEN,
    stateStore,
    requireWorkerReleaseGate
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    }
  };
}

function workerPost(baseUrl: string, path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${INTERNAL_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
