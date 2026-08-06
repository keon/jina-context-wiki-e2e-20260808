"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { contextBuildUrl, contextRepositoriesUrl } from "../../dashboard/lib/context.ts";
import { isTenantWritable } from "../../dashboard/lib/tenants.ts";
import { useTenant } from "../../dashboard/providers.tsx";
import { newestContextBuild } from "../../lib/context-builds.ts";
import { formatTime, humanize, shortId } from "../../lib/format.ts";
import { operationsApiUrl, tenantDashboardApiUrl } from "../../lib/operations-api.ts";
import { usePoll } from "../../lib/poll.ts";
import type { ContextBuildListResponse, ContextBuildSummary, ContextRelease } from "../../lib/types.ts";
import { BuildCheckpoints } from "./build-checkpoints.tsx";
import { IssueGraphBrowser } from "./issue-graph-browser.tsx";

/**
 * The wiki reader pulls in react-markdown/remark-gfm (~40KB gzipped of
 * unified/micromark). This component also serves /causal-graph, which never
 * renders it, so it is fetched only once a published wiki release is shown.
 */
const ContextBrowser = dynamic(() => import("./context-browser.tsx").then((module) => module.ContextBrowser), {
  ssr: false,
  loading: () => <KnowledgeLoading />
});

type ContextView = "wiki" | "causal-graph";
interface Repository {
  readonly name: string;
  readonly defaultBranch: string;
}
interface Scope {
  readonly repository: string;
  readonly ref: string;
  readonly updatedAt: string;
}

export function ContextPage({ view = "wiki" }: { readonly view?: ContextView }) {
  const { selected } = useTenant();
  const tenantId = selected?.tenantId ?? "";
  const repositoriesResource = usePoll<{ readonly repositories?: readonly Repository[] }>(
    selected ? contextRepositoriesUrl(selected) : "",
    15_000
  );
  const releasesResource = usePoll<{ readonly releases: readonly ContextRelease[] }>(
    selected ? operationsApiUrl(tenantId, "context/releases") : "",
    10_000
  );
  const buildsResource = usePoll<ContextBuildListResponse>(
    selected ? tenantDashboardApiUrl(tenantId, "context/builds") : "",
    5_000
  );

  const repositories = useMemo(() => repositoriesResource.data?.repositories ?? [], [repositoriesResource.data]);
  const releases = useMemo(() => releasesResource.data?.releases ?? [], [releasesResource.data]);
  const builds = useMemo(
    () =>
      [...(buildsResource.data?.builds ?? [])].sort(
        (left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
      ),
    [buildsResource.data]
  );
  const scopes = useMemo(() => buildScopes(repositories, releases, builds), [builds, releases, repositories]);
  const [scopeKey, setScopeKey] = useState("");
  const [scopeWasChosen, setScopeWasChosen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [building, setBuilding] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (view === "causal-graph" && buildsResource.data === undefined) return;
    const currentExists = scopes.some((scope) => scopeValue(scope) === scopeKey);
    const completedGraph =
      view === "causal-graph"
        ? scopes.find((scope) =>
            builds.some(
              (build) =>
                build.repository === scope.repository &&
                build.ref === scope.ref &&
                build.buildKind === "causal_graph" &&
                build.status === "completed"
            )
          )
        : undefined;
    if (!currentExists || (!scopeWasChosen && completedGraph)) {
      const next = completedGraph ?? scopes[0];
      setScopeKey(next ? scopeValue(next) : "");
    }
  }, [builds, buildsResource.data, scopeKey, scopeWasChosen, scopes, view]);

  const [repository = "", ref = ""] = scopeKey.split("\0");
  const release = releases.find((item) => item.repository === repository && item.ref === ref);
  const releaseHistory = releases.filter((item) => item.repository === repository && item.ref === ref);
  const documentationBuild = newestContextBuild(
    builds.filter((item) => item.repository === repository && item.ref === ref && item.buildKind !== "causal_graph")
  );
  const graphBuild = newestContextBuild(
    builds.filter((item) => item.repository === repository && item.ref === ref && item.buildKind === "causal_graph")
  );
  const activeBuild = view === "causal-graph" ? graphBuild : documentationBuild;
  const writable = isTenantWritable(selected);
  const loading =
    Boolean(selected) &&
    repositoriesResource.online === undefined &&
    releasesResource.online === undefined &&
    buildsResource.online === undefined;
  const unavailable =
    Boolean(selected) &&
    repositoriesResource.online === false &&
    releasesResource.online === false &&
    buildsResource.online === false;

  async function refresh() {
    setRefreshing(true);
    await Promise.all([repositoriesResource.refresh(), releasesResource.refresh(), buildsResource.refresh()]);
    setRefreshing(false);
  }

  async function startBuild() {
    if (!selected || !repository || building || !writable) return;
    setBuilding(true);
    setNotice("");
    try {
      const response = await fetch(
        view === "causal-graph"
          ? tenantDashboardApiUrl(selected.tenantId, "causal-graph/build")
          : contextBuildUrl(selected),
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(view === "causal-graph" ? { repository, ref } : { repository })
        }
      );
      if (!response.ok) {
        throw new Error(
          response.status === 403
            ? "Organization admin access is required to start a build."
            : `The build could not be started (${response.status}).`
        );
      }
      setNotice(view === "causal-graph" ? "Causal graph build started." : "Context Wiki build started.");
      await Promise.all([buildsResource.refresh(), releasesResource.refresh()]);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "The build could not be started.");
    } finally {
      setBuilding(false);
    }
  }

  return (
    <section className="knowledge-page" id={view === "wiki" ? "context-page" : "causal-graph-page"}>
      <h1 className="sr-only">{view === "wiki" ? "Context Wiki" : "Causal Graph"}</h1>

      <header className="knowledge-toolbar">
        <div className="knowledge-toolbar__identity" aria-hidden="true">
          <span className="knowledge-toolbar__icon">{view === "wiki" ? <BookIcon /> : <GraphIcon />}</span>
          <span>{view === "wiki" ? "Repository context" : "Repository history"}</span>
        </div>

        <label className="knowledge-toolbar__scope">
          <span className="sr-only">Repository and ref</span>
          <select
            aria-label="Repository and ref"
            value={scopeKey}
            disabled={scopes.length === 0}
            onChange={(event) => {
              setScopeWasChosen(true);
              setScopeKey(event.target.value);
              setNotice("");
            }}
          >
            {scopes.length === 0 ? <option value="">No repositories available</option> : null}
            {scopes.map((scope) => (
              <option key={scopeValue(scope)} value={scopeValue(scope)}>
                {scope.repository} / {scope.ref}
              </option>
            ))}
          </select>
          <ChevronIcon />
        </label>

        <div className="knowledge-toolbar__meta">
          {activeBuild ? (
            <span className={`knowledge-pill knowledge-pill--${activeBuild.status}`}>
              <i aria-hidden="true" />
              {humanize(activeBuild.status)}
            </span>
          ) : release && view === "wiki" ? (
            <span className="knowledge-pill knowledge-pill--completed">
              <i aria-hidden="true" />
              Published
            </span>
          ) : null}
          <button
            type="button"
            className="knowledge-button knowledge-button--primary"
            disabled={!repository || building || !writable}
            onClick={() => void startBuild()}
          >
            <PlayIcon />
            {building ? "Starting…" : view === "wiki" ? "Build wiki" : "Build graph"}
          </button>
          <button
            type="button"
            className="knowledge-button"
            disabled={refreshing || !selected}
            onClick={() => void refresh()}
          >
            <RefreshIcon spinning={refreshing} />
            {refreshing ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </header>

      {notice ? (
        <p className="knowledge-notice" role="status">
          {notice}
        </p>
      ) : null}

      {!selected ? (
        <KnowledgePlaceholder
          kind={view}
          title="No workspace selected"
          description="Choose a workspace from the sidebar to explore its repository knowledge."
        />
      ) : loading ? (
        <KnowledgeLoading />
      ) : unavailable ? (
        <KnowledgePlaceholder
          kind={view}
          title="Repository knowledge is unavailable"
          description="The data service could not be reached. Refresh to try again."
          action={
            <button className="knowledge-button" onClick={() => void refresh()}>
              Retry
            </button>
          }
        />
      ) : scopes.length === 0 ? (
        <KnowledgePlaceholder
          kind={view}
          title="No repositories connected"
          description="Connect a GitHub repository before building repository knowledge."
        />
      ) : (
        <>
          {view === "wiki" && release ? <ReleaseSummary release={release} /> : null}
          {activeBuild ? (
            <BuildCheckpoints
              build={activeBuild}
              tenantId={selected.tenantId}
              release={view === "wiki" ? release : undefined}
            />
          ) : null}

          {view === "wiki" && release ? (
            <ContextBrowser
              release={release}
              releases={releaseHistory}
              apiBasePath={operationsApiUrl(selected.tenantId, "context")}
            />
          ) : view === "wiki" ? (
            <KnowledgePlaceholder
              kind="wiki"
              compact
              title={`No wiki published for ${repository} / ${ref}`}
              description="Build the wiki to generate grounded documentation and verified source citations."
              action={
                <button
                  className="knowledge-button knowledge-button--primary"
                  disabled={building || !writable}
                  onClick={() => void startBuild()}
                >
                  Build wiki
                </button>
              }
            />
          ) : null}

          {view === "causal-graph" && repository && ref ? (
            /* Keyed on the viewed scope so switching repository/ref resets the browser,
               while build progress ticks leave the user's filter and selection intact. */
            <IssueGraphBrowser
              key={`${selected.tenantId}\0${repository}\0${ref}`}
              repository={repository}
              ref={ref}
              build={graphBuild}
              apiBasePath={operationsApiUrl(selected.tenantId, "causal-graph")}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

function buildScopes(
  repositories: readonly Repository[],
  releases: readonly ContextRelease[],
  builds: readonly ContextBuildSummary[]
): Scope[] {
  const byKey = new Map<string, Scope>();
  for (const repository of repositories) {
    const scope: Scope = { repository: repository.name, ref: repository.defaultBranch, updatedAt: "" };
    byKey.set(scopeValue(scope), scope);
  }
  for (const item of releases) {
    const scope: Scope = {
      repository: item.repository,
      ref: item.ref,
      updatedAt: item.publishedAt ?? item.createdAt
    };
    const current = byKey.get(scopeValue(scope));
    if (!current || current.updatedAt < scope.updatedAt) byKey.set(scopeValue(scope), scope);
  }
  for (const item of builds) {
    const scope: Scope = { repository: item.repository, ref: item.ref, updatedAt: item.updatedAt };
    const current = byKey.get(scopeValue(scope));
    if (!current || current.updatedAt < scope.updatedAt) byKey.set(scopeValue(scope), scope);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.repository.localeCompare(right.repository) ||
      left.ref.localeCompare(right.ref)
  );
}

function scopeValue(scope: Pick<Scope, "repository" | "ref">) {
  return `${scope.repository}\0${scope.ref}`;
}

function ReleaseSummary({ release }: { readonly release: ContextRelease }) {
  return (
    <section className="knowledge-release" aria-label="Published context release">
      <ReleaseFact label="Release" value={shortId(release.id)} title={release.id} />
      <ReleaseFact label="Commit" value={release.commitSha.slice(0, 12)} mono />
      <ReleaseFact label="Published" value={formatTime(release.publishedAt ?? release.createdAt)} />
      <ReleaseFact label="Coverage" value={release.completeness === "complete" ? "Certified complete" : "Partial"} />
    </section>
  );
}

function ReleaseFact({
  label,
  value,
  mono = false,
  title
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
  readonly title?: string;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong className={mono ? "mono" : undefined} title={title}>
        {value}
      </strong>
    </div>
  );
}

function KnowledgePlaceholder({
  kind,
  title,
  description,
  action,
  compact = false
}: {
  readonly kind: ContextView;
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
  readonly compact?: boolean;
}) {
  return (
    <div className={`knowledge-placeholder${compact ? " knowledge-placeholder--compact" : ""}`}>
      <span className="knowledge-placeholder__icon" aria-hidden="true">
        {kind === "wiki" ? <BookIcon /> : <GraphIcon />}
      </span>
      <strong>{title}</strong>
      <p>{description}</p>
      {action ? <div>{action}</div> : null}
    </div>
  );
}

function KnowledgeLoading() {
  return (
    <div className="knowledge-loading" aria-label="Loading repository knowledge" aria-busy="true">
      <span />
      <span />
      <span />
    </div>
  );
}

function BookIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M3.5 4.25A2.25 2.25 0 0 1 5.75 2H10v14H5.75a2.25 2.25 0 0 0-2.25 2V4.25Z"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M16.5 4.25A2.25 2.25 0 0 0 14.25 2H10v14h4.25a2.25 2.25 0 0 1 2.25 2V4.25Z"
        stroke="currentColor"
        strokeWidth="1.25"
      />
    </svg>
  );
}

function GraphIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="4.5" cy="6" r="2" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="15.5" cy="4.5" r="2" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="12.5" cy="15.5" r="2" stroke="currentColor" strokeWidth="1.25" />
      <path d="m6.4 5.75 7.15-.9M5.6 7.7l5.75 6.2m3.55-7.5-1.8 7.15" stroke="currentColor" strokeWidth="1.25" />
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

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m6 4.25 5 3.75-5 3.75z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
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
