"use client";

import { ALWAYS_VISIBLE_COLUMNS, BOARD_COLUMN_STATUSES } from "../../lib/board.ts";
import { humanize } from "../../lib/format.ts";
import type { BoardTask } from "../../lib/types.ts";

function TaskCard({ task, onOpen }: { readonly task: BoardTask; readonly onOpen: (taskId: string) => void }) {
  const workspace = typeof task.metadata?.workspaceLabel === "string" ? task.metadata.workspaceLabel : undefined;
  const author = typeof task.metadata?.authorLogin === "string" ? task.metadata.authorLogin : undefined;
  return (
    <button
      type="button"
      className={task.status === "superseded" ? "card superseded" : "card"}
      data-task-id={task.id}
      aria-label={`Open task: ${task.title}, epoch ${task.epoch ?? "none"}`}
      onClick={() => onOpen(task.id)}
    >
      <span className="card-title">{task.title}</span>
      <span className="card-meta">
        <span className="chip">{humanize(task.type)}</span>
        <span className="chip">epoch {task.epoch ?? "–"}</span>
        <span className="chip">attempt {task.attempt}</span>
        {workspace ? <span className="chip">{workspace}</span> : null}
        {author ? <span className="chip">@{author}</span> : null}
      </span>
    </button>
  );
}

export function BoardColumns({
  tasks,
  onOpenTask
}: {
  readonly tasks: readonly BoardTask[];
  readonly onOpenTask: (taskId: string) => void;
}) {
  return (
    <section className="columns" id="columns" aria-label="Task board">
      {BOARD_COLUMN_STATUSES.map((status) => {
        const items = tasks.filter((task) => task.status === status);
        if (items.length === 0 && !ALWAYS_VISIBLE_COLUMNS.includes(status)) return null;
        return (
          <section className="column" key={status}>
            <h2>
              {humanize(status)}
              <span className="count">{items.length}</span>
            </h2>
            {items.length === 0 ? <div className="empty">No tasks</div> : null}
            {items.map((task) => (
              <TaskCard task={task} onOpen={onOpenTask} key={task.id} />
            ))}
          </section>
        );
      })}
    </section>
  );
}
