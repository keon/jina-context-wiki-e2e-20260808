import { DetailGrid } from "../inspector.tsx";
import { citationLabels } from "../../lib/context-graph.ts";
import type { ContextAskState, ContextCallItem } from "../../lib/context-graph.ts";
import { TraceEvidence, TraceFact } from "./trace.tsx";
import { CausalTraceView, IssueTraceView } from "./cited-traces.tsx";

export function FullEvidenceBody({ state }: { readonly state: ContextAskState }) {
  const hasNotices = Boolean(
    (state.unresolvedAmbiguities && state.unresolvedAmbiguities.length) ||
    (state.coverageGaps && state.coverageGaps.length)
  );
  const calls = state.calls ?? [];
  const empty = !hasNotices && !state.answer && calls.length === 0;
  return (
    <div className="context-full-evidence-body">
      {hasNotices ? <ContextNotices state={state} /> : null}
      {state.answer ? <ContextAnswer state={state} /> : null}
      {calls.map((call, callIndex) => {
        const items = call.items ?? [];
        return (
          <article className="context-call" key={`${callIndex}-${call.template ?? ""}`}>
            <h3>{(call.template ?? "") + (call.truncated ? " · truncated" : "")}</h3>
            {items.length === 0 ? (
              <p className="empty-detail">
                {call.template === "issue_trace"
                  ? "No matching ingested issue or cited relationship was found for the validated issue description or identifier."
                  : "No cited results."}
              </p>
            ) : null}
            {items.map((item, itemIndex) => (
              <ContextCallItemView item={item} question={state.question} key={itemIndex} />
            ))}
          </article>
        );
      })}
      {empty ? <p className="empty-detail">No additional evidence was returned.</p> : null}
    </div>
  );
}

function ContextCallItemView({
  item,
  question
}: {
  readonly item: ContextCallItem;
  readonly question: string | undefined;
}) {
  if (item.kind === "causal_trace" && item.data?.root) {
    return <CausalTraceView trace={item.data} />;
  }
  if (item.kind === "issue_trace" && item.data?.issue) {
    return <IssueTraceView trace={item.data} citations={item.citations} question={question} />;
  }
  return (
    <div className="context-result">
      <strong>{item.title}</strong>
      {item.data?.excerpt ? <span>{item.data.excerpt}</span> : null}
      <span>{citationLabels(item.citations).join(" · ")}</span>
    </div>
  );
}

function ContextAnswer({ state }: { readonly state: ContextAskState }) {
  const claims = state.citedClaims ?? [];
  return (
    <article className="context-answer">
      <span className="context-answer-label">Answer</span>
      <p className="context-answer-text">{state.answer}</p>
      {state.counterfactual ? <CounterfactualDetails value={state.counterfactual} /> : null}
      {claims.length ? (
        <div className="context-claims">
          <h4>Cited claims</h4>
          {claims.map((claim, index) => (
            <div className="context-claim" key={index}>
              <strong>{claim.text}</strong>
              <span className="context-citations">{citationLabels(claim.citations).join(" · ")}</span>
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function CounterfactualDetails({ value }: { readonly value: NonNullable<ContextAskState["counterfactual"]> }) {
  const removed = value.removedPaths ?? [];
  const remaining = value.remainingPaths ?? [];
  const why = removed.concat(remaining).filter((path) => path.why);
  const evidence = Array.from(
    new Set(removed.concat(remaining).flatMap((path) => citationLabels(path.citations ?? [])))
  );
  return (
    <div className="context-claims">
      <h4>Basis: {value.basis || "graph-derived"}</h4>
      <DetailGrid
        fields={[
          [
            "Intervention",
            value.intervention ? `${value.intervention.kind} · ${value.intervention.label}` : "Unresolved"
          ],
          ["Outcome", value.outcome ? `${value.outcome.kind} · ${value.outcome.label}` : "Unresolved"],
          ["Known paths removed", String(removed.length)],
          ["Known paths remaining", String(remaining.length)]
        ]}
      />
      {why.length ? <TraceFact label="Why" value={why.map((path) => path.why).join(" · ")} /> : null}
      <TraceEvidence evidence={evidence} />
    </div>
  );
}

function ContextNotices({ state }: { readonly state: ContextAskState }) {
  const ambiguities = state.unresolvedAmbiguities ?? [];
  const gaps = state.coverageGaps ?? [];
  if (!ambiguities.length && !gaps.length) return null;
  return (
    <div className="context-notices">
      {ambiguities.map((ambiguity, index) => (
        <div className="context-notice" key={`ambiguity-${index}`}>
          <strong>Ambiguity</strong>
          {ambiguity}
        </div>
      ))}
      {gaps.map((gap, index) => (
        <div className="context-notice" key={`gap-${index}`}>
          <strong>Coverage gap · {gap.capability}</strong>
          {gap.message}
        </div>
      ))}
    </div>
  );
}
