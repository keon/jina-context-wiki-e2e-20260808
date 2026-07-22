"use client";

import { useRef } from "react";
import type { BoardFilters } from "../../lib/board.ts";
import { humanize } from "../../lib/format.ts";

export interface BoardFilterOptions {
  readonly repository: readonly string[];
  readonly owner: readonly string[];
  readonly type: readonly string[];
  readonly status: readonly string[];
}

function FilterSelect({
  id,
  ariaLabel,
  allLabel,
  value,
  values,
  onChange
}: {
  readonly id: string;
  readonly ariaLabel: string;
  readonly allLabel: string;
  readonly value: string;
  readonly values: readonly string[];
  readonly onChange: (value: string) => void;
}) {
  return (
    <select id={id} aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{allLabel}</option>
      {values.map((option) => (
        <option value={option} key={option}>
          {humanize(option)}
        </option>
      ))}
    </select>
  );
}

export function BoardToolbar({
  filters,
  options,
  onFilterChange,
  onRefresh
}: {
  readonly filters: BoardFilters;
  readonly options: BoardFilterOptions;
  readonly onFilterChange: (field: keyof BoardFilters, value: string) => void;
  readonly onRefresh: () => Promise<void>;
}) {
  const nextPr = useRef(100);
  const nextIssue = useRef(200);

  const postDemo = async (body: Readonly<Record<string, unknown>>) => {
    await fetch("/api/dev/webhooks/github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    await onRefresh();
  };

  return (
    <div className="page-filters" id="toolbar">
      <label className="search-control">
        <span aria-hidden="true">⌕</span>
        <input
          id="board-search"
          placeholder="Search tasks…"
          aria-label="Search tasks"
          value={filters.query}
          onChange={(event) => onFilterChange("query", event.target.value)}
        />
      </label>
      <FilterSelect
        id="board-repository"
        ariaLabel="Filter by repository"
        allLabel="Repository: All"
        value={filters.repository}
        values={options.repository}
        onChange={(value) => onFilterChange("repository", value)}
      />
      <FilterSelect
        id="board-owner"
        ariaLabel="Filter by owner"
        allLabel="Owner: All"
        value={filters.owner}
        values={options.owner}
        onChange={(value) => onFilterChange("owner", value)}
      />
      <FilterSelect
        id="board-type"
        ariaLabel="Filter by task type"
        allLabel="Task type: All"
        value={filters.type}
        values={options.type}
        onChange={(value) => onFilterChange("type", value)}
      />
      <FilterSelect
        id="board-status"
        ariaLabel="Filter by status"
        allLabel="Status: All"
        value={filters.status}
        values={options.status}
        onChange={(value) => onFilterChange("status", value)}
      />
      <details className="demo-menu">
        <summary>Demo events</summary>
        <div className="demo-actions">
          <button
            type="button"
            data-demo="pr"
            onClick={() => {
              const pullRequestNumber = ++nextPr.current;
              void postDemo({ repository: "omlabs/example", pullRequestNumber, headSha: `sha-${pullRequestNumber}-1` });
            }}
          >
            Open PR
          </button>
          <button
            type="button"
            data-demo="issue"
            onClick={() => {
              const issueNumber = ++nextIssue.current;
              void postDemo({ repository: "omlabs/example", issueNumber, title: `Demo issue ${issueNumber}` });
            }}
          >
            Open issue
          </button>
          <button
            type="button"
            data-demo="push"
            onClick={() =>
              void postDemo({
                repository: "omlabs/example",
                pullRequestNumber: 42,
                headSha: `sha-42-${Date.now().toString(36)}`
              })
            }
          >
            Force-push PR #42
          </button>
        </div>
      </details>
    </div>
  );
}
