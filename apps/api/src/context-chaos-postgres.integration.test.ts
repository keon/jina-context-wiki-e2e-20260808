import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { applyCommand, createEmptyBoardState, reduceBoard, type BoardState, type TaskId } from "@jina/board";
import {
  CONTEXT_WORKFLOW_CONTRACT,
  CONTEXT_WORKFLOW_SCHEMA_REVISION,
  contextWorkflowBoardTaskTypes,
  contextWorkflowBoardTopics,
  type ContextArtifactRef
} from "@jina/context-engine";
import {
  ContextDatabase,
  GcsContextArtifactStore,
  PostgresContextEngineStore,
  PostgresContextQuotaStore,
  PostgresJsonStateStore
} from "@jina/db";
import { entityId } from "@jina/shared-kernel";
import { ContextQuotaService } from "./context-quotas.js";
import { createApiServer, type ApiSnapshot, type ApiStateStore } from "./server.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const TENANT = "tenant-context-chaos";
const REPOSITORY = "omxyz/jina";
const INTERNAL_TOKEN = "context-chaos-internal";
const NOW = "2026-07-30T12:00:00.000Z";

interface Claim {
  readonly message: {
    readonly id: string;
    readonly leaseId: string;
    readonly attempt: number;
    readonly writeFenceToken: string;
  };
  readonly task: { readonly id: string };
}

interface FakeObject {
  content: Buffer;
  metadata: {
    generation: string;
    size: string;
    contentType: string;
    customTime?: string;
    metadata: Record<string, string>;
  };
}

class FakeGcsStorage {
  readonly objects = new Map<string, FakeObject>();
  lastSaveOptions?: {
    readonly resumable: boolean;
    readonly validation: string;
    readonly preconditionOpts: { readonly ifGenerationMatch: number };
  };
  #generation = 0;

  bucket() {
    return {
      file: (key: string, options?: { readonly generation?: string }) => ({
        save: async (
          content: Buffer,
          saveOptions: {
            readonly resumable: boolean;
            readonly validation: string;
            readonly preconditionOpts: { readonly ifGenerationMatch: number };
            readonly metadata: {
              readonly contentType: string;
              readonly customTime?: string;
              readonly metadata: Readonly<Record<string, string>>;
            };
          }
        ) => {
          this.lastSaveOptions = {
            resumable: saveOptions.resumable,
            validation: saveOptions.validation,
            preconditionOpts: { ...saveOptions.preconditionOpts }
          };
          if (this.objects.has(key)) throw Object.assign(new Error("precondition"), { code: 412 });
          this.#generation += 1;
          this.objects.set(key, {
            content: Buffer.from(content),
            metadata: {
              generation: String(this.#generation),
              size: String(content.byteLength),
              contentType: saveOptions.metadata.contentType,
              ...(saveOptions.metadata.customTime ? { customTime: saveOptions.metadata.customTime } : {}),
              metadata: { ...saveOptions.metadata.metadata }
            }
          });
        },
        getMetadata: async () => {
          const object = this.object(key, options?.generation);
          return [{ ...object.metadata, metadata: { ...object.metadata.metadata } }];
        },
        download: async () => [Buffer.from(this.object(key, options?.generation).content)]
      })
    };
  }

  private object(key: string, generation?: string): FakeObject {
    const object = this.objects.get(key);
    if (!object || (generation && generation !== object.metadata.generation)) {
      throw Object.assign(new Error("not found"), { code: 404 });
    }
    return object;
  }
}

class FailAfterCommitStateStore implements ApiStateStore {
  #armed = false;

  constructor(private readonly delegate: PostgresJsonStateStore<ApiSnapshot>) {}

  arm(): void {
    this.#armed = true;
  }

  load(): Promise<ApiSnapshot | undefined> {
    return this.delegate.load();
  }

  loadNewer(sinceVersion: number) {
    return this.delegate.loadNewer(sinceVersion);
  }

  ping(): Promise<void> {
    return this.delegate.ping();
  }

  hasDelivery(deliveryId: string): Promise<boolean> {
    return this.delegate.hasDelivery(deliveryId);
  }

  save(snapshot: ApiSnapshot, deliveryId?: string): Promise<boolean> {
    return this.delegate.save(snapshot, deliveryId);
  }

  async update<T>(
    operation: (snapshot: ApiSnapshot | undefined) => Promise<{ readonly state: ApiSnapshot; readonly result: T }>,
    deliveryId?: string
  ): Promise<{ readonly committed: boolean; readonly result?: T }> {
    const committed = await this.delegate.update(operation, deliveryId);
    if (this.#armed && committed.committed) {
      this.#armed = false;
      throw new Error("injected response loss after committed API state transaction");
    }
    return committed;
  }

  close(): Promise<void> {
    return this.delegate.close();
  }
}

test(
  "PostgreSQL token revocation during tenant-scoped retrieval is rejected before response",
  { skip: !databaseUrl },
  async () => {
    const database = contextDatabase(true);
    await database.pool.query("drop schema if exists jina_runtime cascade");
    await database.pool.query("drop schema if exists jina_context cascade");
    await database.initialize();
    const contextStore = new PostgresContextEngineStore(database);
    const secret = `jina_atk_${"p".repeat(43)}`;
    const tokenId = "atk_postgres_revalidation";
    await contextStore.mintApiToken({
      id: tokenId,
      tenantId: TENANT,
      principalId: `tenant:${TENANT}`,
      name: "Postgres in-flight revalidation",
      secretHash: createHash("sha256").update(secret, "utf8").digest("hex"),
      scopes: ["context:read"],
      createdAt: NOW,
      createdBy: "context-chaos-acceptance",
      expiresAt: "2099-01-01T00:00:00.000Z"
    });

    let retrievalStarted!: () => void;
    let allowRetrieval!: () => void;
    const started = new Promise<void>((resolve) => {
      retrievalStarted = resolve;
    });
    const allowed = new Promise<void>((resolve) => {
      allowRetrieval = resolve;
    });
    let blockRetrieval = false;
    const originalListGenerations = contextStore.listGenerations.bind(contextStore);
    contextStore.listGenerations = async (...args) => {
      if (!blockRetrieval) return originalListGenerations(...args);
      retrievalStarted();
      await allowed;
      return originalListGenerations(...args);
    };

    const server = createApiServer({
      tenantId: TENANT,
      enableDevEndpoints: false,
      contextStore
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const admitted = await fetch(
        `${serverUrl(server)}/context/releases?repository=${encodeURIComponent(REPOSITORY)}`,
        { headers: { authorization: `Bearer ${secret}` } }
      );
      assert.equal(admitted.status, 200, await admitted.text());

      blockRetrieval = true;
      const inFlight = fetch(`${serverUrl(server)}/context/releases?repository=${encodeURIComponent(REPOSITORY)}`, {
        headers: { authorization: `Bearer ${secret}` }
      });
      await started;
      const revoked = await contextStore.revokeApiToken(
        TENANT,
        tokenId,
        "context-chaos-acceptance",
        "2026-07-30T12:00:01.000Z"
      );
      assert.equal(revoked?.id, tokenId);
      allowRetrieval();
      const response = await inFlight;
      assert.equal(response.status, 401);
      assert.equal(((await response.json()) as { code: string }).code, "unauthorized");
    } finally {
      allowRetrieval();
      await closeServer(server);
    }
  }
);

test(
  "a worker crash before artifact upload preserves PostgreSQL state and a reclaimed lease clears durable model quota",
  { skip: !databaseUrl },
  async () => {
    const resources = await resetDatabase();
    let stateStore = resources.stateStore;
    let database = resources.database;
    let server: Server | undefined;
    try {
      await stateStore.save(
        snapshotFor(contextWorkflowBoardTaskTypes.planner, contextWorkflowBoardTopics.planner, "before")
      );
      let quota = new ContextQuotaService({ store: new PostgresContextQuotaStore(database) });
      ({ server } = await startServer(stateStore, quota, undefined, 50));
      const first = await claim(server, contextWorkflowBoardTopics.planner, "worker-before-crash");
      assert.equal((await quota.snapshot(TENANT)).active.modelTasks, 1);

      await closeServer(server);
      server = undefined;
      await database.close();
      await delay(100);

      stateStore = postgresStateStore();
      database = contextDatabase(false);
      quota = new ContextQuotaService({ store: new PostgresContextQuotaStore(database) });
      ({ server } = await startServer(stateStore, quota, undefined, 1_000));
      const reclaimed = await claim(server, contextWorkflowBoardTopics.planner, "worker-after-restart");
      assert.equal(reclaimed.message.id, first.message.id);
      assert.notEqual(reclaimed.message.leaseId, first.message.leaseId);
      assert.equal((await quota.snapshot(TENANT)).active.modelTasks, 1);

      const stale = await release(server, first, "stale crashed worker");
      assert.equal(stale.status, 409);
      const released = await release(server, reclaimed, "replacement worker recovered checkpoint");
      assert.equal(released.status, 200, await released.text());
      assert.equal((await quota.snapshot(TENANT)).active.modelTasks, 0);
    } finally {
      if (server) await closeServer(server);
      await stateStore.close().catch(() => undefined);
      await database.close().catch(() => undefined);
    }
  }
);

test(
  "a worker crash after API-to-GCS upload resumes from PostgreSQL with immutable artifact and stale-fence safety",
  { skip: !databaseUrl },
  async () => {
    const resources = await resetDatabase();
    let stateStore = resources.stateStore;
    let database = resources.database;
    const fakeGcs = new FakeGcsStorage();
    const artifacts = new GcsContextArtifactStore("context-chaos-artifacts", {
      storage: fakeGcs as never
    });
    let server: Server | undefined;
    try {
      await stateStore.save(
        snapshotFor(contextWorkflowBoardTaskTypes.snapshot, contextWorkflowBoardTopics.snapshot, "after")
      );
      let quota = new ContextQuotaService({ store: new PostgresContextQuotaStore(database) });
      ({ server } = await startServer(stateStore, quota, artifacts, 50));
      const first = await claim(server, contextWorkflowBoardTopics.snapshot, "worker-upload-crash");
      const content = Buffer.from('{"version":1,"snapshot":"durable"}');
      const uploaded = await upload(server, first, "snapshot.json", content);
      assert.match(uploaded.uri, /^gs:\/\/context-chaos-artifacts\//);
      assert.equal(fakeGcs.objects.size, 1);
      assert.deepEqual(fakeGcs.lastSaveOptions, {
        resumable: false,
        validation: "crc32c",
        preconditionOpts: { ifGenerationMatch: 0 }
      });

      await closeServer(server);
      server = undefined;
      await database.close();
      await delay(100);

      stateStore = postgresStateStore();
      database = contextDatabase(false);
      quota = new ContextQuotaService({ store: new PostgresContextQuotaStore(database) });
      ({ server } = await startServer(stateStore, quota, artifacts, 1_000));
      const reclaimed = await claim(server, contextWorkflowBoardTopics.snapshot, "worker-upload-recovery");
      assert.equal(reclaimed.message.id, first.message.id);
      assert.notEqual(reclaimed.message.writeFenceToken, first.message.writeFenceToken);

      const replay = await upload(server, reclaimed, "snapshot.json", content);
      assert.deepEqual(replay, uploaded);
      assert.equal(fakeGcs.objects.size, 1);
      const collision = await uploadResponse(server, reclaimed, "snapshot.json", Buffer.from('{"changed":true}'));
      assert.notEqual(collision.status, 201);
      assert.equal(fakeGcs.objects.size, 1);

      const stale = await release(server, first, "stale crash completion");
      assert.equal(stale.status, 409);
      const released = await release(server, reclaimed, "artifact recovered after restart");
      assert.equal(released.status, 200, await released.text());
      const accounting = await quota.snapshot(TENANT);
      assert.equal(accounting.storage.artifactCount, 1);
      assert.equal(accounting.storage.committedBytes, content.byteLength);
      assert.equal(accounting.storage.reservedBytes, 0);
    } finally {
      if (server) await closeServer(server);
      await stateStore.close().catch(() => undefined);
      await database.close().catch(() => undefined);
    }
  }
);

test(
  "API restart after the graph-expansion commit replays exactly once with one durable receipt",
  { skip: !databaseUrl },
  async () => {
    const resources = await resetDatabase();
    let database = resources.database;
    const faultStore = new FailAfterCommitStateStore(resources.stateStore);
    let stateStore: ApiStateStore = faultStore;
    const fakeGcs = new FakeGcsStorage();
    const artifacts = new GcsContextArtifactStore("context-chaos-artifacts", {
      storage: fakeGcs as never
    });
    let server: Server | undefined;
    try {
      await stateStore.save(
        snapshotFor(contextWorkflowBoardTaskTypes.snapshot, contextWorkflowBoardTopics.snapshot, "expansion")
      );
      let quota = new ContextQuotaService({ store: new PostgresContextQuotaStore(database) });
      ({ server } = await startServer(stateStore, quota, artifacts, 500));
      const claimed = await claim(server, contextWorkflowBoardTopics.snapshot, "graph-expansion-worker");
      const outputArtifact = await upload(
        server,
        claimed,
        "snapshot.json",
        Buffer.from('{"version":1,"snapshot":"graph"}')
      );
      const completion = {
        ...leaseBody(claimed),
        outcome: "done",
        result: {
          contract: CONTEXT_WORKFLOW_CONTRACT,
          schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
          outputArtifact,
          commitSha: "a".repeat(40)
        }
      };

      faultStore.arm();
      const lost = await workerRequest(server, "/internal/worker/complete", completion);
      assert.equal(lost.status, 500);
      await closeServer(server);
      server = undefined;
      await database.close();

      stateStore = postgresStateStore();
      database = contextDatabase(false);
      quota = new ContextQuotaService({ store: new PostgresContextQuotaStore(database) });
      ({ server } = await startServer(stateStore, quota, artifacts, 500));
      const replay = await workerRequest(server, "/internal/worker/complete", completion);
      assert.equal(replay.status, 200, await replay.text());

      const persisted = await stateStore.load();
      assert.ok(persisted);
      const board = persisted.intakeState.board;
      const researchPlans = board.tasks.filter((task) => task.type === contextWorkflowBoardTaskTypes.planner);
      assert.equal(researchPlans.length, 1);
      assert.equal(
        board.events.filter(
          (event) => event.taskId === claimed.task.id && event.type === "task.worker_completion_recorded"
        ).length,
        1
      );
      assert.equal(board.outbox.filter((message) => message.taskId === researchPlans[0]!.id).length, 1);
      const accounting = await quota.snapshot(TENANT);
      assert.equal(accounting.storage.artifactCount, 1);
      assert.equal(accounting.storage.reservedBytes, 0);
    } finally {
      if (server) await closeServer(server);
      await stateStore.close().catch(() => undefined);
      await database.close().catch(() => undefined);
    }
  }
);

async function resetDatabase(): Promise<{
  database: ContextDatabase;
  stateStore: PostgresJsonStateStore<ApiSnapshot>;
}> {
  const database = contextDatabase(true);
  await database.pool.query("drop schema if exists jina_runtime cascade");
  await database.pool.query("drop schema if exists jina_context cascade");
  await database.initialize();
  const stateStore = postgresStateStore();
  await stateStore.ping();
  return { database, stateStore };
}

function contextDatabase(manageSchema: boolean): ContextDatabase {
  return new ContextDatabase({
    connectionString: databaseUrl!,
    manageSchema,
    manageRoles: manageSchema,
    max: 6
  });
}

function postgresStateStore(): PostgresJsonStateStore<ApiSnapshot> {
  return new PostgresJsonStateStore<ApiSnapshot>({
    connectionString: databaseUrl!,
    manageSchema: true,
    max: 4,
    applicationName: "context-chaos-acceptance"
  });
}

async function startServer(
  stateStore: ApiStateStore,
  quota: ContextQuotaService,
  artifacts: GcsContextArtifactStore | undefined,
  contextWorkerLeaseMs: number
): Promise<{ server: Server; baseUrl: string }> {
  const server = createApiServer({
    tenantId: TENANT,
    enableDevEndpoints: false,
    internalApiToken: INTERNAL_TOKEN,
    stateStore,
    contextQuotaService: quota,
    ...(artifacts ? { contextArtifactStore: artifacts } : {}),
    contextWorkerLeaseMs
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, baseUrl: serverUrl(server) };
}

function snapshotFor(type: string, topic: string, suffix: string): ApiSnapshot {
  const buildId = entityId<"task">(`task_chaos_${suffix}_build`);
  const taskId = entityId<"task">(`task_chaos_${suffix}_work`);
  let board = createEmptyBoardState();
  board = addTask(board, {
    id: buildId,
    type: contextWorkflowBoardTaskTypes.build,
    kind: "aggregate",
    title: "Context chaos build",
    assigneeRole: "system",
    dedupeKey: `context-chaos:${suffix}:build`,
    metadata: {
      tenantId: TENANT,
      repository: REPOSITORY,
      ref: "main",
      refSequence: 1,
      commitSha: "a".repeat(40),
      requestKey: `context-chaos:${suffix}`,
      contextWorkflowContract: CONTEXT_WORKFLOW_CONTRACT,
      contextWorkflowSchemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
      promptContractVersion: "context-page-workflow-1",
      validatorVersion: "context-page-validator-1",
      pageIndexVersion: "pageindex-local-1",
      executionProfileDigest: "c".repeat(64),
      contextBuildId: buildId
    }
  });
  board = addTask(board, {
    id: taskId,
    type,
    kind: "dispatchable",
    title: "Context chaos work",
    assigneeRole: "context-agent",
    dedupeKey: `context-chaos:${suffix}:work`,
    dispatchTopic: topic,
    parentTaskId: buildId,
    metadata: {
      tenantId: TENANT,
      repository: REPOSITORY,
      ref: "main",
      refSequence: 1,
      commitSha: "a".repeat(40),
      requestKey: `context-chaos:${suffix}`,
      contextBuildId: buildId,
      contextWorkflowContract: CONTEXT_WORKFLOW_CONTRACT,
      contextWorkflowSchemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
      promptContractVersion: "context-page-workflow-1",
      validatorVersion: "context-page-validator-1",
      pageIndexVersion: "pageindex-local-1",
      executionProfileDigest: "c".repeat(64)
    }
  });
  return {
    intakeState: { board: reduceBoard(board, NOW), pullRequests: [] },
    devDeliverySequence: 0
  };
}

function addTask(
  board: BoardState,
  task: {
    readonly id: TaskId;
    readonly type: string;
    readonly kind: "aggregate" | "dispatchable";
    readonly title: string;
    readonly assigneeRole: string;
    readonly dedupeKey: string;
    readonly metadata: Record<string, unknown>;
    readonly dispatchTopic?: string;
    readonly parentTaskId?: TaskId;
  }
): BoardState {
  return applyCommand(
    board,
    {
      command: "CreateTask",
      ...(task.kind === "aggregate" ? { blocksParentCompletion: false } : {}),
      task
    },
    { actor: { type: "system", id: "context-chaos-acceptance" }, now: NOW }
  ).state;
}

async function claim(server: Server, topic: string, workerId: string): Promise<Claim> {
  const response = await workerRequest(server, "/internal/worker/claim", {
    workerId,
    topics: [topic]
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text) as Claim;
}

function release(server: Server, claim: Claim, reason: string): Promise<Response> {
  return workerRequest(server, "/internal/worker/release", {
    ...leaseBody(claim),
    reason
  });
}

async function upload(server: Server, claim: Claim, name: string, content: Buffer): Promise<ContextArtifactRef> {
  const response = await uploadResponse(server, claim, name, content);
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return (JSON.parse(text) as { artifact: ContextArtifactRef }).artifact;
}

function uploadResponse(server: Server, claim: Claim, name: string, content: Buffer): Promise<Response> {
  return workerRequest(server, "/internal/context/board/artifacts", {
    ...leaseBody(claim),
    kind: "evidence-snapshot",
    name,
    contentType: "application/json",
    contentBase64: content.toString("base64")
  });
}

function leaseBody(claim: Claim) {
  return {
    messageId: claim.message.id,
    taskId: claim.task.id,
    leaseId: claim.message.leaseId,
    attempt: claim.message.attempt,
    writeFenceToken: claim.message.writeFenceToken
  };
}

function workerRequest(server: Server, path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${serverUrl(server)}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${INTERNAL_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

function serverUrl(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
