"use client";

import { useState } from "react";
import { TaskTypeInspector } from "../../components/task-types/task-type-inspector.tsx";
import { TaskTypeList } from "../../components/task-types/task-type-list.tsx";
import { WorkflowTreesPanel } from "../../components/task-types/workflow-trees.tsx";
import { usePoll } from "../../lib/poll.ts";
import { operationsApiUrl, tenantDashboardApiUrl } from "../../lib/operations-api.ts";
import type { OverviewResponse, TaskTypeDefinition } from "../../lib/types.ts";
import { useTenant } from "../../dashboard/providers.tsx";

export default function TaskTypesPage() {
  const { selected } = useTenant();
  const overviewPath = selected ? tenantDashboardApiUrl(selected.tenantId, "work-overview") : "";
  const taskTypesPath = selected ? operationsApiUrl(selected.tenantId, "task-types") : "";
  const { data: overview } = usePoll<OverviewResponse>(overviewPath);
  const { data: taskTypesData } = usePoll<readonly TaskTypeDefinition[]>(taskTypesPath);
  const [query, setQuery] = useState("");
  const [selectedType, setSelectedType] = useState<string | null>(null);

  const taskTypes = taskTypesData ?? [];
  const tasks = overview?.board.tasks ?? [];
  const search = query.trim().toLowerCase();
  const visibleTypes = taskTypes.filter(
    (definition) =>
      !search ||
      [definition.type, definition.description, definition.kind, definition.defaultAssigneeRole]
        .join(" ")
        .toLowerCase()
        .includes(search)
  );
  const effectiveSelectedType = visibleTypes.some((definition) => definition.type === selectedType)
    ? selectedType
    : (visibleTypes[0]?.type ?? null);
  const selectedDefinition = taskTypes.find((definition) => definition.type === effectiveSelectedType) ?? null;

  return (
    <section id="task-types-page">
      <header className="page-heading">
        <div>
          <h1>Task types</h1>
          <p>Reusable workflows for recurring work.</p>
        </div>
      </header>
      <div className="page-filters task-type-filters">
        <label className="search-control">
          <span aria-hidden="true">⌕</span>
          <input
            id="task-type-search"
            placeholder="Search task types…"
            aria-label="Search task types"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <div className="task-type-layout">
        <section className="task-panel" aria-labelledby="task-types-heading">
          <header className="type-table-head">
            <span>Task type</span>
            <span>Last run</span>
            <span>Success rate</span>
            <span>Steps</span>
          </header>
          <TaskTypeList
            definitions={visibleTypes}
            tasks={tasks}
            selectedType={effectiveSelectedType}
            onSelect={setSelectedType}
          />
          <footer className="panel-footer">
            <span className="task-count" id="task-type-count">
              {`Showing ${visibleTypes.length} of ${taskTypes.length} task types`}
            </span>
          </footer>
        </section>
        <TaskTypeInspector definition={selectedDefinition} />
      </div>
      <WorkflowTreesPanel definitions={taskTypes} />
    </section>
  );
}
