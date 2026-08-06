import type { GithubWebhookInboxRepository } from "./github-webhook-inbox-store.js";
import { PostgresGithubWebhookInboxRepository } from "./github-webhook-inbox-store.js";
import { createGithubAppJwt, normalizePrivateKey } from "./github-app.js";
import { ApiError } from "./errors.js";

const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_API = "https://api.github.com";

interface GithubWebhookRedeliveryResult {
  readonly examined: number;
  readonly alreadyCaptured: number;
  readonly cooldownSkipped: number;
  readonly requested: number;
}

export class GithubWebhookRedeliveryReconciler {
  constructor(
    private readonly repository: GithubWebhookInboxRepository =
      new PostgresGithubWebhookInboxRepository(),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly jwtFactory: () => string = runtimeGithubAppJwt,
    private readonly cooldownMs = 10 * 60_000,
  ) {}

  async reconcile(limit: number): Promise<GithubWebhookRedeliveryResult> {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const authorization = `Bearer ${this.jwtFactory()}`;
    const listResponse = await this.fetchImpl(
      `${GITHUB_API}/app/hook/deliveries?per_page=${boundedLimit}&status=failure`,
      { headers: githubHeaders(authorization) },
    );
    if (!listResponse.ok) {
      throw new ApiError(502, `GitHub failed-delivery listing returned ${listResponse.status}`);
    }
    const deliveries = parseFailedDeliveries(await listResponse.json());
    let alreadyCaptured = 0;
    let cooldownSkipped = 0;
    let requested = 0;
    for (const delivery of deliveries.slice(0, boundedLimit)) {
      if (await this.repository.hasDelivery(delivery.guid)) {
        alreadyCaptured += 1;
        continue;
      }
      const reserved = await this.repository.reserveRedelivery({
        deliveryId: delivery.guid,
        providerDeliveryId: delivery.id,
        cooldownMs: this.cooldownMs,
      });
      if (!reserved) {
        cooldownSkipped += 1;
        continue;
      }
      const response = await this.fetchImpl(
        `${GITHUB_API}/app/hook/deliveries/${delivery.id}/attempts`,
        { method: "POST", headers: githubHeaders(authorization), redirect: "error" },
      );
      await this.repository.recordRedeliveryResult({
        deliveryId: delivery.guid,
        providerDeliveryId: delivery.id,
        httpStatus: response.status,
      });
      if (response.status !== 202) {
        throw new ApiError(502, `GitHub redelivery request returned ${response.status}`);
      }
      requested += 1;
    }
    return {
      examined: Math.min(deliveries.length, boundedLimit),
      alreadyCaptured,
      cooldownSkipped,
      requested,
    };
  }
}

interface FailedDelivery {
  readonly id: number;
  readonly guid: string;
}

function parseFailedDeliveries(value: unknown): FailedDelivery[] {
  if (!Array.isArray(value)) throw new ApiError(502, "GitHub failed-delivery response was invalid");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ApiError(502, "GitHub failed-delivery entry was invalid");
    }
    const delivery = entry as Record<string, unknown>;
    if (
      !Number.isSafeInteger(delivery.id) ||
      (delivery.id as number) < 1 ||
      typeof delivery.guid !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(delivery.guid) ||
      !Number.isSafeInteger(delivery.status_code) ||
      (delivery.status_code as number) < 400 ||
      (delivery.status_code as number) > 599
    ) {
      throw new ApiError(502, "GitHub failed-delivery entry was invalid");
    }
    return { id: delivery.id as number, guid: delivery.guid };
  });
}

function githubHeaders(authorization: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    authorization,
    "user-agent": "jina-code-review",
    "x-github-api-version": GITHUB_API_VERSION,
  };
}

function runtimeGithubAppJwt(): string {
  return createGithubAppJwt(
    requiredRuntimeEnv("GITHUB_APP_ID"),
    normalizePrivateKey(requiredRuntimeEnv("GITHUB_APP_PRIVATE_KEY")),
  );
}

function requiredRuntimeEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for GitHub webhook redelivery`);
  return value;
}
