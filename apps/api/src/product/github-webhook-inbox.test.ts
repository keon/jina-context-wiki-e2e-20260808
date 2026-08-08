import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";

import type { GithubWebhookInboxConfig } from "./config.js";
import { ApiError } from "./errors.js";
import { GithubWebhookInboxService } from "./github-webhook-inbox.js";
import type {
  GithubWebhookInboxCapture,
  GithubWebhookInboxCaptureResult,
  GithubWebhookInboxLease,
  GithubWebhookInboxRepository,
  GithubWebhookInboxSnapshot,
} from "./github-webhook-inbox-store.js";

test("capture verifies the signature and stores encrypted exact delivery bytes", async () => {
  const repository = new FakeInboxRepository();
  const service = inboxService(repository);
  const rawBody = Buffer.from(JSON.stringify(payload({ body: "private instruction" })));

  const captured = await service.capture(signedHeaders(rawBody), rawBody);

  assert.equal(captured.deliveryId, "delivery-1");
  assert.equal(captured.event, "issue_comment");
  assert.equal(captured.action, "created");
  assert.equal(repository.captured?.installationId, 456);
  assert.equal(repository.captured?.repositoryId, 123);
  assert.equal(repository.captured?.repositoryFullName, "omxyz/private-repo");
  assert.equal(repository.captured?.pullRequestNumber, 42);
  assert.equal(repository.captured?.encryptionKeyVersion, "7");
  assert.equal(repository.captured?.payloadCiphertext.includes(rawBody), false);
  assert.equal(repository.captured?.payloadCiphertext.includes(Buffer.from("private instruction")), false);
});

test("capture rejects invalid signatures and never calls the repository", async () => {
  const repository = new FakeInboxRepository();
  const rawBody = Buffer.from("{}");
  const headers = signedHeaders(rawBody);
  headers.set("x-hub-signature-256", "sha256=deadbeef");

  await assert.rejects(
    inboxService(repository).capture(headers, rawBody),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  assert.equal(repository.captured, undefined);
});

test("capture rejects non-UTF-8 JSON bytes before durable acknowledgement", async () => {
  const repository = new FakeInboxRepository();
  const rawBody = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);

  await assert.rejects(
    inboxService(repository).capture(signedHeaders(rawBody), rawBody),
    (error: unknown) => error instanceof ApiError && error.status === 400,
  );
  assert.equal(repository.captured, undefined);
});

test("processing decrypts, authenticates, and completes one workflow identity", async () => {
  const repository = new FakeInboxRepository();
  const service = inboxService(repository);
  const rawBody = Buffer.from(JSON.stringify(payload()));
  await service.capture(signedHeaders(rawBody), rawBody);

  const result = await service.processOne("delivery-1", async (input) => {
    assert.deepEqual(input.rawBody, rawBody);
    assert.equal(input.headers.get("x-github-delivery"), "delivery-1");
    assert.equal(input.headers.get("x-github-event"), "issue_comment");
    assert.equal(
      input.headers.get("x-hub-signature-256"),
      signature(rawBody),
    );
    return {
      accepted: true,
      event: "issue_comment",
      workflow_id: "workflow-1",
    };
  });

  assert.equal(result.disposition, "completed");
  assert.deepEqual(repository.completed, ["workflow-1"]);
  assert.equal(repository.retried.length, 0);
});

test("a handler failure leaves the captured delivery retryable without logging its body", async () => {
  const repository = new FakeInboxRepository();
  const service = inboxService(repository);
  const rawBody = Buffer.from(JSON.stringify(payload({ body: "do not log me" })));
  await service.capture(signedHeaders(rawBody), rawBody);

  const result = await service.processOne("delivery-1", async () => {
    throw new Error("provider unavailable with private body do not log me");
  });

  assert.equal(result.disposition, "retry_wait");
  assert.equal(repository.completed.length, 0);
  assert.deepEqual(repository.retried, ["error"]);
});

test("a deterministic handler rejection dead-letters the delivery and unblocks its ordering key", async () => {
  const repository = new FakeInboxRepository();
  const service = inboxService(repository);
  const rawBody = Buffer.from(JSON.stringify(payload()));
  await service.capture(signedHeaders(rawBody), rawBody);

  const result = await service.processOne("delivery-1", async () => {
    throw new ApiError(422, "unsupported webhook shape");
  });

  assert.equal(result.disposition, "dead_letter");
  assert.deepEqual(repository.deadLettered, ["api_422"]);
  assert.deepEqual(repository.retried, []);
});

test("an AES-GCM failure remains retryable so a misbound deployment key can be rolled back", async () => {
  const repository = new FakeInboxRepository();
  const service = inboxService(repository);
  const rawBody = Buffer.from(JSON.stringify(payload()));
  await service.capture(signedHeaders(rawBody), rawBody);
  repository.captured = {
    ...repository.captured!,
    payloadCiphertext: Buffer.from("corrupted-ciphertext"),
  };

  const result = await service.processOne("delivery-1", async () => {
    throw new Error("must not process corrupt bytes");
  });

  assert.equal(result.disposition, "retry_wait");
  assert.deepEqual(repository.retried, ["webhook_inbox_ciphertext_invalid"]);
  assert.deepEqual(repository.deadLettered, []);
});

test("unknown processing failures are dead-lettered after a bounded number of attempts", async () => {
  const repository = new FakeInboxRepository();
  repository.attemptCount = 25;
  const service = inboxService(repository);
  const rawBody = Buffer.from(JSON.stringify(payload()));
  await service.capture(signedHeaders(rawBody), rawBody);

  const result = await service.processOne("delivery-1", async () => {
    throw new Error("still unavailable");
  });

  assert.equal(result.disposition, "dead_letter");
  assert.deepEqual(repository.deadLettered, ["error"]);
});

function inboxService(repository: FakeInboxRepository): GithubWebhookInboxService {
  return new GithubWebhookInboxService(
    { githubWebhookSecret: "test-secret" },
    inboxConfig(),
    repository,
  );
}

function inboxConfig(): GithubWebhookInboxConfig {
  return {
    encryptionKey: Buffer.alloc(32, 7),
    encryptionKeyVersion: "7",
    leaseMs: 120_000,
    maxBodyBytes: 1024 * 1024,
  };
}

function payload(overrides: { body?: string } = {}) {
  return {
    action: "created",
    installation: { id: 456 },
    repository: { id: 123, full_name: "omxyz/private-repo" },
    issue: { number: 42, pull_request: { url: "https://api.github.test/pulls/42" } },
    comment: { id: 99, body: overrides.body ?? "@usejina" },
  };
}

function signedHeaders(rawBody: Buffer): Headers {
  return new Headers({
    "x-github-delivery": "delivery-1",
    "x-github-event": "issue_comment",
    "x-hub-signature-256": signature(rawBody),
  });
}

function signature(rawBody: Buffer): string {
  return `sha256=${createHmac("sha256", "test-secret").update(rawBody).digest("hex")}`;
}

class FakeInboxRepository implements GithubWebhookInboxRepository {
  captured?: GithubWebhookInboxCapture;
  completed: (string | undefined)[] = [];
  retried: string[] = [];
  deadLettered: string[] = [];
  attemptCount = 1;

  async capture(input: GithubWebhookInboxCapture): Promise<GithubWebhookInboxCaptureResult> {
    this.captured = input;
    return { inserted: true, status: "pending" };
  }

  async hasDelivery(deliveryId: string): Promise<boolean> {
    return this.captured?.deliveryId === deliveryId;
  }

  async reserveRedelivery(): Promise<boolean> {
    return true;
  }

  async recordRedeliveryResult(): Promise<void> {}

  async claim(_input: {
    deliveryId?: string;
    leaseMs: number;
  }): Promise<GithubWebhookInboxLease | undefined> {
    if (!this.captured) return undefined;
    return {
      leaseId: randomUUID(),
      deliveryId: this.captured.deliveryId,
      event: this.captured.event,
      ...(this.captured.action ? { action: this.captured.action } : {}),
      ...(this.captured.repositoryFullName
        ? { repositoryFullName: this.captured.repositoryFullName }
        : {}),
      payloadSha256: this.captured.payloadSha256,
      payloadCiphertext: this.captured.payloadCiphertext,
      encryptionKeyVersion: this.captured.encryptionKeyVersion,
      attemptCount: this.attemptCount,
    };
  }

  async complete(input: {
    lease: GithubWebhookInboxLease;
    processedWorkflowId?: string;
  }): Promise<void> {
    this.completed.push(input.processedWorkflowId);
    this.captured = undefined;
  }

  async retry(input: {
    lease: GithubWebhookInboxLease;
    errorCode: string;
    retryAfterMs: number;
  }): Promise<void> {
    this.retried.push(input.errorCode);
  }

  async deadLetter(input: {
    lease: GithubWebhookInboxLease;
    errorCode: string;
  }): Promise<void> {
    this.deadLettered.push(input.errorCode);
    this.captured = undefined;
  }

  async snapshot(): Promise<GithubWebhookInboxSnapshot> {
    return {
      pending: this.captured ? 1 : 0,
      leased: 0,
      retryWait: 0,
      completed: this.completed.length,
      deadLetter: 0,
      deadLetterByErrorCode: {},
      recentDeadLetters: [],
      activeKeyVersions: this.captured ? { [this.captured.encryptionKeyVersion]: 1 } : {},
      deadLetterKeyVersions: {},
    };
  }
}
