import {
  InvalidGitHubWebhookPayloadError,
  parseGitHubWebhook,
  verifyGitHubWebhookSignature,
  type ParsedGitHubWebhook
} from "@jina/github";

export interface GitHubWebhookRequest {
  readonly eventName: string | undefined;
  readonly deliveryId: string | undefined;
  readonly signature: string | undefined;
  readonly rawBody: Uint8Array;
  readonly secret: string | undefined;
}

export interface WebhookRouteResult {
  readonly accepted: boolean;
  readonly statusCode: number;
  readonly reason: string;
  readonly deliveryId?: string;
  readonly webhook?: ParsedGitHubWebhook;
}

/** Authenticate and parse one raw GitHub delivery before any board mutation. */
export function handleGitHubWebhook(request: GitHubWebhookRequest): WebhookRouteResult {
  if (!request.secret) {
    return { accepted: false, statusCode: 503, reason: "GitHub webhook secret is not configured" };
  }
  if (!request.eventName) {
    return { accepted: false, statusCode: 400, reason: "X-GitHub-Event header is required" };
  }
  if (!request.deliveryId) {
    return { accepted: false, statusCode: 400, reason: "X-GitHub-Delivery header is required" };
  }
  if (!verifyGitHubWebhookSignature(request.secret, request.rawBody, request.signature)) {
    return { accepted: false, statusCode: 401, reason: "invalid GitHub webhook signature" };
  }

  try {
    const webhook = parseGitHubWebhook(request.eventName, request.rawBody);
    if (!webhook) {
      return {
        accepted: true,
        statusCode: 202,
        reason: `ignored GitHub ${request.eventName} delivery`,
        deliveryId: request.deliveryId
      };
    }

    return {
      accepted: true,
      statusCode: 202,
      reason: "GitHub delivery accepted",
      deliveryId: request.deliveryId,
      webhook
    };
  } catch (error) {
    if (error instanceof InvalidGitHubWebhookPayloadError) {
      return { accepted: false, statusCode: 400, reason: error.message };
    }
    throw error;
  }
}
