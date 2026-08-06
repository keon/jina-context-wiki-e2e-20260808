import { ApiError } from "./errors.js";
import {
  admitInstallationBackfill,
  INSTALLATION_BACKFILL_TASK_ID,
} from "./installation-board-admission.js";
import {
  admitConfiguredBoardReview,
  ReviewAdmissionPausedError,
  type BoardReviewAdmissionResult,
  type BoardReviewV2AdmissionResult,
  type ReviewBoardArrival,
  type ReviewBoardPipelineSelection,
} from "./review-board-admission.js";
import { REVIEW_TASK_ID } from "./review-task-routing.js";
import type { CreateReviewRunInput } from "./store.js";
import type { BoardWorkflowAdmitter, DispatchOptions } from "./board-admission-contract.js";

interface ReviewDispatcherDependencies {
  readonly admit?: (input: CreateReviewRunInput) => Promise<BoardReviewAdmissionResult>;
  readonly admitReview?: (
    arrival: ReviewBoardArrival,
    selection: ReviewBoardPipelineSelection,
  ) => Promise<BoardReviewAdmissionResult | BoardReviewV2AdmissionResult>;
  readonly admitInstallationBackfill?: (
    payload: unknown,
    options: DispatchOptions,
  ) => Promise<{ id: string }>;
}

const DEFAULT_DEPENDENCIES: ReviewDispatcherDependencies = {
  admitReview: admitConfiguredBoardReview,
  admitInstallationBackfill,
};

interface ReviewDispatcherOptions {
  readonly pipeline: ReviewBoardPipelineSelection;
  readonly dependencies?: ReviewDispatcherDependencies;
}

export class ProductBoardWorkflowAdmitter implements BoardWorkflowAdmitter {
  private readonly dependencies: ReviewDispatcherDependencies;
  private readonly pipeline: ReviewBoardPipelineSelection;

  constructor(options: ReviewDispatcherDependencies | ReviewDispatcherOptions = DEFAULT_DEPENDENCIES) {
    if ("pipeline" in options) {
      this.pipeline = options.pipeline;
      this.dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
    } else {
      this.pipeline = { mode: "v1", v2Repositories: new Set() };
      this.dependencies = options;
    }
  }

  async admitBoardWorkflow(
    taskIdentifier: string,
    payload: unknown,
    options: DispatchOptions,
  ): Promise<{ id: string }> {
    if (taskIdentifier === INSTALLATION_BACKFILL_TASK_ID) {
      return (this.dependencies.admitInstallationBackfill ?? admitInstallationBackfill)(
        payload,
        options,
      );
    }
    if (taskIdentifier !== REVIEW_TASK_ID) {
      throw new ApiError(400, `Unsupported Board workflow: ${taskIdentifier}`);
    }
    const input = reviewBoardInputFromArrival(payload, options);
    try {
      const admitted = this.dependencies.admit
        ? await this.dependencies.admit(input)
        : await (this.dependencies.admitReview ?? admitConfiguredBoardReview)(
            {
              input,
              triggerPayload: objectValue(payload, "review payload"),
              triggerOptions: options,
            },
            this.pipeline,
          );
      return { id: admitted.workflowId };
    } catch (error) {
      if (error instanceof ReviewAdmissionPausedError) {
        throw new ApiError(503, "Review admission is temporarily paused for a workflow cutover");
      }
      throw error;
    }
  }
}

export function reviewBoardInputFromArrival(
  payload: unknown,
  options: DispatchOptions,
): CreateReviewRunInput {
  const value = objectValue(payload, "review payload");
  const repository = objectValue(value.repository, "review repository");
  const pullRequest = objectValue(value.pull_request, "review pull request");
  const installationId = requiredPositiveNumber(
    value.github_installation_id,
    "github_installation_id",
  );
  const githubRepoId = requiredPositiveNumber(repository.github_repo_id, "repository.github_repo_id");
  const pullRequestNumber = requiredPositiveNumber(pullRequest.number, "pull_request.number");
  const headSha = requiredString(pullRequest.head_sha, "pull_request.head_sha");
  const owner = optionalString(repository.owner);

  return {
    idempotencyKey:
      options.idempotencyKey ??
      optionalString(value.review_idempotency_key) ??
      `review:${installationId}:${githubRepoId}:${pullRequestNumber}:${headSha}:code_review`,
    deliveryId: optionalString(value.delivery_id),
    sourceEvent: optionalString(value.source_event),
    triggerSource: optionalString(value.trigger) ?? "webhook",
    ...(optionalString(value.manual_command_tag)
      ? { manualCommandTag: optionalString(value.manual_command_tag) }
      : {}),
    ...(optionalString(value.review_instructions)
      ? { reviewInstructions: optionalString(value.review_instructions) }
      : {}),
    orchestrationPayload: value,
    installationId,
    account: {
      id: optionalPositiveNumber(repository.owner_id),
      login: owner,
      type: optionalString(repository.owner_type),
    },
    repository: {
      githubRepoId,
      owner,
      name: optionalString(repository.name),
      fullName: optionalString(repository.full_name),
      defaultBranch: optionalString(repository.default_branch),
      private: optionalBoolean(repository.private),
    },
    pullRequest: {
      number: pullRequestNumber,
      title: optionalString(pullRequest.title),
      htmlUrl: optionalString(pullRequest.html_url),
      author: optionalString(pullRequest.author),
      headSha,
      baseSha: optionalString(pullRequest.base_sha),
      headRef: optionalString(pullRequest.head_ref),
      baseRef: optionalString(pullRequest.base_ref),
      draft: optionalBoolean(pullRequest.draft),
    },
  };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new ApiError(400, `${label} must be a non-empty string`);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function requiredPositiveNumber(value: unknown, label: string): number {
  const normalized = optionalPositiveNumber(value);
  if (!normalized) throw new ApiError(400, `${label} must be a positive safe integer`);
  return normalized;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
