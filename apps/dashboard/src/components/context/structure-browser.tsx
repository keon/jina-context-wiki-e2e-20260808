"use client";

import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { matchesStructure, structureEntries } from "../../lib/context.ts";
import { humanize } from "../../lib/format.ts";
import { usePoll } from "../../lib/poll.ts";
import type { ContextStructureResponse } from "../../lib/types.ts";

export function StructureBrowser({ repository, refName }: { readonly repository: string; readonly refName: string }) {
  const [query, setQuery] = useState("");
  const structure = usePoll<ContextStructureResponse>(
    `/api/context/structure?repository=${encodeURIComponent(repository)}&ref=${encodeURIComponent(refName)}`,
    10_000
  );
  const entries = useMemo(() => structureEntries(structure.data?.relations ?? []), [structure.data]);
  const visible = useMemo(() => entries.filter((entry) => matchesStructure(entry, query)), [entries, query]);

  return (
    <section className="context-operations-panel context-structure-browser">
      <header className="context-panel-heading">
        <div>
          <span className="context-eyebrow">Deterministic structure</span>
          <h2>Files, symbols, and dependencies</h2>
        </div>
        <span>{structure.data?.relations.length ?? 0} relations</span>
      </header>
      <label className="context-structure-filter">
        <span className="sr-only">Filter structure</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter path or symbol…" />
      </label>
      <div className="context-structure-tree" role="tree" aria-label={`${repository} structure`}>
        {visible.length === 0 ? (
          <p className="context-panel-empty">No deterministic structure matches this filter.</p>
        ) : (
          visible.map((entry) => (
            <div
              className={`context-structure-entry ${entry.kind}`}
              key={entry.id}
              role="treeitem"
              aria-level={entry.depth + 1}
              style={{ "--structure-depth": entry.depth } as CSSProperties}
            >
              <span aria-hidden="true">{entry.kind === "directory" ? "▸" : entry.kind === "relation" ? "↳" : "·"}</span>
              <strong>{entry.label}</strong>
              <small>{entry.detail ? `${humanize(entry.detail)}` : entry.path}</small>
            </div>
          ))
        )}
      </div>
      <p className="context-structure-note">
        Only parser- and provider-derived relations are shown. Generated knowledge never creates structure.
      </p>
    </section>
  );
}
