"use client";

import { useMemo, useState } from "react";
import { TaskTypeInspector } from "../../components/task-types/task-type-inspector.tsx";
import { TaskTypeList } from "../../components/task-types/task-type-list.tsx";
import { usePoll } from "../../lib/poll.ts";
import { operationsApiUrl, tenantDashboardApiUrl } from "../../lib/operations-api.ts";
import type { BoardTask, OverviewResponse, TaskTypeDefinition } from "../../lib/types.ts";
import { useTenant } from "../../dashboard/providers.tsx";

const NO_TASKS: readonly BoardTask[] = [];
const NO_TASK_TYPES: readonly TaskTypeDefinition[] = [];

export default function TaskTypesPage() {
  const { selected } = useTenant();
  const overviewPath = selected ? tenantDashboardApiUrl(selected.tenantId, "work-overview") : "";
  const taskTypesPath = selected ? operationsApiUrl(selected.tenantId, "task-types") : "";
  const { data: overview } = usePoll<OverviewResponse>(overviewPath);
  const {
    data: taskTypesData,
    online: taskTypesOnline,
    refresh: refreshTaskTypes
  } = usePoll<readonly TaskTypeDefinition[]>(taskTypesPath);
  const [query, setQuery] = useState("");
  const [selectedType, setSelectedType] = useState<string | null>(null);

  const taskTypes = taskTypesData ?? NO_TASK_TYPES;
  // `?.board?.` rather than `?.board.`: a 200 whose body does not carry a board
  // is not a board with no tasks, but it must not be a blank page either — the
  // dereference threw and took the whole route down. /board already reads the
  // same payload this way.
  const tasks = overview?.board?.tasks ?? NO_TASKS;
  // `data === undefined` before any completed request is "not loaded", and a
  // failed endpoint is an error — neither is "no task types match this search".
  const status = taskTypesData !== undefined ? "ready" : taskTypesOnline === false ? "unavailable" : "loading";

  const visibleTypes = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return taskTypes;
    return taskTypes.filter((definition) =>
      [definition.type, definition.description, definition.kind, definition.defaultAssigneeRole]
        .join(" ")
        .toLowerCase()
        .includes(search)
    );
  }, [taskTypes, query]);

  const effectiveSelectedType = visibleTypes.some((definition) => definition.type === selectedType)
    ? selectedType
    : (visibleTypes[0]?.type ?? null);
  const selectedDefinition = taskTypes.find((definition) => definition.type === effectiveSelectedType) ?? null;

  // With no workspace resolved neither endpoint is polled, so both stay
  // undefined and the status ternary above would read as "loading" forever.
  if (!selected) {
    return (
      <div className="page-placeholder" role="status">
        <h1 className="sr-only">Task types</h1>
        <strong>No workspace selected</strong>
        <p>Select a workspace from the sidebar to read its task types.</p>
      </div>
    );
  }

  return (
    <section className="task-types-page" id="task-types-page">
      <header className="page-heading">
        <div>
          <h1>Task types</h1>
          <p>Reusable workflows for recurring work.</p>
        </div>
      </header>
      <div className="task-types-toolbar">
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
        <span>
          {status === "loading"
            ? "Loading task types…"
            : status === "unavailable"
              ? "Task types unavailable"
              : `${visibleTypes.length} of ${taskTypes.length} task types`}
        </span>
      </div>
      <div className="task-types-layout">
        <section className="task-types-list-panel" aria-labelledby="task-types-heading">
          <h2 className="sr-only" id="task-types-heading">
            Task types
          </h2>
          <header className="task-types-table-head" aria-hidden="true">
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
          {visibleTypes.length === 0 ? (
            <p className="task-types-empty" aria-busy={status === "loading" || undefined}>
              {status === "loading" ? (
                "Loading task types…"
              ) : status === "unavailable" ? (
                <>
                  Task types could not be loaded — the workspace service could not be reached.{" "}
                  <button type="button" className="knowledge-button" onClick={() => void refreshTaskTypes()}>
                    Retry
                  </button>
                </>
              ) : taskTypes.length === 0 ? (
                "No task types are defined for this workspace yet."
              ) : (
                "No task types match this search."
              )}
            </p>
          ) : null}
        </section>
        <TaskTypeInspector definition={selectedDefinition} />
      </div>
    </section>
  );
}
