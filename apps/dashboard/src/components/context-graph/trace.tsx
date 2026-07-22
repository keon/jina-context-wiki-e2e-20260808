"use client";

import { safeExternalUrl } from "../../lib/context-graph.ts";

/** Shared trace/citation primitives used by cited search and assertion review. */

export function TraceFact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="trace-fact">
      <span className="trace-fact-label">{label}</span>
      <p className="trace-fact-value">{value}</p>
    </div>
  );
}

export function TraceEvidence({ evidence }: { readonly evidence: readonly string[] }) {
  return (
    <div className="trace-fact">
      <span className="trace-fact-label">Evidence</span>
      {evidence.length === 0 ? (
        <p className="trace-fact-value">No causal evidence was recorded.</p>
      ) : (
        <div className="trace-evidence-list">
          {evidence.map((citation, index) => (
            <span className="trace-evidence" key={`${index}-${citation}`}>
              {citation}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Only https://github.com URLs render as links; anything else falls back to
 * plain text, exactly like the previous dashboard's externalLink helper.
 */
export function ExternalLink({ label, url }: { readonly label: string; readonly url: string | undefined }) {
  const safeUrl = safeExternalUrl(url);
  if (!safeUrl) return <span>{label}</span>;
  return (
    <a href={safeUrl} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
}
