"use client";

import { humanize, relativeTime } from "../../lib/format.ts";
import { taskTypeIcon } from "../../lib/workflow-trees.ts";
import type { BoardTask, TaskTypeDefinition } from "../../lib/types.ts";

/** Task type table rows plus the per-type run metrics derived from board tasks. */

interface TaskTypeMetrics {
  readonly lastRun: string;
  readonly successRate: string;
  readonly steps: number;
}

function taskTypeMetrics(definition: TaskTypeDefinition, tasks: readonly BoardTask[]): TaskTypeMetrics {
  const runs = tasks
    .filter((task) => task.type === definition.type)
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  const finished = runs.filter((task) => ["done", "failed", "canceled"].includes(task.status));
  const successes = finished.filter((task) => task.status === "done").length;
  return {
    lastRun: runs[0] ? relativeTime(runs[0].updatedAt) : "Never",
    successRate: finished.length ? `${Math.round((successes / finished.length) * 100)}%` : "—",
    steps: Math.max(1, (definition.dependsOn ?? []).length + (definition.requiredBy ?? []).length + 1)
  };
}

export function TaskTypeList({
  definitions,
  tasks,
  selectedType,
  onSelect
}: {
  readonly definitions: readonly TaskTypeDefinition[];
  readonly tasks: readonly BoardTask[];
  readonly selectedType: string | null;
  readonly onSelect: (type: string) => void;
}) {
  return (
    <div className="task-list" id="task-type-list" aria-label="Task type list">
      {definitions.map((definition) => {
        const metrics = taskTypeMetrics(definition, tasks);
        return (
          <button
            key={definition.type}
            type="button"
            className={`type-row${definition.type === selectedType ? " selected" : ""}`}
            data-task-type={definition.type}
            onClick={() => onSelect(definition.type)}
          >
            <div className="type-copy">
              <span className="type-icon">{taskTypeIcon(definition.type)}</span>
              <span className="type-copy-text">
                <span className="type-name">{humanize(definition.type)}</span>
                <span className="type-description">{definition.description}</span>
              </span>
              <span className="enabled-state">Enabled</span>
            </div>
            <span className="type-metric">{metrics.lastRun}</span>
            <span className="type-metric">{metrics.successRate}</span>
            <span className="type-metric type-steps">{`${metrics.steps}  ›`}</span>
          </button>
        );
      })}
    </div>
  );
}
