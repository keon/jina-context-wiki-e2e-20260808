import assert from "node:assert/strict";
import { test } from "node:test";

import { GithubWebhookRedeliveryReconciler } from "./github-webhook-redelivery-reconciler.js";
import type {
  GithubWebhookInboxCapture,
  GithubWebhookInboxCaptureResult,
  GithubWebhookInboxLease,
  GithubWebhookInboxRepository,
  GithubWebhookInboxSnapshot,
} from "./github-webhook-inbox-store.js";

test("reconciler preserves over-safe-integer GitHub delivery IDs while redelivering", async () => {
  const repository = new ReconcileRepository();
  repository.captured.add("captured-guid");
  repository.cooldown.add("cooldown-guid");
  const requests: { url: string; init?: RequestInit }[] = [];
  const reconciler = new GithubWebhookRedeliveryReconciler(
    repository,
    async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes("?")) {
        return new Response(
          '[{"id":101,"guid":"captured-guid","status_code":503},' +
            '{"id":102,"guid":"cooldown-guid","status_code":500},' +
            '{"id":3835545665537048576,"guid":"missing-guid","status_code":404}]',
          { status: 200 },
        );
      }
      return new Response(null, { status: 202 });
    },
    () => "app-jwt",
  );

  assert.deepEqual(await reconciler.reconcile(25), {
    examined: 3,
    alreadyCaptured: 1,
    cooldownSkipped: 1,
    requested: 1,
  });
  assert.deepEqual(repository.recorded, [{
    deliveryId: "missing-guid",
    providerDeliveryId: "3835545665537048576",
    httpStatus: 202,
  }]);
  assert.equal(requests.length, 2);
  assert.equal(
    requests[0]?.url,
    "https://api.github.com/app/hook/deliveries?per_page=25&status=failure",
  );
  assert.equal(
    requests[1]?.url,
    "https://api.github.com/app/hook/deliveries/3835545665537048576/attempts",
  );
  assert.equal(requests[1]?.init?.method, "POST");
  assert.equal(new Headers(requests[1]?.init?.headers).get("authorization"), "Bearer app-jwt");
  assert.equal(
    requests.some((request) => request.url.endsWith("/deliveries/3835545665537048576")),
    false,
  );
});

test("reconciler rejects malformed or non-failure provider entries without redelivery", async () => {
  const repository = new ReconcileRepository();
  const reconciler = new GithubWebhookRedeliveryReconciler(
    repository,
    async () => new Response(JSON.stringify([
      { id: 101, guid: "not-a-failure", status_code: 200 },
    ]), { status: 200 }),
    () => "app-jwt",
  );
  await assert.rejects(reconciler.reconcile(25), /entry was invalid/);
  assert.equal(repository.reserved.length, 0);
});

class ReconcileRepository implements GithubWebhookInboxRepository {
  captured = new Set<string>();
  cooldown = new Set<string>();
  reserved: string[] = [];
  recorded: { deliveryId: string; providerDeliveryId: string; httpStatus: number }[] = [];

  async capture(_input: GithubWebhookInboxCapture): Promise<GithubWebhookInboxCaptureResult> {
    throw new Error("unused");
  }

  async hasDelivery(deliveryId: string): Promise<boolean> {
    return this.captured.has(deliveryId);
  }

  async reserveRedelivery(input: {
    deliveryId: string;
    providerDeliveryId: string;
    cooldownMs: number;
  }): Promise<boolean> {
    this.reserved.push(input.deliveryId);
    return !this.cooldown.has(input.deliveryId);
  }

  async recordRedeliveryResult(input: {
    deliveryId: string;
    providerDeliveryId: string;
    httpStatus: number;
  }): Promise<void> {
    this.recorded.push(input);
  }

  async claim(): Promise<GithubWebhookInboxLease | undefined> {
    throw new Error("unused");
  }

  async complete(): Promise<void> {
    throw new Error("unused");
  }

  async retry(): Promise<void> {
    throw new Error("unused");
  }

  async deadLetter(): Promise<void> {
    throw new Error("unused");
  }

  async snapshot(): Promise<GithubWebhookInboxSnapshot> {
    throw new Error("unused");
  }
}
