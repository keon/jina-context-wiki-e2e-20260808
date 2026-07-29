"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BoardColumns } from "../components/board/columns.tsx";
import { TaskDialog } from "../components/board/task-dialog.tsx";
import { BoardToolbar } from "../components/board/toolbar.tsx";
import type { BoardFilters } from "../lib/board.ts";
import { EMPTY_BOARD_FILTERS, filterBoardTasks, partitionBoardTasks, uniqueValues } from "../lib/board.ts";
import { usePoll } from "../lib/poll.ts";
import type { BoardState, OverviewResponse } from "../lib/types.ts";

const EMPTY_BOARD: BoardState = { tasks: [], dependencies: [] };

/** Reads the task selected via the URL hash: `#task=<encodeURIComponent id>`. */
function taskIdFromHash(): string | null {
  const match = /^#task=(.+)$/.exec(window.location.hash);
  const encoded = match?.[1];
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

export default function BoardPage() {
  const { data } = usePoll<OverviewResponse>("/api/overview");
  const board = data?.board ?? EMPTY_BOARD;
  const events = data?.events ?? [];

  const [filters, setFilters] = useState<BoardFilters>(EMPTY_BOARD_FILTERS);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const partition = useMemo(() => partitionBoardTasks(board.tasks), [board.tasks]);
  const options = useMemo(
    () => ({
      repository: uniqueValues(partition.current.map((task) => task.metadata?.repository)),
      owner: uniqueValues(partition.current.map((task) => task.assigneeRole)),
      type: uniqueValues(partition.current.map((task) => task.type)),
      status: uniqueValues(partition.current.map((task) => task.status))
    }),
    [partition]
  );

  // Selects keep their value only while it is still present in the current
  // options; otherwise they fall back to "All" (mirrors populateSelect).
  const effectiveFilters: BoardFilters = {
    query: filters.query,
    repository: options.repository.includes(filters.repository) ? filters.repository : "",
    owner: options.owner.includes(filters.owner) ? filters.owner : "",
    type: options.type.includes(filters.type) ? filters.type : "",
    status: options.status.includes(filters.status) ? filters.status : ""
  };
  useEffect(() => {
    setFilters((previous) => {
      const next: BoardFilters = {
        query: previous.query,
        repository: options.repository.includes(previous.repository) ? previous.repository : "",
        owner: options.owner.includes(previous.owner) ? previous.owner : "",
        type: options.type.includes(previous.type) ? previous.type : "",
        status: options.status.includes(previous.status) ? previous.status : ""
      };
      const unchanged =
        next.repository === previous.repository &&
        next.owner === previous.owner &&
        next.type === previous.type &&
        next.status === previous.status;
      return unchanged ? previous : next;
    });
  }, [options]);

  // Selection is hash-based so the back button closes/reopens the dialog.
  useEffect(() => {
    const readHash = () => setSelectedTaskId(taskIdFromHash());
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, []);

  const openTask = useCallback((taskId: string) => {
    window.location.hash = `task=${encodeURIComponent(taskId)}`;
    setSelectedTaskId(taskId);
  }, []);
  const closeTask = useCallback(() => {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    setSelectedTaskId(null);
  }, []);

  const setFilter = useCallback((field: keyof BoardFilters, value: string) => {
    setFilters((previous) => ({ ...previous, [field]: value }));
  }, []);

  const visibleTasks = filterBoardTasks(partition.current, effectiveFilters);
  const selectedTask = selectedTaskId ? (board.tasks.find((task) => task.id === selectedTaskId) ?? null) : null;

  return (
    <>
      <section id="board-page">
        <header className="page-heading">
          <div>
            <h1>Board</h1>
            <p>Live operational work across repositories and workflows.</p>
          </div>
        </header>
        <BoardToolbar filters={effectiveFilters} options={options} onFilterChange={setFilter} />
        <BoardColumns tasks={visibleTasks} onOpenTask={openTask} />
      </section>
      <TaskDialog task={selectedTask} board={board} events={events} onOpenTask={openTask} onClose={closeTask} />
    </>
  );
}
