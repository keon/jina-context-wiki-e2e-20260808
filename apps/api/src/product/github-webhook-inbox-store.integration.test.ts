import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

import { Pool } from "pg";

import { getPool } from "./db.js";
import {
  GithubWebhookDeliveryConflictError,
  GithubWebhookInboxLeaseLostError,
  PostgresGithubWebhookInboxRepository,
  type GithubWebhookInboxCapture,
} from "./github-webhook-inbox-store.js";

const execFileAsync = promisify(execFile);
const runtimeMigration = fileURLToPath(
  new URL("../../../../packages/db/dist/migrate.js", import.meta.url),
);
const productMigration = fileURLToPath(new URL("./migrate.js", import.meta.url));
// This test drops public, jina_runtime, and jina_context. Never fall back to DATABASE_URL.
const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "Postgres GitHub inbox deduplicates, orders, fences leases, and filters canaries",
  { skip: !databaseUrl },
  async () => {
    const previousProductUrl = process.env.JINA_PRODUCT_DATABASE_URL;
    const previousProductMode = process.env.JINA_PRODUCT_DATABASE_MODE;
    process.env.JINA_PRODUCT_DATABASE_URL = databaseUrl;
    process.env.JINA_PRODUCT_DATABASE_MODE = "url";
    const control = new Pool({
      connectionString: databaseUrl,
      application_name: "jina-github-webhook-inbox-test",
    });
    try {
      await resetDatabase(control);
      await migrateDatabase(databaseUrl!);
      const repository = new PostgresGithubWebhookInboxRepository();

      const first = capture("delivery-1", "a".repeat(64), 42);
      assert.deepEqual(await repository.capture(first), {
        inserted: true,
        status: "pending",
      });
      assert.deepEqual(
        await repository.capture({
          ...first,
          // A fresh AES-GCM nonce can produce different ciphertext for the same exact body.
          payloadCiphertext: Buffer.from("same-body-fresh-ciphertext"),
        }),
        { inserted: false, status: "pending" },
      );
      await assert.rejects(
        repository.capture({ ...first, event: "pull_request_review" }),
        GithubWebhookDeliveryConflictError,
      );
      await assert.rejects(
        repository.capture({ ...first, payloadSha256: "b".repeat(64) }),
        GithubWebhookDeliveryConflictError,
      );

      assert.equal(await repository.hasDelivery("delivery-1"), true);
      assert.equal(await repository.hasDelivery("missing-guid"), false);
      assert.equal(await repository.reserveRedelivery({
        deliveryId: "missing-guid",
        providerDeliveryId: 9001,
        cooldownMs: 600_000,
      }), true);
      assert.equal(await repository.reserveRedelivery({
        deliveryId: "missing-guid",
        providerDeliveryId: 9001,
        cooldownMs: 600_000,
      }), false);
      await repository.recordRedeliveryResult({
        deliveryId: "missing-guid",
        providerDeliveryId: 9001,
        httpStatus: 202,
      });
      await control.query(
        `update github_webhook_redelivery_requests
            set last_requested_at=now() - interval '11 minutes'
          where github_delivery_id='missing-guid'`,
      );
      assert.equal(await repository.reserveRedelivery({
        deliveryId: "missing-guid",
        providerDeliveryId: 9002,
        cooldownMs: 600_000,
      }), true);

      await repository.capture(capture("delivery-2", "c".repeat(64), 42));
      const captureOnly = await repository.claim({
        leaseMs: 120_000,
        canaryRepositories: new Set(["omxyz/private-repo"]),
      });
      assert.equal(captureOnly, undefined);

      const captureOnlyControl = (await repository.snapshot()).control;
      const processControl = await repository.transitionMode({
        expectedGeneration: captureOnlyControl.generation,
        mode: "capture_and_process",
        updatedBy: "integration-test",
      });
      const firstLease = await repository.claim({
        leaseMs: 120_000,
        canaryRepositories: new Set(),
      });
      assert.equal(firstLease?.deliveryId, "delivery-1");
      assert.equal(firstLease?.leaseGeneration, processControl.generation);
      assert.equal(
        await repository.claim({
          deliveryId: "delivery-2",
          leaseMs: 120_000,
          canaryRepositories: new Set(),
        }),
        undefined,
      );
      await repository.complete({ lease: firstLease, processedWorkflowId: "workflow-1" });
      const secondLease = await repository.claim({
        leaseMs: 120_000,
        canaryRepositories: new Set(),
      });
      assert.equal(secondLease?.deliveryId, "delivery-2");

      await control.query(
        `update github_webhook_inbox
            set lease_expires_at=now() - interval '1 second'
          where github_delivery_id='delivery-2'`,
      );
      const replacementLease = await repository.claim({
        deliveryId: "delivery-2",
        leaseMs: 120_000,
        canaryRepositories: new Set(),
      });
      assert.equal(replacementLease?.deliveryId, "delivery-2");
      assert.notEqual(replacementLease?.leaseId, secondLease?.leaseId);
      await assert.rejects(
        repository.complete({ lease: secondLease }),
        GithubWebhookInboxLeaseLostError,
      );
      await repository.complete({ lease: replacementLease, processedWorkflowId: "workflow-2" });

      await repository.capture(capture("delivery-non-canary", "d".repeat(64), 100, "acme/other"));
      await repository.capture(capture("delivery-canary", "e".repeat(64), 101));
      const beforeCanary = (await repository.snapshot()).control;
      await repository.transitionMode({
        expectedGeneration: beforeCanary.generation,
        mode: "canary_only",
        updatedBy: "integration-test",
      });
      const canaryLease = await repository.claim({
        leaseMs: 120_000,
        canaryRepositories: new Set(["OMXYZ/PRIVATE-REPO"]),
      });
      assert.equal(canaryLease?.deliveryId, "delivery-canary");
      await repository.complete({ lease: canaryLease });
      assert.equal(
        await repository.claim({
          leaseMs: 120_000,
          canaryRepositories: new Set(["omxyz/private-repo"]),
        }),
        undefined,
      );

      const snapshot = await repository.snapshot();
      assert.equal(snapshot.pending, 1);
      assert.equal(snapshot.leased, 0);
      assert.equal(snapshot.completed, 3);
      assert.equal(snapshot.priorGenerationLeases, 0);
    } finally {
      await getPool().end().catch(() => undefined);
      restoreEnvironment("JINA_PRODUCT_DATABASE_URL", previousProductUrl);
      restoreEnvironment("JINA_PRODUCT_DATABASE_MODE", previousProductMode);
      await control.end();
    }
  },
);

function capture(
  deliveryId: string,
  payloadSha256: string,
  pullRequestNumber: number,
  repositoryFullName = "omxyz/private-repo",
): GithubWebhookInboxCapture {
  return {
    deliveryId,
    event: "pull_request",
    action: "synchronize",
    installationId: 456,
    repositoryId: repositoryFullName === "omxyz/private-repo" ? 123 : 999,
    repositoryFullName,
    pullRequestNumber,
    payloadSha256,
    payloadCiphertext: Buffer.from(`ciphertext-${deliveryId}`),
    encryptionKeyVersion: "7",
  };
}

async function migrateDatabase(url: string): Promise<void> {
  const environment = {
    ...process.env,
    DATABASE_URL: url,
    TEST_DATABASE_URL: url,
    JINA_PRODUCT_DATABASE_URL: url,
    JINA_PRODUCT_DATABASE_MODE: "url",
  };
  await execFileAsync(process.execPath, [runtimeMigration], { env: environment });
  await execFileAsync(process.execPath, [productMigration], { env: environment });
}

async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query("drop schema if exists jina_context cascade");
  await pool.query("drop schema if exists jina_runtime cascade");
  await pool.query("drop schema if exists public cascade");
  await pool.query("create schema public");
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
