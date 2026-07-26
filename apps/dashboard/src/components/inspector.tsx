import { clampConfidence, confidenceLabel } from "../lib/format.ts";

/** Shared inspector primitives used by operational detail panes. */

export function DetailGrid({ fields }: { readonly fields: readonly (readonly [string, string])[] }) {
  return (
    <div className="inspector-detail-grid">
      {fields.map(([label, value]) => (
        <div className="inspector-detail-field" key={label}>
          <span className="label">{label}</span>
          <span className="value">{value}</span>
        </div>
      ))}
    </div>
  );
}

export function ExplanationSection({ value }: { readonly value: string }) {
  return (
    <section className="inspector-section-block">
      <h3>Explanation</h3>
      <p className="inspector-explanation">{value}</p>
    </section>
  );
}

export function ConfidenceSection({
  label,
  value,
  note
}: {
  readonly label: string;
  readonly value: number | undefined;
  readonly note: string;
}) {
  const scored = typeof value === "number" && Number.isFinite(value);
  return (
    <section className="inspector-section-block">
      <h3>Confidence</h3>
      <div className="inspector-confidence">
        <div className="inspector-confidence-top">
          <span className="label">{label}</span>
          <strong className="inspector-confidence-value">{confidenceLabel(value)}</strong>
        </div>
        {scored ? (
          <div
            className="inspector-confidence-meter"
            role="meter"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(clampConfidence(value) * 100)}
          >
            <span
              className="inspector-confidence-fill"
              style={{ width: `${Math.round(clampConfidence(value) * 100)}%` }}
            />
          </div>
        ) : null}
        <p className="inspector-confidence-note">{note}</p>
      </div>
    </section>
  );
}

export function EvidenceSection({ evidence }: { readonly evidence: readonly string[] }) {
  return (
    <section className="inspector-section-block">
      <h3>Evidence · {evidence.length}</h3>
      {evidence.length === 0 ? (
        <p className="empty-detail">No evidence citations were provided.</p>
      ) : (
        <ul className="inspector-evidence-list">
          {evidence.map((citation, index) => (
            <li className="inspector-evidence" key={`${index}-${citation}`}>
              {citation}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
