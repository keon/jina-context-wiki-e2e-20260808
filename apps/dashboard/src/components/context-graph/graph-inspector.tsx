"use client";

import { useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { ConfidenceSection, DetailGrid, EvidenceSection, ExplanationSection } from "../inspector.tsx";
import { confidenceLabel, humanize } from "../../lib/format.ts";
import { connectedConfidenceSummary, friendlyNodeExplanation, friendlyNodeLabel } from "../../lib/context-graph.ts";
import { ASSERTION_REJECTION_CODES, assertionView } from "../../lib/assertions.ts";
import type { GraphSelection, VisibleGraph } from "../../lib/context-graph.ts";
import type { ContextGraph, ContextGraphAssertion, ContextGraphEdge, ContextGraphNode } from "../../lib/types.ts";

export type ReviewAssertionFn = (
  assertionId: string,
  decision: string,
  rejectionCode?: string,
  reason?: string
) => Promise<void>;

/** Selection-driven node/edge inspector, with the proposed-assertion queue as its empty state. */

export interface GraphInspectorProps {
  readonly graph: ContextGraph | null;
  readonly visibleGraph: VisibleGraph;
  readonly selection: GraphSelection | null;
  readonly proposedAssertions: readonly ContextGraphAssertion[];
  readonly canLoadMoreProposedAssertions: boolean;
  readonly onSelect: (selection: GraphSelection | null) => void;
  readonly onReview: ReviewAssertionFn;
  readonly onLoadMoreProposedAssertions: () => Promise<void>;
}

export function GraphInspector({
  graph,
  visibleGraph,
  selection,
  proposedAssertions,
  canLoadMoreProposedAssertions,
  onSelect,
  onReview,
  onLoadMoreProposedAssertions
}: GraphInspectorProps) {
  return (
    <aside className="context-graph-details side-inspector" id="context-graph-details" aria-live="polite">
      <InspectorBody
        graph={graph}
        visibleGraph={visibleGraph}
        selection={selection}
        proposedAssertions={proposedAssertions}
        canLoadMoreProposedAssertions={canLoadMoreProposedAssertions}
        onSelect={onSelect}
        onReview={onReview}
        onLoadMoreProposedAssertions={onLoadMoreProposedAssertions}
      />
    </aside>
  );
}

function InspectorBody({
  graph,
  visibleGraph,
  selection,
  proposedAssertions,
  canLoadMoreProposedAssertions,
  onSelect,
  onReview,
  onLoadMoreProposedAssertions
}: GraphInspectorProps) {
  if (!graph) return <p className="empty-detail">Run an context_graph_build task to create the first graph.</p>;
  if (!selection) {
    if (proposedAssertions.length) {
      return (
        <AssertionReviewQueue
          assertions={proposedAssertions}
          canLoadMore={canLoadMoreProposedAssertions}
          onReview={onReview}
          onLoadMore={onLoadMoreProposedAssertions}
        />
      );
    }
    return (
      <p className="empty-detail">
        {visibleGraph.nodes.length
          ? "Select a node or relationship in the graph to inspect its metadata and evidence."
          : "No graph items are visible. Turn on a node type above to continue exploring."}
      </p>
    );
  }
  if (selection.kind === "node") {
    const node = graph.nodes.find((item) => item.id === selection.id);
    if (!node) return null;
    return <NodeInspector node={node} graph={graph} visibleGraph={visibleGraph} onSelect={onSelect} />;
  }
  const edge = graph.edges.find((item) => item.id === selection.id);
  if (!edge) return null;
  return <EdgeInspector edge={edge} graph={graph} onSelect={onSelect} />;
}

function NodeInspector({
  node,
  graph,
  visibleGraph,
  onSelect
}: {
  readonly node: ContextGraphNode;
  readonly graph: ContextGraph;
  readonly visibleGraph: VisibleGraph;
  readonly onSelect: (selection: GraphSelection | null) => void;
}) {
  const relatedEdges = visibleGraph.edges.filter((edge) => edge.source === node.id || edge.target === node.id);
  const friendlyLabel = friendlyNodeLabel(node, graph);
  const explanation = friendlyNodeExplanation(node, graph);
  const fields: (readonly [string, string])[] = [
    ["ID", node.id],
    ["Type", node.kind]
  ];
  if (friendlyLabel !== node.label) fields.push(["Stored label", node.label]);
  fields.push(["Path", node.path || "Not applicable"]);
  fields.push(["Visible relationships", String(relatedEdges.length)]);
  if (explanation !== node.description && node.description) fields.push(["Canonical key", node.description]);
  const confidence = connectedConfidenceSummary(relatedEdges);
  return (
    <InspectorItem title={friendlyLabel} type={`Node · ${node.kind}`} onClose={() => onSelect(null)}>
      <DetailGrid fields={fields} />
      <ConfidenceSection
        label="Connected relationship confidence"
        value={confidence.value}
        note={
          confidence.scoredCount
            ? `Average of ${confidence.scoredCount} scored visible relationship${confidence.scoredCount === 1 ? "" : "s"}. Nodes do not carry a direct confidence score.`
            : "No visible connected relationships provide confidence scores. Nodes do not carry a direct confidence score."
        }
      />
      <EvidenceSection evidence={node.evidence} />
      <ExplanationSection value={explanation} />
      <RelationshipSection node={node} edges={relatedEdges} graph={graph} onSelect={onSelect} />
      <InspectorActions labels={["⌖  Pin", "◎  Center", "↗  Open source"]} />
    </InspectorItem>
  );
}

function EdgeInspector({
  edge,
  graph,
  onSelect
}: {
  readonly edge: ContextGraphEdge;
  readonly graph: ContextGraph;
  readonly onSelect: (selection: GraphSelection | null) => void;
}) {
  const source = graph.nodes.find((node) => node.id === edge.source);
  const target = graph.nodes.find((node) => node.id === edge.target);
  const sourceLabel = source ? friendlyNodeLabel(source, graph) : edge.source;
  const targetLabel = target ? friendlyNodeLabel(target, graph) : edge.target;
  return (
    <InspectorItem title={edge.predicate} type={`Edge · ${edge.plane} plane`} onClose={() => onSelect(null)}>
      <Endpoint label="Source (from)" value={sourceLabel} kind={source?.kind || "Node"} />
      <Endpoint label="Target (to)" value={targetLabel} kind={target?.kind || "Node"} />
      <DetailGrid
        fields={[
          ["Relationship type", edge.plane],
          ["Predicate", edge.predicate],
          ["Relationship ID", edge.id]
        ]}
      />
      <ConfidenceSection
        label="Relationship confidence"
        value={edge.confidence}
        note={
          edge.confidence === undefined
            ? "This relationship was stored without a confidence score."
            : "Direct confidence score stored on this relationship."
        }
      />
      <EvidenceSection evidence={edge.evidence} />
      <ExplanationSection
        value={edge.why || `This relationship states that ${sourceLabel} ${humanize(edge.predicate)} ${targetLabel}.`}
      />
      <InspectorActions labels={["⇄  Reverse direction", "⌁  Reconnect", "◌  Hide type", "⌫  Delete"]} />
    </InspectorItem>
  );
}

function InspectorItem({
  title,
  type,
  onClose,
  children
}: {
  readonly title: string;
  readonly type: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  return (
    <article className="context-graph-item">
      <div className="context-graph-item-heading">
        <div className="context-graph-heading-copy">
          <strong>{title}</strong>
          <span className="context-graph-item-type">{type}</span>
        </div>
        <button type="button" className="inspector-close" aria-label="Clear graph selection" onClick={onClose}>
          ×
        </button>
      </div>
      {children}
    </article>
  );
}

function Endpoint({ label, value, kind }: { readonly label: string; readonly value: string; readonly kind: string }) {
  return (
    <section className="context-graph-endpoint">
      <span className="label">{label}</span>
      <strong>{value}</strong>
      <span className="context-graph-item-type">{humanize(kind)}</span>
    </section>
  );
}

function InspectorActions({ labels }: { readonly labels: readonly string[] }) {
  return (
    <footer className="context-graph-inspector-actions">
      {labels.map((label) => (
        <button
          key={label}
          type="button"
          className={label.includes("Delete") ? "danger-button" : "secondary-button"}
          disabled
          aria-disabled="true"
          title="This action is not available in the read-only graph explorer."
        >
          {label}
        </button>
      ))}
    </footer>
  );
}

function RelationshipSection({
  node,
  edges,
  graph,
  onSelect
}: {
  readonly node: ContextGraphNode;
  readonly edges: readonly ContextGraphEdge[];
  readonly graph: ContextGraph;
  readonly onSelect: (selection: GraphSelection | null) => void;
}) {
  return (
    <section className="context-graph-inspector-section">
      <h3>Visible relationships · {edges.length}</h3>
      {edges.length === 0 ? (
        <p className="empty-detail">No visible relationships connect to this node.</p>
      ) : (
        <div className="context-graph-relationship-list">
          {edges.map((edge) => {
            const outgoing = edge.source === node.id;
            const otherId = outgoing ? edge.target : edge.source;
            const other = graph.nodes.find((candidate) => candidate.id === otherId);
            return (
              <button
                key={edge.id}
                type="button"
                className="context-graph-relationship"
                onClick={() => onSelect({ kind: "edge", id: edge.id })}
              >
                <span className="context-graph-relationship-title">
                  {(outgoing ? "Outgoing · " : "Incoming · ") +
                    edge.predicate +
                    " · " +
                    (other ? friendlyNodeLabel(other, graph) : otherId)}
                </span>
                <span className="context-graph-relationship-meta">
                  {edge.plane} · {confidenceLabel(edge.confidence)}
                </span>
                <span className="context-graph-relationship-explanation">
                  {edge.why || "No relationship explanation provided. Select for full details."}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Shared rejection-code select + reason input (uncontrolled, validated on reject). */
export function AssertionRejectionFields({
  codeRef,
  reasonRef
}: {
  readonly codeRef: RefObject<HTMLSelectElement | null>;
  readonly reasonRef: RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="assertion-review-fields">
      <select className="assertion-rejection-code" ref={codeRef} defaultValue="">
        {ASSERTION_REJECTION_CODES.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <input className="assertion-rejection-reason" placeholder="Reason for rejection" ref={reasonRef} />
    </div>
  );
}

export function validateRejection(
  codeRef: RefObject<HTMLSelectElement | null>,
  reasonRef: RefObject<HTMLInputElement | null>
): { readonly code: string; readonly reason: string } | null {
  const code = codeRef.current;
  const reason = reasonRef.current;
  if (!code || !reason) return null;
  if (!code.value || !reason.value.trim()) {
    reason.setCustomValidity("Choose a category and provide a reason.");
    reason.reportValidity();
    return null;
  }
  reason.setCustomValidity("");
  return { code: code.value, reason: reason.value.trim() };
}

function AssertionReviewQueue({
  assertions,
  canLoadMore,
  onReview,
  onLoadMore
}: {
  readonly assertions: readonly ContextGraphAssertion[];
  readonly canLoadMore: boolean;
  readonly onReview: ReviewAssertionFn;
  readonly onLoadMore: () => Promise<void>;
}) {
  const pageSize = 25;
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const visibleAssertions = assertions.slice(0, visibleCount);
  const remaining = assertions.length - visibleAssertions.length;
  return (
    <>
      <div className="context-graph-item-heading">
        <div className="context-graph-heading-copy">
          <strong>Assertion review</strong>
          <span className="context-graph-item-type">
            {assertions.length}
            {canLoadMore ? "+" : ""} proposed
          </span>
        </div>
      </div>
      <div className="assertion-review-list">
        {visibleAssertions.map((assertion) => (
          <AssertionQueueCard key={assertion.id} assertion={assertion} onReview={onReview} />
        ))}
        {remaining > 0 || canLoadMore ? (
          <button
            type="button"
            className="secondary-button"
            aria-controls="context-graph-details"
            disabled={loadingMore}
            title={loadError ?? undefined}
            onClick={() => {
              if (remaining > 0) {
                setVisibleCount((count) => count + pageSize);
                return;
              }
              setLoadingMore(true);
              setLoadError(null);
              void onLoadMore()
                .catch((error) => {
                  setLoadError(error instanceof Error ? error.message : "Could not load older proposals");
                })
                .finally(() => setLoadingMore(false));
            }}
          >
            {loadingMore
              ? "Loading older proposals…"
              : remaining > 0
                ? `Load more (${remaining} remaining)`
                : loadError
                  ? "Retry loading older proposals"
                  : "Load older proposals"}
          </button>
        ) : null}
      </div>
    </>
  );
}

function AssertionQueueCard({
  assertion,
  onReview
}: {
  readonly assertion: ContextGraphAssertion;
  readonly onReview: ReviewAssertionFn;
}) {
  const codeRef = useRef<HTMLSelectElement | null>(null);
  const reasonRef = useRef<HTMLInputElement | null>(null);
  const view = assertionView(assertion);
  return (
    <article className="assertion-review-card">
      <strong>
        {view.subjectLabel} · {assertion.predicate} · {view.objectLabel}
      </strong>
      <p>
        {assertion.explanation || "This legacy assertion has no explanation and should not be accepted without review."}
      </p>
      <p>Evidence: {(assertion.evidence || []).join(", ") || "none"}</p>
      <AssertionRejectionFields codeRef={codeRef} reasonRef={reasonRef} />
      <div className="assertion-review-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            void onReview(assertion.id, "accept").catch(() => undefined);
          }}
        >
          Accept
        </button>
        <button
          type="button"
          className="danger-button"
          onClick={() => {
            const rejection = validateRejection(codeRef, reasonRef);
            if (!rejection) return;
            void onReview(assertion.id, "reject", rejection.code, rejection.reason).catch(() => undefined);
          }}
        >
          Reject
        </button>
      </div>
    </article>
  );
}
