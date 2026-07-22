import { createHmac, timingSafeEqual } from "node:crypto";

export type GitHubWebhookEvent =
  | {
      readonly type: "push";
      readonly ref: string;
      readonly headSha: string;
      readonly beforeSha?: string;
      readonly deleted: boolean;
    }
  | {
      readonly type: "pull_request.opened";
      readonly pullRequestNumber: number;
      readonly headSha: string;
      readonly title?: string;
      readonly url?: string;
      readonly authorId?: number;
      readonly authorLogin?: string;
      readonly authorAccountType?: string;
      readonly draft?: boolean;
    }
  | {
      readonly type: "pull_request.synchronize";
      readonly pullRequestNumber: number;
      readonly headSha: string;
      readonly title?: string;
      readonly url?: string;
      readonly authorId?: number;
      readonly authorLogin?: string;
      readonly authorAccountType?: string;
      readonly draft?: boolean;
    }
  | {
      readonly type: "issue.opened";
      readonly issueNumber: number;
      readonly title: string;
      readonly url?: string;
      readonly authorId?: number;
      readonly authorLogin?: string;
      readonly authorAccountType?: string;
    };

export interface GitHubWebhookAccount {
  readonly id?: number;
  readonly login?: string;
  readonly accountType?: string;
}

export type GitHubReviewTriggerEvent = Extract<
  GitHubWebhookEvent,
  { readonly type: "pull_request.opened" | "pull_request.synchronize" }
>;

export type GitHubIssueTriggerEvent = Extract<GitHubWebhookEvent, { readonly type: "issue.opened" }>;
export type GitHubContextGraphTriggerEvent = Extract<GitHubWebhookEvent, { readonly type: "push" }>;

export interface ParsedGitHubWebhook {
  readonly event: GitHubWebhookEvent;
  readonly repository: string;
  readonly repositoryId?: number;
  readonly installationId?: number;
  readonly repositoryOwner?: GitHubWebhookAccount;
  readonly sender?: GitHubWebhookAccount;
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

export function isContextGraphTrigger(event: GitHubWebhookEvent): event is GitHubContextGraphTriggerEvent {
  return event.type === "push" && !event.deleted && event.ref.startsWith("refs/heads/");
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
  if (eventName !== "pull_request" && eventName !== "issues" && eventName !== "push") {
    return undefined;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    throw new InvalidGitHubWebhookPayloadError("payload is not valid JSON");
  }

  const root = requiredRecord(payload, "payload");
  const repository = requiredRecord(root.repository, "repository");
  const repositoryFullName = requiredString(repository.full_name, "repository.full_name");
  const common = {
    repository: repositoryFullName,
    ...optionalNumberProperty("repositoryId", repository.id),
    ...optionalNestedNumberProperty("installationId", root.installation, "id"),
    ...optionalAccountProperty("repositoryOwner", repository.owner),
    ...optionalAccountProperty("sender", root.sender)
  };

  if (eventName === "push") {
    const deleted = root.deleted === true;
    return {
      ...common,
      event: {
        type: "push",
        ref: requiredString(root.ref, "ref"),
        headSha: requiredString(root.after, "after"),
        ...optionalStringProperty("beforeSha", root.before),
        deleted
      }
    };
  }

  const action = requiredString(root.action, "action");

  if (eventName === "pull_request") {
    if (action !== "opened" && action !== "synchronize") {
      return undefined;
    }

    const pullRequest = requiredRecord(root.pull_request, "pull_request");
    const pullRequestNumber = requiredPositiveInteger(root.number ?? pullRequest.number, "pull_request.number");

    const head = requiredRecord(pullRequest.head, "pull_request.head");
    const event = {
      type: action === "opened" ? ("pull_request.opened" as const) : ("pull_request.synchronize" as const),
      pullRequestNumber,
      headSha: requiredString(head.sha, "pull_request.head.sha"),
      ...optionalStringProperty("title", pullRequest.title),
      ...optionalStringProperty("url", pullRequest.html_url),
      ...optionalNestedNumberProperty("authorId", pullRequest.user, "id"),
      ...optionalNestedStringProperty("authorLogin", pullRequest.user, "login"),
      ...optionalNestedStringProperty("authorAccountType", pullRequest.user, "type"),
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
      ...optionalNestedNumberProperty("authorId", issue.user, "id"),
      ...optionalNestedStringProperty("authorLogin", issue.user, "login"),
      ...optionalNestedStringProperty("authorAccountType", issue.user, "type")
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

function optionalStringProperty<Key extends string>(key: Key, value: unknown): Readonly<Partial<Record<Key, string>>> {
  return typeof value === "string" && value.length > 0
    ? ({ [key]: value } as Record<Key, string>)
    : ({} as Partial<Record<Key, string>>);
}

function optionalNumberProperty<Key extends string>(key: Key, value: unknown): Readonly<Partial<Record<Key, number>>> {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? ({ [key]: value } as Record<Key, number>)
    : ({} as Partial<Record<Key, number>>);
}

function optionalNestedStringProperty<Key extends string>(
  key: Key,
  container: unknown,
  field: string
): Readonly<Partial<Record<Key, string>>> {
  if (typeof container !== "object" || container === null || Array.isArray(container)) {
    return {} as Partial<Record<Key, string>>;
  }
  return optionalStringProperty(key, (container as Record<string, unknown>)[field]);
}

function optionalNestedNumberProperty<Key extends string>(
  key: Key,
  container: unknown,
  field: string
): Readonly<Partial<Record<Key, number>>> {
  if (typeof container !== "object" || container === null || Array.isArray(container)) {
    return {} as Partial<Record<Key, number>>;
  }
  return optionalNumberProperty(key, (container as Record<string, unknown>)[field]);
}

function optionalAccountProperty<Key extends string>(
  key: Key,
  value: unknown
): Readonly<Partial<Record<Key, GitHubWebhookAccount>>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {} as Partial<Record<Key, GitHubWebhookAccount>>;
  }
  const record = value as Record<string, unknown>;
  const account = {
    ...optionalNumberProperty("id", record.id),
    ...optionalStringProperty("login", record.login),
    ...optionalStringProperty("accountType", record.type)
  };
  return Object.keys(account).length > 0
    ? ({ [key]: account } as Record<Key, GitHubWebhookAccount>)
    : ({} as Partial<Record<Key, GitHubWebhookAccount>>);
}
