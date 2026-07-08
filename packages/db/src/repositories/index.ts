import type { TaskRecord } from "../schema/index.js";

export interface TaskRepository {
  create(task: TaskRecord): Promise<TaskRecord>;
  findById(taskId: string): Promise<TaskRecord | null>;
  updateStatus(taskId: string, status: TaskRecord["status"]): Promise<TaskRecord>;
}

export interface UnitOfWork {
  readonly tasks: TaskRepository;
}
