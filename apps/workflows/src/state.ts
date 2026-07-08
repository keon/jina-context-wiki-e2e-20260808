import { createEmptyBoardState, type BoardState } from "@jina/board";
import type { ContextItemDraft } from "@jina/context";
import type { PublicationResult } from "@jina/publication";
import type { PrReviewPlan } from "@jina/review";

export interface StoredContextItem {
  readonly taskId: string;
  readonly targetTaskId: string;
  readonly item: ContextItemDraft;
}

export interface WorkflowState {
  readonly board: BoardState;
  readonly reviewPlans: readonly PrReviewPlan[];
  readonly contextItems: readonly StoredContextItem[];
  readonly publications: readonly PublicationResult[];
}

export function createWorkflowState(): WorkflowState {
  return {
    board: createEmptyBoardState(),
    reviewPlans: [],
    contextItems: [],
    publications: []
  };
}

export function replaceBoard(state: WorkflowState, board: BoardState): WorkflowState {
  return { ...state, board };
}
