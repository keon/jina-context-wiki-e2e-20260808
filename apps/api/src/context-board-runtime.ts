import { findTask, type BoardState, type TaskId } from "@jina/board";
import {
  addContextGateRepairRound,
  addContextPageRepairCycle,
  addContextPublicationWork,
  addContextResearchPlan,
  addContextResearchWork,
  bindContextBoardBuildCommit,
  contextBoardTaskTypes,
  failContextGateRepairExhausted,
  failContextPageRepairExhausted,
  MAX_CONTEXT_GATE_REPAIR_PASS,
  MAX_CONTEXT_REPAIR_PASS,
  parseContextBoardTaskResult,
  type ContextBoardTaskResult
} from "@jina/context-engine";

export interface AppliedContextBoardResult {
  readonly state: BoardState;
  readonly result: ContextBoardTaskResult;
  readonly postCompletion?: ContextBoardPostCompletion;
}

export type ContextBoardPostCompletion =
  | {
      readonly kind: "fail_page_repair_exhausted";
      readonly completingTaskId: TaskId;
      readonly pageTaskId: TaskId;
      readonly priorAuditTaskId: TaskId;
      readonly pass: number;
    }
  | {
      readonly kind: "fail_gate_repair_exhausted";
      readonly completingTaskId: TaskId;
      readonly buildTaskId: TaskId;
      readonly sourceChallengeTaskId: TaskId;
      readonly taskEvaluationTaskId: TaskId;
      readonly pass: number;
    };

/**
 * Expands the dynamic graph before the caller records a successful completion.
 * The caller must persist this state, the result event, and the task transition
 * in one board transaction.
 */
export function applyContextBoardTaskResult(
  state: BoardState,
  taskId: TaskId,
  value: unknown,
  now: string
): AppliedContextBoardResult {
  const task = findTask(state, taskId);
  if (!task) throw new Error("context board task not found");
  const result = parseContextBoardTaskResult(state, taskId, value);
  const buildTaskId = requiredTaskId(task.metadata.contextBuildId, "contextBuildId");

  switch (result.taskType) {
    case contextBoardTaskTypes.snapshot: {
      const bound = bindContextBoardBuildCommit(state, {
        buildTaskId,
        commitSha: result.commitSha,
        now
      });
      const expanded = addContextResearchPlan(bound, {
        buildTaskId,
        snapshotTaskId: taskId,
        snapshot: result.outputArtifact,
        now
      });
      return { state: expanded.state, result };
    }
    case contextBoardTaskTypes.researchPlan: {
      const expanded = addContextResearchWork(state, {
        buildTaskId,
        researchPlanTaskId: taskId,
        plan: result.outputArtifact,
        work: result.work,
        now
      });
      return { state: expanded.state, result };
    }
    case contextBoardTaskTypes.publicationPlan: {
      const graphTask = state.tasks.find(
        (candidate) => candidate.parentTaskId === buildTaskId && candidate.type === contextBoardTaskTypes.graph
      );
      if (!graphTask) throw new Error("context build graph task not found");
      const expanded = addContextPublicationWork(state, {
        buildTaskId,
        graphTaskId: graphTask.id,
        publicationPlanTaskId: taskId,
        plan: result.outputArtifact,
        pages: result.pages,
        now
      });
      return { state: expanded.state, result };
    }
    case contextBoardTaskTypes.pageAudit:
      if (result.verdict === "unsupported") {
        const pageTaskId = requiredTaskId(task.metadata.pageTaskId, "pageTaskId");
        const pass = requiredPositiveInteger(task.metadata.pass, "pass") + 1;
        if (pass > MAX_CONTEXT_REPAIR_PASS) {
          return {
            state,
            result,
            postCompletion: {
              kind: "fail_page_repair_exhausted",
              completingTaskId: taskId,
              pageTaskId,
              priorAuditTaskId: taskId,
              pass: requiredPositiveInteger(task.metadata.pass, "pass")
            }
          };
        }
        const expanded = addContextPageRepairCycle(state, {
          pageTaskId,
          priorAuditTaskId: taskId,
          findings: result.outputArtifact,
          pass,
          now
        });
        return { state: expanded.state, result };
      }
      return { state, result };
    case contextBoardTaskTypes.sourceChallenge:
    case contextBoardTaskTypes.taskEvaluation: {
      if (result.verdict === "repair_required") {
        const priorPass = requiredPositiveInteger(task.metadata.pass, "pass");
        const sourceChallengeTaskId =
          result.taskType === contextBoardTaskTypes.sourceChallenge
            ? taskId
            : siblingGateTaskId(state, buildTaskId, contextBoardTaskTypes.sourceChallenge, priorPass);
        const taskEvaluationTaskId =
          result.taskType === contextBoardTaskTypes.taskEvaluation
            ? taskId
            : siblingGateTaskId(state, buildTaskId, contextBoardTaskTypes.taskEvaluation, priorPass);
        if (priorPass >= MAX_CONTEXT_GATE_REPAIR_PASS) {
          return {
            state,
            result,
            postCompletion: {
              kind: "fail_gate_repair_exhausted",
              completingTaskId: taskId,
              buildTaskId,
              sourceChallengeTaskId,
              taskEvaluationTaskId,
              pass: MAX_CONTEXT_GATE_REPAIR_PASS
            }
          };
        }
        const expanded = addContextGateRepairRound(state, {
          buildTaskId,
          sourceChallengeTaskId,
          taskEvaluationTaskId,
          pass: priorPass + 1,
          now
        });
        return { state: expanded.state, result };
      }
      return { state, result };
    }
    case contextBoardTaskTypes.certification:
      if (result.verdict !== "certified") {
        throw new Error("an uncertified context snapshot cannot complete certification");
      }
      return { state, result };
    default:
      return { state, result };
  }
}

/**
 * Applies a terminal Context policy only after the completing worker task is
 * durably terminal. The API invokes this inside the same Board mutation after
 * recording the completion receipt and transitioning the current task to done.
 * This preserves generic aggregate reconciliation: unfinished descendants are
 * canceled, while the task that reported the terminal audit remains done.
 */
export function finalizeContextBoardTaskResult(
  state: BoardState,
  action: ContextBoardPostCompletion,
  now: string
): BoardState {
  const completingTask = findTask(state, action.completingTaskId);
  if (!completingTask || completingTask.status !== "done") {
    throw new Error("context terminal finalization requires the completing task to be done");
  }
  switch (action.kind) {
    case "fail_page_repair_exhausted":
      return failContextPageRepairExhausted(state, {
        pageTaskId: action.pageTaskId,
        priorAuditTaskId: action.priorAuditTaskId,
        pass: action.pass,
        now
      });
    case "fail_gate_repair_exhausted":
      return failContextGateRepairExhausted(state, {
        buildTaskId: action.buildTaskId,
        sourceChallengeTaskId: action.sourceChallengeTaskId,
        taskEvaluationTaskId: action.taskEvaluationTaskId,
        pass: action.pass,
        now
      });
  }
}

function requiredTaskId(value: unknown, name: string): TaskId {
  if (typeof value !== "string" || !value.startsWith("task_") || value.length > 240) {
    throw new Error(`${name} must be a task ID`);
  }
  return value as TaskId;
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return Number(value);
}

function siblingGateTaskId(
  state: BoardState,
  buildTaskId: TaskId,
  type: typeof contextBoardTaskTypes.sourceChallenge | typeof contextBoardTaskTypes.taskEvaluation,
  pass: number
): TaskId {
  const task = state.tasks.find(
    (candidate) => candidate.parentTaskId === buildTaskId && candidate.type === type && candidate.metadata.pass === pass
  );
  if (!task) throw new Error(`${type} pass ${pass} is missing from the context build`);
  return task.id;
}
