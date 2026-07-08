import { entityId, type EntityId } from "@jina/shared-kernel";
import type { FactoryRunId } from "./factory-runs.js";
import type { WorkOrderId } from "./work-orders.js";

export type AssemblyLineSlug = "pr_review" | "context_research" | "fix" | "release" | "incident_response";

export interface AssemblyLineRef {
  readonly slug: AssemblyLineSlug;
  readonly version: string;
}

export type PlannedTaskId = EntityId<"task">;

export interface PlannedTask {
  readonly id: PlannedTaskId;
  readonly type: "pr_review" | "review_pass" | "publish";
  readonly title: string;
  readonly assigneeRole: "factory" | "review_agent" | "publisher";
  readonly dedupeKey: string;
  readonly required: boolean;
  readonly dispatchTopic?: "run-review" | "run-publish";
  readonly parentTaskId?: PlannedTaskId;
  readonly metadata: Record<string, unknown>;
}

export interface PlannedTaskDependency {
  readonly taskId: PlannedTaskId;
  readonly dependsOnTaskId: PlannedTaskId;
  readonly relationship: "publishes" | "blocks";
  readonly required: boolean;
  readonly blocksParentCompletion: boolean;
}

export interface PrReviewFactoryInput {
  readonly tenantId: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly epoch: number;
  readonly needsExternalContext?: boolean;
}

export interface PrReviewFactoryPlan {
  readonly assemblyLine: AssemblyLineRef;
  readonly workOrderId: WorkOrderId;
  readonly factoryRunId: FactoryRunId;
  readonly epoch: number;
  readonly headSha: string;
  readonly tasks: readonly PlannedTask[];
  readonly dependencies: readonly PlannedTaskDependency[];
}

export function planPrReviewFactoryRun(input: PrReviewFactoryInput): PrReviewFactoryPlan {
  const subjectKey = `${input.tenantId}:${input.repository}:pr-${input.pullRequestNumber}:epoch-${input.epoch}`;
  const rootTaskId = entityId<"task">(`task_${subjectKey}:root`);
  const reviewTaskId = entityId<"task">(`task_${subjectKey}:review:general`);
  const publishTaskId = entityId<"task">(`task_${subjectKey}:publish`);

  return {
    assemblyLine: { slug: "pr_review", version: "2026-07-08" },
    workOrderId: entityId(`work_order_${subjectKey}`),
    factoryRunId: entityId(`factory_run_${subjectKey}`),
    epoch: input.epoch,
    headSha: input.headSha,
    tasks: [
      {
        id: rootTaskId,
        type: "pr_review",
        title: `Review ${input.repository}#${input.pullRequestNumber}`,
        assigneeRole: "factory",
        dedupeKey: `${subjectKey}:root`,
        required: true,
        metadata: {
          tenantId: input.tenantId,
          repository: input.repository,
          pullRequestNumber: input.pullRequestNumber,
          headSha: input.headSha
        }
      },
      {
        id: reviewTaskId,
        type: "review_pass",
        title: "General review pass",
        assigneeRole: "review_agent",
        dedupeKey: `${subjectKey}:review:general`,
        required: true,
        dispatchTopic: "run-review",
        parentTaskId: rootTaskId,
        metadata: {
          tenantId: input.tenantId,
          repository: input.repository,
          pullRequestNumber: input.pullRequestNumber,
          headSha: input.headSha,
          needsExternalContext: input.needsExternalContext ?? true
        }
      },
      {
        id: publishTaskId,
        type: "publish",
        title: "Publish review feedback",
        assigneeRole: "publisher",
        dedupeKey: `${subjectKey}:publish`,
        required: true,
        dispatchTopic: "run-publish",
        parentTaskId: rootTaskId,
        metadata: {
          tenantId: input.tenantId,
          repository: input.repository,
          pullRequestNumber: input.pullRequestNumber,
          headSha: input.headSha
        }
      }
    ],
    dependencies: [
      {
        taskId: publishTaskId,
        dependsOnTaskId: reviewTaskId,
        relationship: "blocks",
        required: true,
        blocksParentCompletion: true
      },
      {
        taskId: rootTaskId,
        dependsOnTaskId: publishTaskId,
        relationship: "publishes",
        required: true,
        blocksParentCompletion: true
      }
    ]
  };
}
