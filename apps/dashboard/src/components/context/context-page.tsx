"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
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
interface RepositoryOption {
  readonly name: string;
  readonly defaultBranch: string;
}
interface WikiVersion {
  readonly key: string;
  readonly kind: "branch" | "commit";
  readonly ref: string;
  readonly release?: ContextRelease;
}
interface PendingDocument {
  readonly releaseId: string;
  readonly documentId: string;
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
  const repositoryOptions = useMemo(
    () => buildRepositoryOptions(repositories, scopes),
    [repositories, scopes]
  );
  const [scopeKey, setScopeKey] = useState("");
  const [scopeWasChosen, setScopeWasChosen] = useState(false);
  const [wikiRepository, setWikiRepository] = useState("");
  const [wikiVersionKey, setWikiVersionKey] = useState("");
  const [pendingDocument, setPendingDocument] = useState<PendingDocument | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [building, setBuilding] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (view !== "causal-graph" || buildsResource.data === undefined) return;
    const currentExists = scopes.some((scope) => scopeValue(scope) === scopeKey);
    const completedGraph = scopes.find((scope) =>
      builds.some(
        (build) =>
          build.repository === scope.repository &&
          build.ref === scope.ref &&
          build.buildKind === "causal_graph" &&
          build.status === "completed"
      )
    );
    if (!currentExists || (!scopeWasChosen && completedGraph)) {
      const next = completedGraph ?? scopes[0];
      setScopeKey(next ? scopeValue(next) : "");
    }
  }, [builds, buildsResource.data, scopeKey, scopeWasChosen, scopes, view]);

  useEffect(() => {
    if (view !== "wiki") return;
    if (!wikiRepository) {
      if (wikiVersionKey) setWikiVersionKey("");
      return;
    }
    const currentRepository = repositoryOptions.find((item) => item.name === wikiRepository);
    if (!currentRepository) {
      setWikiRepository("");
      setWikiVersionKey("");
      setPendingDocument(null);
      return;
    }
    const versions = buildWikiVersions(currentRepository, releases, builds);
    const nextVersion = versions.find((item) => item.key === wikiVersionKey) ?? versions[0];
    if (wikiVersionKey !== nextVersion?.key) setWikiVersionKey(nextVersion?.key ?? "");
  }, [builds, releases, repositoryOptions, view, wikiRepository, wikiVersionKey]);

  const wikiRepositoryOption = repositoryOptions.find((item) => item.name === wikiRepository);
  const wikiVersions = useMemo(
    () => (wikiRepositoryOption ? buildWikiVersions(wikiRepositoryOption, releases, builds) : []),
    [builds, releases, wikiRepositoryOption]
  );
  const wikiVersion = wikiVersions.find((item) => item.key === wikiVersionKey) ?? wikiVersions[0];
  const [graphRepository = "", graphRef = ""] = scopeKey.split("\0");
  const repository = view === "wiki" ? wikiRepository : graphRepository;
  const ref = view === "wiki" ? (wikiVersion?.ref ?? wikiRepositoryOption?.defaultBranch ?? "") : graphRef;
  const release =
    view === "wiki"
      ? wikiVersion?.release ?? releases.find((item) => item.repository === repository && item.ref === ref)
      : releases.find((item) => item.repository === repository && item.ref === ref);
  const releaseHistory = releases.filter((item) => item.repository === repository && item.ref === ref);
  const workspaceSearchReleases = useMemo(
    () => currentRepositoryReleases(repositoryOptions, releases, release),
    [release, releases, repositoryOptions]
  );
  const documentationBuildCandidates = builds.filter(
    (item) => item.repository === repository && item.ref === ref && item.buildKind !== "causal_graph"
  );
  const documentationBuild = newestContextBuild(
    wikiVersion?.kind === "commit" && release?.commitSha
      ? documentationBuildCandidates.filter((item) => item.commitSha === release.commitSha)
      : documentationBuildCandidates
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
          body: JSON.stringify(
            view === "causal-graph"
              ? { repository, ref }
              : {
                  repository,
                  ref,
                  ...(wikiVersion?.kind === "commit" && release?.commitSha ? { commitSha: release.commitSha } : {})
                }
          )
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

  function selectWikiRepository(nextRepository: string) {
    const option = repositoryOptions.find((item) => item.name === nextRepository);
    setWikiRepository(nextRepository);
    setWikiVersionKey(option ? branchVersionValue(option.defaultBranch) : "");
    setPendingDocument(null);
    setNotice("");
  }

  function selectWikiVersion(nextVersion: string) {
    setWikiVersionKey(nextVersion);
    setPendingDocument(null);
    setNotice("");
  }

  function returnToRepositoryPicker() {
    setWikiRepository("");
    setWikiVersionKey("");
    setPendingDocument(null);
    setNotice("");
  }

  function openWikiSearchResult(nextRelease: ContextRelease, documentId: string) {
    setWikiRepository(nextRelease.repository);
    setWikiVersionKey(releaseVersionValue(nextRelease.id));
    setPendingDocument({ releaseId: nextRelease.id, documentId });
    setNotice("");
  }

  return (
    <section className="knowledge-page" id={view === "wiki" ? "context-page" : "causal-graph-page"}>
      <h1 className="sr-only">{view === "wiki" ? "Context Wiki" : "Causal Graph"}</h1>

      {view === "causal-graph" || wikiRepository ? (
        <header className="knowledge-toolbar">
          <div className="knowledge-toolbar__identity" aria-hidden="true">
            <span className="knowledge-toolbar__icon">{view === "wiki" ? <BookIcon /> : <GraphIcon />}</span>
            <span>{view === "wiki" ? "Repository context" : "Repository history"}</span>
          </div>

        {view === "wiki" ? (
          <div className="knowledge-toolbar__selectors">
            <button
              type="button"
              className="knowledge-toolbar__selected-repository"
              onClick={returnToRepositoryPicker}
              aria-label={`Change repository. Currently ${wikiRepository}`}
            >
              <RepositoryIcon />
              <span>
                <small>Repository</small>
                <strong>{wikiRepository}</strong>
              </span>
              <span className="knowledge-toolbar__change">Change</span>
            </button>
            <label className="knowledge-toolbar__field knowledge-toolbar__field--version">
              <span>Version</span>
              <span className="knowledge-toolbar__scope">
                <select
                  aria-label="Wiki version"
                  value={wikiVersion?.key ?? ""}
                  disabled={wikiVersions.length === 0}
                  onChange={(event) => selectWikiVersion(event.target.value)}
                >
                  {wikiVersions.length === 0 ? <option value="">No versions available</option> : null}
                  <optgroup label="Branches">
                    {wikiVersions
                      .filter((version) => version.kind === "branch")
                      .map((version) => (
                        <option key={version.key} value={version.key}>
                          {version.ref === wikiRepositoryOption?.defaultBranch
                            ? `Default · ${version.ref}`
                            : `Branch · ${version.ref}`}
                        </option>
                      ))}
                  </optgroup>
                  <optgroup label="Specific commits">
                    {wikiVersions
                      .filter((version) => version.kind === "commit" && version.release)
                      .map((version) => (
                        <option key={version.key} value={version.key}>
                          {version.release!.commitSha.slice(0, 12)} · {version.ref}
                        </option>
                      ))}
                  </optgroup>
                </select>
                <ChevronIcon />
              </span>
            </label>
          </div>
        ) : (
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
        )}

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
      ) : null}

      {notice ? (
        <p className="knowledge-notice" role="status">
          {notice}
        </p>
      ) : null}

      {view === "wiki" && !wikiRepository ? (
        <RepositoryPicker repositories={repositoryOptions} onSelect={selectWikiRepository} />
      ) : !selected ? (
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
              key={release.id}
              release={release}
              releases={releaseHistory}
              workspaceReleases={workspaceSearchReleases}
              {...(pendingDocument?.releaseId === release.id
                ? { initialDocumentId: pendingDocument.documentId }
                : {})}
              apiBasePath={operationsApiUrl(selected.tenantId, "context")}
              onOpenReleaseDocument={openWikiSearchResult}
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

export function RepositoryPicker({
  repositories,
  onSelect
}: {
  readonly repositories: readonly RepositoryOption[];
  readonly onSelect: (repository: string) => void;
}) {
  return (
    <section className="knowledge-repository-picker" aria-label="Choose a repository">
      <div className="knowledge-repository-grid">
        <Link className="knowledge-repository-card knowledge-repository-card--add" href="/integrations">
          <PlusIcon />
          <span>
            <strong>Add repo</strong>
            <small>Connect another GitHub repository</small>
          </span>
          <ForwardIcon />
        </Link>
        {repositories.map((repository) => {
          const { owner, name } = repositoryLabel(repository.name);
          return (
            <button
              type="button"
              className="knowledge-repository-card"
              key={repository.name}
              onClick={() => onSelect(repository.name)}
            >
              <RepositoryIcon />
              <span>
                <strong>{name}</strong>
                <small>{owner}</small>
              </span>
              <ForwardIcon />
            </button>
          );
        })}
      </div>
    </section>
  );
}

function repositoryLabel(repository: string) {
  const separator = repository.lastIndexOf("/");
  if (separator < 0) return { owner: "Repository", name: repository };
  return { owner: repository.slice(0, separator), name: repository.slice(separator + 1) };
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

function buildRepositoryOptions(
  repositories: readonly Repository[],
  scopes: readonly Scope[]
): RepositoryOption[] {
  const byName = new Map<string, RepositoryOption>();
  for (const repository of repositories) {
    byName.set(repository.name, repository);
  }
  for (const scope of scopes) {
    if (!byName.has(scope.repository)) {
      byName.set(scope.repository, { name: scope.repository, defaultBranch: scope.ref });
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function buildWikiVersions(
  repository: RepositoryOption,
  releases: readonly ContextRelease[],
  builds: readonly ContextBuildSummary[]
): WikiVersion[] {
  const refs = new Set<string>([repository.defaultBranch]);
  for (const release of releases) {
    if (release.repository === repository.name) refs.add(release.ref);
  }
  for (const build of builds) {
    if (build.repository === repository.name && build.buildKind !== "causal_graph") refs.add(build.ref);
  }

  const branchVersions = [...refs]
    .sort((left, right) => {
      if (left === repository.defaultBranch) return -1;
      if (right === repository.defaultBranch) return 1;
      return left.localeCompare(right);
    })
    .map((ref): WikiVersion => {
      const release = releases.find((item) => item.repository === repository.name && item.ref === ref);
      return {
        key: branchVersionValue(ref),
        kind: "branch",
        ref,
        ...(release ? { release } : {})
      };
    });

  const commitVersions = releases
    .filter((release) => release.repository === repository.name)
    .sort((left, right) =>
      (right.publishedAt ?? right.createdAt).localeCompare(left.publishedAt ?? left.createdAt)
    )
    .map((release): WikiVersion => ({
      key: releaseVersionValue(release.id),
      kind: "commit",
      ref: release.ref,
      release
    }));

  return [...branchVersions, ...commitVersions];
}

function currentRepositoryReleases(
  repositories: readonly RepositoryOption[],
  releases: readonly ContextRelease[],
  activeRelease?: ContextRelease
): ContextRelease[] {
  const byRepository = new Map<string, ContextRelease>();
  for (const repository of repositories) {
    const current =
      releases.find(
        (release) => release.repository === repository.name && release.ref === repository.defaultBranch
      ) ?? releases.find((release) => release.repository === repository.name);
    if (current) byRepository.set(repository.name, current);
  }
  if (activeRelease) byRepository.set(activeRelease.repository, activeRelease);
  return repositories.flatMap((repository) => {
    const release = byRepository.get(repository.name);
    return release ? [release] : [];
  });
}

function branchVersionValue(ref: string) {
  return `branch\0${ref}`;
}

function releaseVersionValue(releaseId: string) {
  return `release\0${releaseId}`;
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

function RepositoryIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.25" />
      <path d="M7 3v14M10 7h4M10 10h4M10 13h3" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function ForwardIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="m7 5 5 5-5 5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
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
