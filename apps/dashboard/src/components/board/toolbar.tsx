"use client";

import type { BoardFilters } from "../../lib/board.ts";
import { humanize } from "../../lib/format.ts";

interface BoardFilterOptions {
  readonly repository: readonly string[];
  readonly owner: readonly string[];
  readonly type: readonly string[];
  readonly status: readonly string[];
}

type BoardConnectionStatus = "connecting" | "live" | "offline" | "preview";

const STATUS_LABELS: Record<BoardConnectionStatus, string> = {
  connecting: "Connecting",
  live: "Live workspace data",
  offline: "Offline",
  preview: "Local preview"
};

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
    <label className="agent-board-toolbar__select-wrap">
      <span className="sr-only">{ariaLabel}</span>
      <select id={id} aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{allLabel}</option>
        {values.map((option) => (
          <option value={option} key={option}>
            {humanize(option)}
          </option>
        ))}
      </select>
      <ChevronIcon />
    </label>
  );
}

export function BoardToolbar({
  filters,
  options,
  visibleCount,
  totalCount,
  status,
  refreshing,
  onRefresh,
  onFilterChange
}: {
  readonly filters: BoardFilters;
  readonly options: BoardFilterOptions;
  readonly visibleCount: number;
  readonly totalCount: number;
  readonly status: BoardConnectionStatus;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly onFilterChange: (field: keyof BoardFilters, value: string) => void;
}) {
  return (
    <header className="agent-board-toolbar" id="toolbar">
      <label className="agent-board-toolbar__search">
        <SearchIcon />
        <input
          id="board-search"
          placeholder="Search tasks and repositories…"
          aria-label="Search tasks"
          value={filters.query}
          onChange={(event) => onFilterChange("query", event.target.value)}
        />
      </label>

      <div className="agent-board-toolbar__filters">
        <FilterSelect
          id="board-repository"
          ariaLabel="Filter by repository"
          allLabel="All repositories"
          value={filters.repository}
          values={options.repository}
          onChange={(value) => onFilterChange("repository", value)}
        />
        <FilterSelect
          id="board-owner"
          ariaLabel="Filter by owner"
          allLabel="All owners"
          value={filters.owner}
          values={options.owner}
          onChange={(value) => onFilterChange("owner", value)}
        />
        <FilterSelect
          id="board-type"
          ariaLabel="Filter by task type"
          allLabel="All task types"
          value={filters.type}
          values={options.type}
          onChange={(value) => onFilterChange("type", value)}
        />
        <FilterSelect
          id="board-status"
          ariaLabel="Filter by status"
          allLabel="All statuses"
          value={filters.status}
          values={options.status}
          onChange={(value) => onFilterChange("status", value)}
        />
      </div>

      <div className="agent-board-toolbar__meta">
        <span className="agent-board-toolbar__shown">
          {visibleCount === totalCount ? `${totalCount} shown` : `${visibleCount} of ${totalCount}`}
        </span>
        <span className={`agent-board-toolbar__live agent-board-toolbar__live--${status}`}>
          <i aria-hidden="true" />
          {STATUS_LABELS[status]}
        </span>
        <button type="button" className="agent-board-toolbar__refresh" onClick={onRefresh} disabled={refreshing}>
          <RefreshIcon spinning={refreshing} />
          <span>{refreshing ? "Refreshing" : "Refresh"}</span>
        </button>
      </div>
    </header>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.3" />
      <path d="m10.25 10.25 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m5 6.25 3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RefreshIcon({ spinning }: { readonly spinning: boolean }) {
  return (
    <svg className={spinning ? "is-spinning" : undefined} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13.25 6.25A5.5 5.5 0 1 0 13 10.5M13.25 2.75v3.5h-3.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
