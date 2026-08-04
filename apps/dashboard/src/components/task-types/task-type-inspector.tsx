"use client";

import { humanize } from "../../lib/format.ts";
import { workflowSteps } from "../../lib/workflow-trees.ts";
import type { TaskTypeDefinition } from "../../lib/types.ts";
import { TaskTypeGlyph } from "./task-type-glyph.tsx";

/** Read-only side inspector describing a task type's trigger, steps, and configuration. */

export function TaskTypeInspector({ definition }: { readonly definition: TaskTypeDefinition | null }) {
  if (!definition) {
    return (
      <aside className="task-type-detail" id="task-type-details" aria-live="polite">
        <div className="task-type-detail__empty">
          <strong>No task type selected</strong>
          <p>Select a task type to inspect its workflow.</p>
        </div>
      </aside>
    );
  }
  const trigger = (definition.triggeredBy ?? [])[0];
  const configuration: readonly (readonly [string, string])[] = [
    ["Execution", definition.dispatchTopic ? "Dispatched" : "Coordinator managed"],
    ...(definition.dispatchTopic ? ([["Dispatch topic", definition.dispatchTopic]] as const) : []),
    ["Assignee", definition.defaultAssigneeRole ? humanize(definition.defaultAssigneeRole) : "System"],
    ["Task kind", humanize(definition.kind)]
  ];
  return (
    <aside className="task-type-detail" id="task-type-details" aria-live="polite">
      <header className="task-type-detail__header">
        <div className="task-type-detail__identity">
          <span className="task-type-glyph task-type-glyph--large">
            <TaskTypeGlyph type={definition.type} kind={definition.kind} />
          </span>
          <div>
            <h2>{humanize(definition.type)}</h2>
            <span className="enabled-state">Enabled</span>
          </div>
        </div>
        <p>{definition.description}</p>
      </header>
      <section className="task-type-detail__section">
        <span className="task-type-detail__label">Trigger</span>
        <div className="task-type-trigger">
          <span className="task-type-trigger__icon" aria-hidden="true">
            <svg viewBox="0 0 20 20">
              <path d="m11.5 2-6 9h4l-1 7 6-9h-4l1-7Z" />
            </svg>
          </span>
          <div>
            <strong>{trigger ? humanize(trigger.source) : "Workflow"}</strong>
            <p>
              {trigger
                ? trigger.description || humanize(trigger.source)
                : "Created manually or by an upstream workflow."}
            </p>
          </div>
        </div>
      </section>
      <section className="task-type-detail__section">
        <span className="task-type-detail__label">Workflow steps</span>
        <ol className="task-type-steps">
          {workflowSteps(definition).map((step, index) => (
            <li key={`${index}-${step}`}>
              <span>{index + 1}</span>
              <p>{step}</p>
            </li>
          ))}
        </ol>
      </section>
      <section className="task-type-detail__section">
        <span className="task-type-detail__label">Configuration</span>
        <dl className="task-type-configuration">
          {configuration.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </aside>
  );
}
