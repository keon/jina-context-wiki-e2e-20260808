"use client";

import { humanize } from "../../lib/format.ts";
import { taskTypeIcon, workflowSteps } from "../../lib/workflow-trees.ts";
import type { TaskTypeDefinition } from "../../lib/types.ts";

/** Read-only side inspector describing a task type's trigger, steps, and configuration. */

export function TaskTypeInspector({ definition }: { readonly definition: TaskTypeDefinition | null }) {
  if (!definition) {
    return (
      <aside className="side-inspector task-type-inspector" id="task-type-details" aria-live="polite">
        <p className="inspector-empty">Select a task type to inspect its workflow.</p>
      </aside>
    );
  }
  const trigger = (definition.triggeredBy ?? [])[0];
  const configuration: readonly (readonly [string, string])[] = [
    ["Execution", definition.dispatchTopic || "Coordinator managed"],
    ["Assignee", humanize(definition.defaultAssigneeRole)],
    ["Task kind", humanize(definition.kind)]
  ];
  return (
    <aside className="side-inspector task-type-inspector" id="task-type-details" aria-live="polite">
      <header className="inspector-heading task-type-heading">
        <div className="inspector-title-row">
          <span className="type-icon">{taskTypeIcon(definition.type)}</span>
          <strong>{humanize(definition.type)}</strong>
        </div>
        <span className="enabled-state">Enabled</span>
      </header>
      <section className="inspector-section">
        <h3>Trigger</h3>
        <div className="trigger-card">
          <span className="trigger-icon">⌘</span>
          <span>
            {trigger ? trigger.description || humanize(trigger.source) : "Created manually or by an upstream workflow"}
          </span>
          <span>⌄</span>
        </div>
      </section>
      <section className="inspector-section">
        <h3>Workflow steps</h3>
        <div className="workflow-step-list">
          {workflowSteps(definition).map((step, index) => (
            <div className="workflow-step" key={`${index}-${step}`}>
              <span className="step-handle">⠿</span>
              <span className="step-number">{index + 1}</span>
              <span className="step-copy">{step}</span>
              <span className="step-arrow">›</span>
            </div>
          ))}
        </div>
      </section>
      <section className="inspector-section configuration-list">
        <h3>Configuration</h3>
        {configuration.map(([label, value]) => (
          <div className="configuration-row" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </section>
    </aside>
  );
}
