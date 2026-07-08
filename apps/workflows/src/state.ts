import { createEmptyBoardState, type BoardState } from "@jina/board";
import type { ContextItemDraft } from "@jina/context";
import type { PrReviewFactoryPlan } from "@jina/factory";
import type { PublicationResult } from "@jina/publication";

export interface StoredContextItem {
  readonly taskId: string;
  readonly targetTaskId: string;
  readonly item: ContextItemDraft;
}

export interface WorkflowState {
  readonly board: BoardState;
  readonly factoryPlans: readonly PrReviewFactoryPlan[];
  readonly contextItems: readonly StoredContextItem[];
  readonly publications: readonly PublicationResult[];
}

export function createWorkflowState(): WorkflowState {
  return {
    board: createEmptyBoardState(),
    factoryPlans: [],
    contextItems: [],
    publications: []
  };
}

export function replaceBoard(state: WorkflowState, board: BoardState): WorkflowState {
  return { ...state, board };
}
