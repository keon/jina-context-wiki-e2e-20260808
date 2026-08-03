"use client";

import { useEffect, useMemo, useState } from "react";
import { formatTime, humanize, shortId } from "../../lib/format.ts";
import { operationsApiUrl, tenantDashboardApiUrl } from "../../lib/operations-api.ts";
import { usePoll } from "../../lib/poll.ts";
import type { ContextBuildListResponse, ContextBuildSummary, ContextRelease } from "../../lib/types.ts";
import { useTenant } from "../../v1/providers.tsx";
import { BuildCheckpoints } from "./build-checkpoints.tsx";
import { ContextBrowser } from "./context-browser.tsx";
import { IssueGraphBrowser } from "./issue-graph-browser.tsx";

export function ContextPage({ view = "wiki" }: { readonly view?: "wiki" | "causal-graph" }) {
  const { selected } = useTenant();
  const releasesPath = selected ? operationsApiUrl(selected.tenantId, "context/releases") : "";
  const buildsPath = selected ? tenantDashboardApiUrl(selected.tenantId, "context/builds") : "";
  const releasesResource = usePoll<{ readonly releases: readonly ContextRelease[] }>(releasesPath, 10_000);
  const buildsResource = usePoll<ContextBuildListResponse>(buildsPath, 5_000);
  // Preserve API order: the authoritative current pointer leads historical
  // releases even when an operator intentionally rolls back to an older one.
  const releases = useMemo(() => releasesResource.data?.releases ?? [], [releasesResource.data]);
  const builds = useMemo(
    () =>
      [...(buildsResource.data?.builds ?? [])].sort(
        (left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
      ),
    [buildsResource.data]
  );
  const scopes = useMemo(() => {
    const byKey = new Map<string, { repository: string; ref: string }>();
    for (const item of [...releases, ...builds]) {
      const key = `${item.repository}\0${item.ref}`;
      if (!byKey.has(key)) byKey.set(key, { repository: item.repository, ref: item.ref });
    }
    return [...byKey.values()].sort((left, right) => {
      const leftRelease = releases.find(
        (candidate) => candidate.repository === left.repository && candidate.ref === left.ref
      );
      const rightRelease = releases.find(
        (candidate) => candidate.repository === right.repository && candidate.ref === right.ref
      );
      const leftBuild = builds.find(
        (candidate) => candidate.repository === left.repository && candidate.ref === left.ref
      );
      const rightBuild = builds.find(
        (candidate) => candidate.repository === right.repository && candidate.ref === right.ref
      );
      const leftTime = leftRelease?.publishedAt ?? leftRelease?.createdAt ?? leftBuild?.updatedAt ?? "";
      const rightTime = rightRelease?.publishedAt ?? rightRelease?.createdAt ?? rightBuild?.updatedAt ?? "";
      return (
        rightTime.localeCompare(leftTime) ||
        left.repository.localeCompare(right.repository) ||
        left.ref.localeCompare(right.ref)
      );
    });
  }, [builds, releases]);
  const [scopeKey, setScopeKey] = useState("");

  useEffect(() => {
    const stillExists = scopes.some((scope) => `${scope.repository}\0${scope.ref}` === scopeKey);
    if (!stillExists) {
      const first =
        view === "causal-graph"
          ? scopes.find((scope) =>
              builds.some(
                (candidate) =>
                  candidate.repository === scope.repository &&
                  candidate.ref === scope.ref &&
                  candidate.buildKind === "causal_graph" &&
                  candidate.status === "completed"
              )
            ) ?? scopes[0]
          : scopes[0];
      setScopeKey(first ? `${first.repository}\0${first.ref}` : "");
    }
  }, [builds, scopeKey, scopes, view]);

  const [repository = "", ref = ""] = scopeKey.split("\0");
  const release = releases.find((candidate) => candidate.repository === repository && candidate.ref === ref);
  const scopeReleases = releases.filter((candidate) => candidate.repository === repository && candidate.ref === ref);
  const build = preferredBuild(
    builds.filter(
      (candidate) =>
        candidate.repository === repository && candidate.ref === ref && candidate.buildKind !== "causal_graph"
    )
  );
  const causalGraphBuild = preferredBuild(
    builds.filter(
      (candidate) =>
        candidate.repository === repository && candidate.ref === ref && candidate.buildKind === "causal_graph"
    )
  );

  return (
    <section id="context-page" className="context-page">
      <header className="context-page-header">
        <div>
          <span className="context-eyebrow">{view === "causal-graph" ? "Repository history" : "Repository context"}</span>
          <h1>{view === "causal-graph" ? "Causal Graph" : "Context Wiki"}</h1>
          <p>
            {view === "causal-graph"
              ? "Trace commit-derived issues, evidence, and causal relationships across repository history."
              : "Browse derived documentation, verified source citations, and build checkpoints for one immutable repository view."}
          </p>
        </div>
        <label className="context-scope-picker">
          <span>Repository and ref</span>
          <select value={scopeKey} disabled={scopes.length === 0} onChange={(event) => setScopeKey(event.target.value)}>
            {scopes.length === 0 ? <option value="">No published context</option> : null}
            {scopes.map((scope) => {
              const value = `${scope.repository}\0${scope.ref}`;
              return (
                <option key={value} value={value}>
                  {scope.repository} @ {scope.ref}
                </option>
              );
            })}
          </select>
        </label>
      </header>

      {view === "wiki" && release ? (
        <>
          <ReleaseStrip release={release} />
          {build ? <BuildCheckpoints build={build} release={release} /> : null}
          <ContextBrowser
            release={release}
            releases={scopeReleases}
            apiBasePath={operationsApiUrl(selected!.tenantId, "context")}
          />
        </>
      ) : view === "wiki" ? (
        <>
          {build ? <BuildCheckpoints build={build} /> : null}
          <section className="context-empty-state" aria-live="polite">
            <strong>No published context release</strong>
            <p>
              Citation-valid pages remain private, resumable checkpoints until the entire catalog passes its source,
              maintenance-task, and certification gates and publishes atomically.
            </p>
          </section>
        </>
      ) : null}
      {view === "causal-graph" && repository && ref ? (
        <IssueGraphBrowser
          repository={repository}
          ref={ref}
          build={causalGraphBuild}
          apiBasePath={operationsApiUrl(selected!.tenantId, "causal-graph")}
        />
      ) : null}
    </section>
  );
}

function ReleaseStrip({ release }: { readonly release: ContextRelease }) {
  return (
    <section className="context-generation-strip" aria-label="Selected release">
      <ReleaseFact label="Release" value={shortId(release.id)} title={release.id} />
      <ReleaseFact label="Commit" value={release.commitSha.slice(0, 12)} mono />
      <ReleaseFact label="Published" value={formatTime(release.publishedAt ?? release.createdAt)} />
      <ReleaseFact label="Context" value={humanize(release.contextStatus)} />
      <ReleaseFact
        label="Publication"
        value={release.completeness === "complete" ? "Certified complete" : "Partial"}
        tone={release.completeness === "complete" ? "good" : "warning"}
      />
    </section>
  );
}

function ReleaseFact({
  label,
  value,
  mono = false,
  tone,
  title
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
  readonly tone?: "good" | "warning";
  readonly title?: string;
}) {
  return (
    <div className="context-generation-fact">
      <span>{label}</span>
      <strong title={title} className={`${mono ? "mono" : ""}${tone ? ` ${tone}` : ""}`}>
        {value}
      </strong>
    </div>
  );
}

function preferredBuild(builds: readonly ContextBuildSummary[]): ContextBuildSummary | undefined {
  return [...builds].sort((left, right) => {
    const priority = (status: ContextBuildSummary["status"]) => (status === "active" ? 0 : status === "failed" ? 1 : 2);
    return priority(left.status) - priority(right.status) || right.updatedAt.localeCompare(left.updatedAt);
  })[0];
}
