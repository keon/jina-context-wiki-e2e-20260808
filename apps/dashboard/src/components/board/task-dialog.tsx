"use client";

import { Fragment, useEffect, useRef } from "react";
import { eventLabel, formatTime, formatValue, humanize, shortId } from "../../lib/format.ts";
import type { BoardEvent, BoardState, BoardTask } from "../../lib/types.ts";

interface TaskRelationship {
  readonly direction: string;
  readonly taskId: string;
  readonly relationship: string;
  readonly required?: boolean | undefined;
}

function taskRelationships(task: BoardTask, board: BoardState): readonly TaskRelationship[] {
  const relationships: TaskRelationship[] = [];
  if (task.parentTaskId) {
    relationships.push({ direction: "Parent", taskId: task.parentTaskId, relationship: "parent" });
  }
  for (const child of board.tasks.filter((item) => item.parentTaskId === task.id)) {
    relationships.push({ direction: "Child", taskId: child.id, relationship: "child" });
  }
  for (const dependency of board.dependencies) {
    if (dependency.taskId === task.id) {
      relationships.push({
        direction: "Depends on",
        taskId: dependency.dependsOnTaskId,
        relationship: dependency.relationship,
        required: dependency.required
      });
    }
    if (dependency.dependsOnTaskId === task.id) {
      relationships.push({
        direction: "Required by",
        taskId: dependency.taskId,
        relationship: dependency.relationship,
        required: dependency.required
      });
    }
  }
  return relationships;
}

function SummaryItem({
  label,
  value,
  valueClass
}: {
  readonly label: string;
  readonly value: string;
  readonly valueClass?: string;
}) {
  return (
    <div className="summary-item">
      <span className="label">{label}</span>
      <span className={valueClass ?? "value"}>{value}</span>
    </div>
  );
}

function Summary({ task }: { readonly task: BoardTask }) {
  const workspace = typeof task.metadata?.workspaceLabel === "string" ? task.metadata.workspaceLabel : "–";
  const author = typeof task.metadata?.authorLogin === "string" ? `@${task.metadata.authorLogin}` : "–";
  return (
    <section className="summary-grid">
      <SummaryItem label="Status" value={humanize(task.status)} valueClass={`status status-${task.status}`} />
      <SummaryItem label="Assignee" value={humanize(task.assigneeRole)} />
      <SummaryItem label="Attempt" value={String(task.attempt)} />
      <SummaryItem label="Epoch" value={String(task.epoch ?? "–")} />
      <SummaryItem label="Workspace" value={workspace} />
      <SummaryItem label="PR author" value={author} />
      <SummaryItem label="Created" value={formatTime(task.createdAt)} />
      <SummaryItem label="Updated" value={formatTime(task.updatedAt)} />
    </section>
  );
}

function RelationshipSection({
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
    <section className="section">
      <h3>Dependencies &amp; relationships</h3>
      <div className="relationship-list">
        {relationships.length === 0 ? <p className="empty-detail">No task relationships.</p> : null}
        {relationships.map((relationship, index) => {
          const related = board.tasks.find((item) => item.id === relationship.taskId);
          return (
            <button
              type="button"
              className="relationship"
              data-task-id={relationship.taskId}
              key={`${index}-${relationship.direction}-${relationship.taskId}`}
              onClick={() => onOpenTask(relationship.taskId)}
            >
              <span className="relation-direction">{relationship.direction}</span>
              <span className="relation-title">{related ? related.title : shortId(relationship.taskId)}</span>
              <span className="relation-type">
                {relationship.relationship + (relationship.required ? " · required" : "")}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function MetadataSection({ task }: { readonly task: BoardTask }) {
  const entries: (readonly [string, unknown])[] = [
    ["Task ID", task.id],
    ["Dedupe key", task.dedupeKey],
    ["Required", String(task.required)],
    ["Dispatch topic", task.dispatchTopic || "–"]
  ];
  entries.push(...Object.entries(task.metadata ?? {}).sort((left, right) => left[0].localeCompare(right[0])));
  return (
    <section className="section">
      <h3>Metadata</h3>
      <dl className="metadata">
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
    </section>
  );
}

function ActivitySection({ task, events }: { readonly task: BoardTask; readonly events: readonly BoardEvent[] }) {
  const taskEvents = events
    .filter((event) => event.taskId === task.id)
    .slice()
    .reverse();
  return (
    <section className="section">
      <h3>Comments &amp; activity</h3>
      <div className="timeline">
        {taskEvents.length === 0 ? <p className="empty-detail">No comments or activity recorded.</p> : null}
        {taskEvents.map((event) => (
          <article className="event" key={event.id}>
            <div className="event-top">
              <span className="event-type">{eventLabel(event)}</span>
              <time className="event-time">{formatTime(event.at)}</time>
            </div>
            {event.payload && Object.keys(event.payload).length > 0 ? (
              <pre className="event-payload">{JSON.stringify(event.payload, null, 2)}</pre>
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

  // The dialog opens non-modally, and the stylesheet keys the inspector
  // layout off body.has-task-inspector while a task is selected.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (task) {
      document.body.classList.add("has-task-inspector");
      if (!dialog.open) dialog.show();
    } else {
      if (dialog.open) dialog.close();
      document.body.classList.remove("has-task-inspector");
    }
  }, [task]);
  useEffect(() => () => document.body.classList.remove("has-task-inspector"), []);

  return (
    <dialog
      id="task-dialog"
      aria-labelledby="detail-title"
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header className="detail-header">
        <div>
          <p className="eyebrow" id="detail-eyebrow">
            {task ? `${humanize(task.type)} · ${shortId(task.id)}` : "Task details"}
          </p>
          <h2 className="detail-title" id="detail-title">
            {task ? task.title : ""}
          </h2>
        </div>
        <button type="button" className="close" id="close-detail" aria-label="Close task details" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="detail-body" id="detail-body">
        {task ? (
          <>
            <Summary task={task} />
            <RelationshipSection task={task} board={board} onOpenTask={onOpenTask} />
            <MetadataSection task={task} />
            <ActivitySection task={task} events={events} />
          </>
        ) : null}
      </div>
    </dialog>
  );
}
