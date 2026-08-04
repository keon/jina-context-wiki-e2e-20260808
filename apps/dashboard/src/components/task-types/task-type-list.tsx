"use client";

import { humanize, relativeTime } from "../../lib/format.ts";
import type { BoardTask, TaskTypeDefinition } from "../../lib/types.ts";
import { TaskTypeGlyph } from "./task-type-glyph.tsx";

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
            className={`task-type-row${definition.type === selectedType ? " selected" : ""}`}
            data-task-type={definition.type}
            aria-pressed={definition.type === selectedType}
            onClick={() => onSelect(definition.type)}
          >
            <div className="task-type-row__identity">
              <span className="task-type-glyph">
                <TaskTypeGlyph type={definition.type} kind={definition.kind} />
              </span>
              <span className="task-type-row__copy">
                <span className="task-type-row__title-line">
                  <strong>{humanize(definition.type)}</strong>
                  <span className="enabled-state">Enabled</span>
                </span>
                <span className="task-type-row__description">{definition.description}</span>
              </span>
            </div>
            <span className="task-type-row__metric" data-label="Last run">
              {metrics.lastRun}
            </span>
            <span className="task-type-row__metric" data-label="Success rate">
              {metrics.successRate}
            </span>
            <span className="task-type-row__metric task-type-row__steps" data-label="Steps">
              <span>{metrics.steps}</span>
              <span aria-hidden="true">›</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
