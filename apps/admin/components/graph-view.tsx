"use client";

import { useMemo, useState } from "react";
import type { AdminGraphEdge, AdminGraphNode } from "../lib/jina-api";
import { GRAPH_HEIGHT, GRAPH_WIDTH, layoutGraph } from "../lib/graph-layout";
import type { PositionedGraphNode } from "../lib/graph-layout";

const KIND_COLORS: Readonly<Record<string, string>> = {
  Repository: "#5aa9ff",
  File: "#7fd1b9",
  Symbol: "#ffd166",
  Commit: "#f4978e",
  PullRequest: "#f08cae",
  Issue: "#e5989b",
  Engineer: "#b5e48c",
  Team: "#99d98c",
  Document: "#a3b8ff",
  Feature: "#c792ea",
  Package: "#f9c74f",
  Service: "#90e0ef",
  Deployment: "#80ffdb",
  Incident: "#ef476f"
};

const FALLBACK_COLOR = "#8b96a8";

export function GraphView({
  nodes,
  edges
}: {
  readonly nodes: readonly AdminGraphNode[];
  readonly edges: readonly AdminGraphEdge[];
}) {
  const positioned = useMemo(() => layoutGraph(nodes, edges), [nodes, edges]);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const byId = useMemo(() => new Map(positioned.map((node) => [node.id, node])), [positioned]);
  const selected = selectedId ? byId.get(selectedId) : undefined;
  const neighborIds = useMemo(() => {
    if (!selectedId) return undefined;
    const ids = new Set<string>([selectedId]);
    for (const edge of edges) {
      if (edge.source === selectedId) ids.add(edge.target);
      if (edge.target === selectedId) ids.add(edge.source);
    }
    return ids;
  }, [edges, selectedId]);
  const kindsInGraph = useMemo(() => [...new Set(nodes.map((node) => node.kind))].sort(), [nodes]);

  if (nodes.length === 0) {
    return <div className="empty-state">This graph has no nodes.</div>;
  }

  return (
    <>
      <div className="graph-panel">
        <svg
          viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
          role="img"
          aria-label="Context graph visualization"
          onClick={() => setSelectedId(undefined)}
        >
          {edges.map((edge) => {
            const source = byId.get(edge.source);
            const target = byId.get(edge.target);
            if (!source || !target) return null;
            const touchesSelection = !selectedId || edge.source === selectedId || edge.target === selectedId;
            return (
              <line
                key={edge.id}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                stroke={edge.plane === "knowledge" ? "#c792ea" : "#3d4a5e"}
                strokeWidth={touchesSelection ? 1.6 : 0.8}
                strokeOpacity={touchesSelection ? 0.85 : 0.25}
                strokeDasharray={edge.plane === "knowledge" ? "5 4" : undefined}
              >
                <title>{`${source.label} —${edge.predicate}→ ${target.label}`}</title>
              </line>
            );
          })}
          {positioned.map((node) => {
            const dimmed = neighborIds ? !neighborIds.has(node.id) : false;
            return (
              <g
                key={node.id}
                transform={`translate(${node.x}, ${node.y})`}
                opacity={dimmed ? 0.3 : 1}
                style={{ cursor: "pointer" }}
                onClick={(event) => {
                  event.stopPropagation();
                  setSelectedId(node.id === selectedId ? undefined : node.id);
                }}
              >
                <circle
                  r={node.id === selectedId ? 11 : 8}
                  fill={KIND_COLORS[node.kind] ?? FALLBACK_COLOR}
                  stroke={node.id === selectedId ? "#e6e9ef" : "#0e1116"}
                  strokeWidth={node.id === selectedId ? 2 : 1}
                />
                <text y={-13} textAnchor="middle" fontSize={11} fill="#e6e9ef">
                  {node.label.length > 28 ? `${node.label.slice(0, 27)}…` : node.label}
                </text>
                <title>{`${node.kind}: ${node.label}\n${node.description}`}</title>
              </g>
            );
          })}
        </svg>
        <div className="graph-legend">
          {kindsInGraph.map((kind) => (
            <span key={kind}>
              <span className="swatch" style={{ background: KIND_COLORS[kind] ?? FALLBACK_COLOR }} />
              {kind}
            </span>
          ))}
          <span>
            <span className="swatch" style={{ background: "#c792ea" }} />
            knowledge edge (dashed)
          </span>
        </div>
      </div>

      {selected ? (
        <div className="selection-panel">
          <h3>
            {selected.label} <span className="muted">· {selected.kind}</span>
          </h3>
          {selected.path ? (
            <div>
              <code>{selected.path}</code>
            </div>
          ) : null}
          <p className="muted">{selected.description}</p>
          <EdgeList edges={edges} nodeId={selected.id} byId={byId} />
        </div>
      ) : (
        <p className="muted">Click a node to inspect its details and relationships.</p>
      )}
    </>
  );
}

function EdgeList({
  edges,
  nodeId,
  byId
}: {
  readonly edges: readonly AdminGraphEdge[];
  readonly nodeId: string;
  readonly byId: ReadonlyMap<string, PositionedGraphNode>;
}) {
  const related = edges.filter((edge) => edge.source === nodeId || edge.target === nodeId);
  if (related.length === 0) return null;
  return (
    <ul>
      {related.map((edge) => {
        const outbound = edge.source === nodeId;
        const other = byId.get(outbound ? edge.target : edge.source);
        return (
          <li key={edge.id}>
            {outbound ? (
              <>
                {edge.predicate} → <strong>{other?.label ?? "?"}</strong>
              </>
            ) : (
              <>
                <strong>{other?.label ?? "?"}</strong> {edge.predicate} → this
              </>
            )}{" "}
            <span className="muted">
              [{edge.plane}
              {edge.confidence !== undefined ? ` · ${Math.round(edge.confidence * 100)}%` : ""}]
            </span>
            {edge.why ? <span className="muted"> — {edge.why}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
