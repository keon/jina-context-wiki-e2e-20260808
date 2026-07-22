"use client";

import { useMemo, useState } from "react";
import type { AdminGraphEdge, AdminGraphNode } from "../lib/jina-api";

const WIDTH = 1200;
const HEIGHT = 560;

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

interface PositionedNode extends AdminGraphNode {
  readonly x: number;
  readonly y: number;
}

export function GraphView({
  nodes,
  edges
}: {
  readonly nodes: readonly AdminGraphNode[];
  readonly edges: readonly AdminGraphEdge[];
}) {
  const positioned = useMemo(() => layout(nodes, edges), [nodes, edges]);
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
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
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
  readonly byId: ReadonlyMap<string, PositionedNode>;
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

/**
 * Deterministic force-directed layout: seeded circular start, then spring
 * attraction along edges and pairwise repulsion. Small graphs converge in a
 * few hundred iterations; runs once per graph via useMemo.
 */
function layout(nodes: readonly AdminGraphNode[], edges: readonly AdminGraphEdge[]): readonly PositionedNode[] {
  const count = nodes.length;
  if (count === 0) return [];
  const index = new Map(nodes.map((node, position) => [node.id, position]));
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const radius = Math.min(WIDTH, HEIGHT) * 0.38;
  for (let i = 0; i < count; i += 1) {
    const angle = (2 * Math.PI * i) / count + seededJitter(nodes[i]?.id ?? String(i));
    xs[i] = WIDTH / 2 + radius * Math.cos(angle);
    ys[i] = HEIGHT / 2 + radius * Math.sin(angle);
  }
  const links = edges
    .map((edge) => [index.get(edge.source), index.get(edge.target)] as const)
    .filter((pair): pair is readonly [number, number] => pair[0] !== undefined && pair[1] !== undefined);

  const iterations = count > 400 ? 120 : 300;
  const repulsion = 5200;
  const springLength = 120;
  const springStrength = 0.02;
  for (let step = 0; step < iterations; step += 1) {
    const cooling = 1 - step / iterations;
    const fx = new Float64Array(count);
    const fy = new Float64Array(count);
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        const dx = (xs[i] ?? 0) - (xs[j] ?? 0);
        const dy = (ys[i] ?? 0) - (ys[j] ?? 0);
        const distanceSquared = Math.max(dx * dx + dy * dy, 64);
        const force = repulsion / distanceSquared;
        const distance = Math.sqrt(distanceSquared);
        fx[i] = (fx[i] ?? 0) + (dx / distance) * force;
        fy[i] = (fy[i] ?? 0) + (dy / distance) * force;
        fx[j] = (fx[j] ?? 0) - (dx / distance) * force;
        fy[j] = (fy[j] ?? 0) - (dy / distance) * force;
      }
    }
    for (const [a, b] of links) {
      const dx = (xs[b] ?? 0) - (xs[a] ?? 0);
      const dy = (ys[b] ?? 0) - (ys[a] ?? 0);
      const distance = Math.max(Math.hypot(dx, dy), 1);
      const force = (distance - springLength) * springStrength;
      fx[a] = (fx[a] ?? 0) + (dx / distance) * force;
      fy[a] = (fy[a] ?? 0) + (dy / distance) * force;
      fx[b] = (fx[b] ?? 0) - (dx / distance) * force;
      fy[b] = (fy[b] ?? 0) - (dy / distance) * force;
    }
    for (let i = 0; i < count; i += 1) {
      xs[i] = clamp((xs[i] ?? 0) + (fx[i] ?? 0) * cooling, 40, WIDTH - 40);
      ys[i] = clamp((ys[i] ?? 0) + (fy[i] ?? 0) * cooling, 40, HEIGHT - 40);
    }
  }
  return nodes.map((node, i) => ({ ...node, x: round1(xs[i] ?? WIDTH / 2), y: round1(ys[i] ?? HEIGHT / 2) }));
}

function seededJitter(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000) / 1000 - 0.5;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
