"use client";

import { humanize } from "../../lib/format.ts";
import { buildWorkflowTrees } from "../../lib/workflow-trees.ts";
import type { WorkflowEdge, WorkflowTreeNode } from "../../lib/workflow-trees.ts";
import type { TaskTypeDefinition, TaskTypeTrigger } from "../../lib/types.ts";

/** Workflow dependency tree cards, ported from the old dashboard's renderWorkflowTrees. */

function WorkflowTriggerCard({ trigger }: { readonly trigger: TaskTypeTrigger }) {
  const conditions = trigger.conditions ?? [];
  return (
    <div className="workflow-trigger">
      <strong>Triggered by</strong>
      <span className="workflow-trigger-source">{trigger.source}</span>
      <span className="workflow-trigger-description">{trigger.description}</span>
      {conditions.length ? <span className="workflow-connector-condition">{conditions.join("; ")}</span> : null}
    </div>
  );
}

function WorkflowConnector({ edge }: { readonly edge: WorkflowEdge }) {
  const details: string[] = [];
  if (edge.relationships.length) details.push(edge.relationships.map(humanize).join(" + "));
  details.push(edge.required ? "required" : "optional");
  const condition = edge.conditions.join("; ");
  return (
    <div className="workflow-connector">
      <strong>↓ unblocks</strong>
      <span>{details.join(" · ")}</span>
      {edge.conditions.length ? (
        <span className="workflow-connector-condition">
          {/^when\b/i.test(condition) ? condition : `when ${condition}`}
        </span>
      ) : null}
    </div>
  );
}

function WorkflowBranch({
  node,
  incomingEdge
}: {
  readonly node: WorkflowTreeNode;
  readonly incomingEdge: WorkflowEdge | null;
}) {
  return (
    <li className="workflow-branch">
      {(node.definition.triggeredBy ?? []).map((trigger, index) => (
        <WorkflowTriggerCard trigger={trigger} key={`${index}-${trigger.source}`} />
      ))}
      {incomingEdge ? <WorkflowConnector edge={incomingEdge} /> : null}
      <div className={`workflow-node${node.definition.kind === "aggregate" ? " aggregate" : ""}`}>
        <div className="workflow-node-top">
          <span className="workflow-node-name">{node.type}</span>
          <span className="workflow-node-badge">
            {node.definition.kind === "aggregate" && node.children.length === 0
              ? "completes workflow"
              : humanize(node.definition.kind)}
          </span>
        </div>
        <span className="workflow-node-description">{node.definition.description}</span>
        {node.collapsedDependencies.length ? (
          <span className="workflow-node-gates">
            {`Also directly waits for: ${node.collapsedDependencies.map((edge) => edge.from).join(", ")}`}
          </span>
        ) : null}
        {node.cycle ? <span className="workflow-node-gates">Cycle detected; branch stopped.</span> : null}
      </div>
      {node.children.length ? (
        <ol className="workflow-children">
          {node.children.map((child, index) => (
            <WorkflowBranch node={child.node} incomingEdge={child.edge} key={`${index}-${child.node.type}`} />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

export function WorkflowTreesPanel({ definitions }: { readonly definitions: readonly TaskTypeDefinition[] }) {
  const workflows = buildWorkflowTrees(definitions);
  return (
    <section className="workflow-panel" aria-labelledby="workflow-trees-heading" hidden>
      <header className="task-panel-header">
        <h2 id="workflow-trees-heading">Workflow dependency trees</h2>
        <span className="task-count" id="workflow-count">
          {`${workflows.length} ${workflows.length === 1 ? "workflow" : "workflows"}`}
        </span>
      </header>
      <p className="workflow-help">
        Read top to bottom: completing a prerequisite unblocks the waiting task below it; task creation triggers are
        shown separately. Conditional connectors apply only when their condition is true, and aggregate tasks close
        after all required work completes.
      </p>
      <div className="workflow-grid" id="workflow-tree-list" aria-label="Task dependency trees">
        {workflows.length === 0 ? <p className="workflow-empty">No workflow dependencies are declared.</p> : null}
        {workflows.map((workflow) => (
          <article className="workflow-tree" key={workflow.name}>
            <header className="workflow-tree-header">
              <span className="workflow-tree-name">{workflow.name}</span>
              <span className="workflow-tree-count">{`${workflow.typeCount} types · ${workflow.edgeCount} declared links`}</span>
            </header>
            <div className="workflow-tree-body">
              <ol className="workflow-tree-root">
                {workflow.roots.map((root) => (
                  <WorkflowBranch node={root} incomingEdge={null} key={root.type} />
                ))}
              </ol>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
