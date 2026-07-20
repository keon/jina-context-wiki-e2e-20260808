export interface PersistedRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskRecord extends PersistedRecord {
  readonly rootTaskId: string;
  readonly assigneeRole: string;
  readonly status: string;
}

export interface TaskDependencyRecord {
  readonly taskId: string;
  readonly dependsOnTaskId: string;
}
