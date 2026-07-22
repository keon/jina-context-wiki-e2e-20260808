"use client";

import type { ContextGraph } from "../../lib/types.ts";
import { countGraphTypes } from "../../lib/context-graph.ts";

/** Toolbar controls: node/edge filter popover, layout reset, fit and zoom. */

export interface GraphControlsProps {
  readonly graph: ContextGraph;
  readonly hiddenNodeKinds: ReadonlySet<string>;
  readonly hiddenEdgePredicates: ReadonlySet<string>;
  readonly filterMenuOpen: boolean;
  readonly zoomPercent: number;
  readonly onFilterMenuToggle: (open: boolean) => void;
  readonly onToggleFilter: (group: "node" | "edge", type: string) => void;
  readonly onShowAll: () => void;
  readonly onRemoveAll: () => void;
  readonly onResetLayout: () => void;
  readonly onFit: () => void;
  readonly onZoomBy: (factor: number) => void;
}

export function GraphControls({
  graph,
  hiddenNodeKinds,
  hiddenEdgePredicates,
  filterMenuOpen,
  zoomPercent,
  onFilterMenuToggle,
  onToggleFilter,
  onShowAll,
  onRemoveAll,
  onResetLayout,
  onFit,
  onZoomBy
}: GraphControlsProps) {
  const nodeKinds = countGraphTypes(graph.nodes, "kind");
  const edgePredicates = countGraphTypes(graph.edges, "predicate");
  const showAllDisabled = hiddenNodeKinds.size === 0 && hiddenEdgePredicates.size === 0;
  const removeAllDisabled =
    nodeKinds.every(([type]) => hiddenNodeKinds.has(type)) &&
    edgePredicates.every(([type]) => hiddenEdgePredicates.has(type));
  return (
    <div className="graph-control-toolbar">
      <details
        className="graph-filter-menu"
        open={filterMenuOpen}
        onToggle={(event) => onFilterMenuToggle(event.currentTarget.open)}
      >
        <summary className="graph-control-button">Filters</summary>
        <div className="graph-filter-popover">
          <div className="graph-filter-columns">
            <GraphFilterRow
              label="Node types"
              group="node"
              types={nodeKinds}
              hiddenTypes={hiddenNodeKinds}
              onToggleFilter={onToggleFilter}
            />
            <GraphFilterRow
              label="Relationship types"
              group="edge"
              types={edgePredicates}
              hiddenTypes={hiddenEdgePredicates}
              onToggleFilter={onToggleFilter}
            />
          </div>
          <div className="graph-popover-actions">
            <button type="button" className="graph-reset" disabled={showAllDisabled} onClick={onShowAll}>
              Show all
            </button>
            <button type="button" className="graph-reset" disabled={removeAllDisabled} onClick={onRemoveAll}>
              Remove all
            </button>
            <button type="button" className="graph-reset" onClick={onResetLayout}>
              Reset
            </button>
          </div>
        </div>
      </details>
      <button type="button" className="graph-reset" onClick={onResetLayout}>
        Reset
      </button>
      <button type="button" className="graph-control-button" onClick={onFit}>
        Fit
      </button>
      <div className="graph-zoom-group">
        <button type="button" className="graph-control-button" aria-label="Zoom out" onClick={() => onZoomBy(0.78)}>
          −
        </button>
        <span className="graph-zoom" id="graph-zoom-percent">
          {zoomPercent}%
        </span>
        <button type="button" className="graph-control-button" aria-label="Zoom in" onClick={() => onZoomBy(1.28)}>
          +
        </button>
      </div>
    </div>
  );
}

function GraphFilterRow({
  label,
  group,
  types,
  hiddenTypes,
  onToggleFilter
}: {
  readonly label: string;
  readonly group: "node" | "edge";
  readonly types: readonly (readonly [string, number])[];
  readonly hiddenTypes: ReadonlySet<string>;
  readonly onToggleFilter: (group: "node" | "edge", type: string) => void;
}) {
  return (
    <div className="graph-filter-row">
      <span className="graph-filter-label">{label}</span>
      <div className="graph-filter-list">
        {types.map(([type, count]) => (
          <button
            key={type}
            type="button"
            className="graph-filter-chip"
            data-filter-group={group}
            data-filter-type={type}
            aria-pressed={!hiddenTypes.has(type)}
            aria-label={`${hiddenTypes.has(type) ? "Show" : "Hide"} ${type} ${group} type`}
            onClick={() => onToggleFilter(group, type)}
          >
            {type} · {count}
          </button>
        ))}
      </div>
    </div>
  );
}
