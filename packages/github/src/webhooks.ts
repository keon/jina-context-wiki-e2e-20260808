import { createHmac, timingSafeEqual } from "node:crypto";

export type GitHubWebhookEvent =
  | {
      readonly type: "pull_request.opened";
      readonly pullRequestNumber: number;
      readonly headSha: string;
      readonly title?: string;
      readonly url?: string;
      readonly authorLogin?: string;
      readonly draft?: boolean;
    }
  | {
      readonly type: "pull_request.synchronize";
      readonly pullRequestNumber: number;
      readonly headSha: string;
      readonly title?: string;
      readonly url?: string;
      readonly authorLogin?: string;
      readonly draft?: boolean;
    }
  | { readonly type: "pull_request.closed"; readonly pullRequestNumber: number; readonly merged: boolean }
  | {
      readonly type: "issue.opened";
      readonly issueNumber: number;
      readonly title: string;
      readonly url?: string;
      readonly authorLogin?: string;
    };

export type GitHubReviewTriggerEvent = Extract<
  GitHubWebhookEvent,
  { readonly type: "pull_request.opened" | "pull_request.synchronize" }
>;

export type GitHubIssueTriggerEvent = Extract<GitHubWebhookEvent, { readonly type: "issue.opened" }>;

export interface ParsedGitHubWebhook {
  readonly event: GitHubWebhookEvent;
  readonly repository: string;
  readonly repositoryId?: number;
  readonly installationId?: number;
  readonly senderLogin?: string;
}

export class InvalidGitHubWebhookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGitHubWebhookPayloadError";
  }
}

export function isReviewTrigger(event: GitHubWebhookEvent): event is GitHubReviewTriggerEvent {
  return event.type === "pull_request.opened" || event.type === "pull_request.synchronize";
}

export function isIssueTrigger(event: GitHubWebhookEvent): event is GitHubIssueTriggerEvent {
  return event.type === "issue.opened";
}

/** Verify the exact raw request bytes against GitHub's X-Hub-Signature-256 header. */
export function verifyGitHubWebhookSignature(
  secret: string,
  rawBody: Uint8Array,
  signatureHeader: string | undefined
): boolean {
  if (!secret || !signatureHeader?.startsWith("sha256=")) {
    return false;
  }

  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`, "utf8");
  const received = Buffer.from(signatureHeader, "utf8");

  return expected.length === received.length && timingSafeEqual(expected, received);
}

/**
 * Convert a GitHub webhook payload into Jina's small domain event surface.
 * Unsupported event/action pairs return undefined and are acknowledged without work.
 */
export function parseGitHubWebhook(eventName: string, rawBody: Uint8Array): ParsedGitHubWebhook | undefined {
  if (eventName !== "pull_request" && eventName !== "issues") {
    return undefined;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    throw new InvalidGitHubWebhookPayloadError("payload is not valid JSON");
  }

  const root = requiredRecord(payload, "payload");
  const action = requiredString(root.action, "action");
  const repository = requiredRecord(root.repository, "repository");
  const repositoryFullName = requiredString(repository.full_name, "repository.full_name");
  const common = {
    repository: repositoryFullName,
    ...optionalNumberProperty("repositoryId", repository.id),
    ...optionalNestedNumberProperty("installationId", root.installation, "id"),
    ...optionalNestedStringProperty("senderLogin", root.sender, "login")
  };

  if (eventName === "pull_request") {
    if (action !== "opened" && action !== "synchronize" && action !== "closed") {
      return undefined;
    }

    const pullRequest = requiredRecord(root.pull_request, "pull_request");
    const pullRequestNumber = requiredPositiveInteger(root.number ?? pullRequest.number, "pull_request.number");

    if (action === "closed") {
      return {
        ...common,
        event: {
          type: "pull_request.closed",
          pullRequestNumber,
          merged: pullRequest.merged === true
        }
      };
    }

    const head = requiredRecord(pullRequest.head, "pull_request.head");
    const event = {
      type: action === "opened" ? ("pull_request.opened" as const) : ("pull_request.synchronize" as const),
      pullRequestNumber,
      headSha: requiredString(head.sha, "pull_request.head.sha"),
      ...optionalStringProperty("title", pullRequest.title),
      ...optionalStringProperty("url", pullRequest.html_url),
      ...optionalNestedStringProperty("authorLogin", pullRequest.user, "login"),
      ...(typeof pullRequest.draft === "boolean" ? { draft: pullRequest.draft } : {})
    };

    return { ...common, event };
  }

  if (action !== "opened") {
    return undefined;
  }

  const issue = requiredRecord(root.issue, "issue");
  // GitHub's issue-shaped objects can represent pull requests in other API surfaces.
  // Never create a second issue task if such a payload reaches this endpoint.
  if (issue.pull_request !== undefined) {
    return undefined;
  }

  return {
    ...common,
    event: {
      type: "issue.opened",
      issueNumber: requiredPositiveInteger(issue.number, "issue.number"),
      title: requiredString(issue.title, "issue.title"),
      ...optionalStringProperty("url", issue.html_url),
      ...optionalNestedStringProperty("authorLogin", issue.user, "login")
    }
  };
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidGitHubWebhookPayloadError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidGitHubWebhookPayloadError(`${field} must be a non-empty string`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidGitHubWebhookPayloadError(`${field} must be a positive integer`);
  }
  return value;
}

function optionalStringProperty<Key extends string>(key: Key, value: unknown): { readonly [K in Key]?: string } {
  return typeof value === "string" && value.length > 0 ? ({ [key]: value } as { [K in Key]: string }) : {};
}

function optionalNumberProperty<Key extends string>(key: Key, value: unknown): { readonly [K in Key]?: number } {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? ({ [key]: value } as { [K in Key]: number })
    : {};
}

function optionalNestedStringProperty<Key extends string>(
  key: Key,
  container: unknown,
  field: string
): { readonly [K in Key]?: string } {
  if (typeof container !== "object" || container === null || Array.isArray(container)) {
    return {};
  }
  return optionalStringProperty(key, (container as Record<string, unknown>)[field]);
}

function optionalNestedNumberProperty<Key extends string>(
  key: Key,
  container: unknown,
  field: string
): { readonly [K in Key]?: number } {
  if (typeof container !== "object" || container === null || Array.isArray(container)) {
    return {};
  }
  return optionalNumberProperty(key, (container as Record<string, unknown>)[field]);
}
