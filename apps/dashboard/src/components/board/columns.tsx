"use client";

import { ALWAYS_VISIBLE_COLUMNS, BOARD_COLUMN_STATUSES } from "../../lib/board.ts";
import { humanize, relativeTime } from "../../lib/format.ts";
import type { BoardTask } from "../../lib/types.ts";

function TaskCard({ task, onOpen }: { readonly task: BoardTask; readonly onOpen: (taskId: string) => void }) {
  const repository = typeof task.metadata?.repository === "string" ? task.metadata.repository : "No repository";
  const summary = typeof task.metadata?.summary === "string" ? task.metadata.summary : null;
  const owner = task.assigneeRole ? humanize(task.assigneeRole) : "Unassigned";

  return (
    <button
      type="button"
      className={`agent-task-card agent-task-card--${task.status}`}
      data-task-id={task.id}
      aria-label={`Open task: ${task.title}, ${humanize(task.status)}`}
      onClick={() => onOpen(task.id)}
    >
      <span className="agent-task-card__head">
        <strong>{task.title}</strong>
        <span className={`agent-task-card__status agent-task-card__status--${task.status}`}>
          {humanize(task.status)}
        </span>
      </span>
      <span className="agent-task-card__repo">
        <BranchIcon />
        <span>{repository}</span>
      </span>
      {summary ? <span className="agent-task-card__summary">{summary}</span> : null}
      <span className="agent-task-card__footer">
        <span>{relativeTime(task.updatedAt ?? task.createdAt)}</span>
        <span>{owner}</span>
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
    <section className="agent-board-columns" id="columns" aria-label="Task board">
      {BOARD_COLUMN_STATUSES.map((status) => {
        const items = tasks.filter((task) => task.status === status);
        if (items.length === 0 && !ALWAYS_VISIBLE_COLUMNS.includes(status)) return null;
        return (
          <section className={`agent-board-column agent-board-column--${status}`} key={status}>
            <header className="agent-board-column__head">
              <span className={`agent-board-column__icon agent-board-column__icon--${status}`} aria-hidden="true">
                <StatusIcon status={status} />
              </span>
              <h2>{humanize(status)}</h2>
              <span className="agent-board-column__count">{items.length}</span>
            </header>
            <div className="agent-board-column__cards">
              {items.length === 0 ? <p className="agent-board-column__empty">No tasks</p> : null}
              {items.map((task) => (
                <TaskCard task={task} onOpen={onOpenTask} key={task.id} />
              ))}
            </div>
          </section>
        );
      })}
    </section>
  );
}

function BranchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4" cy="3" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="4" cy="13" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="12" cy="5.25" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M4 4.5v7M5.5 10.25h1.25A5.25 5.25 0 0 0 12 5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function StatusIcon({ status }: { readonly status: string }) {
  if (status === "done") {
    return (
      <svg viewBox="0 0 16 16" fill="none">
        <path
          d="m3.25 8.25 3 3 6.5-6.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (status === "in_progress") {
    return (
      <svg viewBox="0 0 16 16" fill="none">
        <path d="m6 4.25 5 3.75-5 3.75z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "queued") {
    return (
      <svg viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.2" />
        <path
          d="M8 5v3.25l2 1.25"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (status === "failed" || status === "canceled") {
    return (
      <svg viewBox="0 0 16 16" fill="none">
        <path d="m4.5 4.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "blocked") {
    return (
      <svg viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.2" />
        <path d="M5 8h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none">
      <circle cx="5" cy="5" r="1.25" fill="currentColor" />
      <circle cx="11" cy="5" r="1.25" fill="currentColor" />
      <circle cx="5" cy="11" r="1.25" fill="currentColor" />
      <circle cx="11" cy="11" r="1.25" fill="currentColor" />
    </svg>
  );
}
