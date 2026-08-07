"use client";

import { Fragment, useEffect, useMemo, useRef } from "react";
import { taskRelationships } from "../../lib/board.ts";
import { eventLabel, formatTime, formatValue, humanize, shortId } from "../../lib/format.ts";
import type { BoardEvent, BoardState, BoardTask } from "../../lib/types.ts";

interface TaskFact {
  label: string;
  value: string;
  status?: BoardTask["status"];
}

function taskFacts(task: BoardTask): TaskFact[] {
  const workspace = typeof task.metadata?.workspaceLabel === "string" ? task.metadata.workspaceLabel : "—";
  const author = typeof task.metadata?.authorLogin === "string" ? `@${task.metadata.authorLogin}` : "—";
  return [
    { label: "Status", value: humanize(task.status), status: task.status },
    // `assigneeRole` is optional; humanizing it unguarded rendered the literal
    // string "Undefined" where every sibling field uses the absence sentinel.
    { label: "Assignee", value: task.assigneeRole ? humanize(task.assigneeRole) : "—" },
    { label: "Attempt", value: String(task.attempt) },
    { label: "Epoch", value: task.epoch === undefined ? "—" : String(task.epoch) },
    { label: "Workspace", value: workspace },
    { label: "PR author", value: author },
    { label: "Created", value: formatTime(task.createdAt) },
    { label: "Updated", value: formatTime(task.updatedAt) }
  ];
}

function Overview({ task }: { readonly task: BoardTask }) {
  const summary = typeof task.metadata?.summary === "string" ? task.metadata.summary : null;
  return (
    <section className="task-detail__section" aria-labelledby="task-overview-title">
      <h3 id="task-overview-title">Overview</h3>
      {summary ? <p className="task-detail__summary">{summary}</p> : null}
      <dl className="task-detail__facts">
        {taskFacts(task).map((fact) => (
          <div className="task-detail__fact" key={fact.label}>
            <dt>{fact.label}</dt>
            <dd className={fact.status ? `task-detail__status task-detail__status--${fact.status}` : undefined}>
              {fact.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Relationships({
  task,
  board,
  onOpenTask
}: {
  readonly task: BoardTask;
  readonly board: BoardState;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const relationships = taskRelationships(task, board);
  return (
    <section className="task-detail__section" aria-labelledby="task-relationships-title">
      <h3 id="task-relationships-title">Relationships</h3>
      {relationships.length === 0 ? (
        <p className="task-detail__empty">No task relationships.</p>
      ) : (
        <div className="task-detail__relationships">
          {relationships.map((relationship, index) => {
            const related = board.tasks.find((item) => item.id === relationship.taskId);
            return (
              <button
                type="button"
                className="task-detail__relationship"
                key={`${index}-${relationship.direction}-${relationship.taskId}`}
                onClick={() => onOpenTask(relationship.taskId)}
              >
                <span className="task-detail__relationship-copy">
                  <small>{humanize(relationship.direction)}</small>
                  <strong>{related ? related.title : shortId(relationship.taskId)}</strong>
                </span>
                <span className="task-detail__relationship-meta">
                  {humanize(relationship.relationship)}
                  {relationship.required ? " · Required" : ""}
                </span>
                <span aria-hidden="true">›</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function TechnicalDetails({ task }: { readonly task: BoardTask }) {
  const entries: (readonly [string, unknown])[] = [
    ["Task ID", task.id],
    ["Dedupe key", task.dedupeKey || "—"],
    ["Required", task.required === undefined ? "—" : task.required],
    ["Dispatch topic", task.dispatchTopic || "—"],
    ...Object.entries(task.metadata ?? {})
      .filter(([key]) => key !== "summary")
      .sort((left, right) => left[0].localeCompare(right[0]))
  ];

  return (
    <details className="task-detail__technical">
      <summary>Technical details</summary>
      <dl>
        {entries.map(([label, value], index) => (
          <Fragment key={`${index}-${label}`}>
            <dt>{humanize(label)}</dt>
            <dd>
              {typeof value === "string" && value.startsWith("https://") ? (
                <a href={value} target="_blank" rel="noreferrer">
                  {value}
                </a>
              ) : (
                formatValue(value)
              )}
            </dd>
          </Fragment>
        ))}
      </dl>
    </details>
  );
}

function Activity({ task, events }: { readonly task: BoardTask; readonly events: readonly BoardEvent[] }) {
  const taskEvents = useMemo(
    () =>
      events
        .filter((event) => event.taskId === task.id)
        .slice()
        .reverse(),
    [events, task.id]
  );
  return (
    <section className="task-detail__section" aria-labelledby="task-activity-title">
      <h3 id="task-activity-title">Activity</h3>
      {taskEvents.length === 0 ? <p className="task-detail__empty">No activity recorded.</p> : null}
      <div className="task-detail__timeline">
        {taskEvents.map((event) => (
          <article className="task-detail__event" key={event.id}>
            <div>
              <strong>{eventLabel(event)}</strong>
              <time>{formatTime(event.at)}</time>
            </div>
            {event.payload && Object.keys(event.payload).length > 0 ? (
              <pre>{JSON.stringify(event.payload, null, 2)}</pre>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

export function TaskDialog({
  task,
  board,
  events,
  onOpenTask,
  onClose
}: {
  readonly task: BoardTask | null;
  readonly board: BoardState;
  readonly events: readonly BoardEvent[];
  readonly onOpenTask: (taskId: string) => void;
  readonly onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (task && !dialog.open) dialog.showModal();
    if (!task && dialog.open) dialog.close();
  }, [task]);

  return (
    <dialog
      id="task-dialog"
      className="task-detail"
      aria-labelledby="task-detail-title"
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header className="task-detail__header">
        <div>
          <p>{task ? `${humanize(task.type)} · ${shortId(task.id)}` : "Task details"}</p>
          <h2 id="task-detail-title">{task?.title ?? ""}</h2>
        </div>
        <button type="button" className="task-detail__close" aria-label="Close task details" onClick={onClose}>
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      <div className="task-detail__body">
        {task ? (
          <>
            <Overview task={task} />
            <Relationships task={task} board={board} onOpenTask={onOpenTask} />
            <TechnicalDetails task={task} />
            <Activity task={task} events={events} />
          </>
        ) : null}
      </div>
    </dialog>
  );
}
