import type { SourcePolicy } from "@jina/context";
import { isReviewTrigger, type GitHubWebhookEvent } from "@jina/github";
import type { BudgetLimits } from "@jina/policy";
import type { IsoTimestamp } from "@jina/shared-kernel";
import type { WorkflowState } from "../state.js";
import { ingestPullRequestReview } from "./pull-request.js";

export interface GitHubWebhookIngestContext {
  readonly tenantId: string;
  readonly repository: string;
  readonly needsExternalContext?: boolean;
  readonly budgetLimits?: BudgetLimits;
  readonly sourcePolicy?: SourcePolicy;
}

export function ingestGitHubWebhook(
  state: WorkflowState,
  event: GitHubWebhookEvent,
  context: GitHubWebhookIngestContext,
  now: IsoTimestamp
): WorkflowState {
  if (!isReviewTrigger(event)) {
    return state;
  }

  return ingestPullRequestReview(
    state,
    {
      tenantId: context.tenantId,
      repository: context.repository,
      pullRequestNumber: event.pullRequestNumber,
      headSha: event.headSha,
      ...(context.needsExternalContext !== undefined ? { needsExternalContext: context.needsExternalContext } : {}),
      ...(context.budgetLimits ? { budgetLimits: context.budgetLimits } : {}),
      ...(context.sourcePolicy ? { sourcePolicy: context.sourcePolicy } : {})
    },
    now
  );
}
