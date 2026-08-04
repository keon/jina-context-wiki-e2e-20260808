"use client";

import {
  FormEvent,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { useDashboard, useTenant, useTenantFence } from "../providers";
import {
  contextBuildCancelUrl,
  contextBuildProgressUrl,
  contextBuildsUrl,
  contextBuildUrl,
  contextDocumentUrl,
  contextDocumentsUrl,
  contextReleasesUrl,
  contextRepositoriesUrl,
  formatCitation,
} from "../lib/context";
import {
  ancestorPaths,
  buildContextTree,
  categoryLabel,
  documentSubject,
  type ContextDocumentSummary,
  type ContextTreeNode,
} from "../lib/context-tree";
import { isTenantWritable } from "../lib/tenants";
import { githubInstallationUrl } from "../lib/github-installation";
import { ExternalLink } from "../components/ui";
import {
  contextBuildLabel,
  contextCheckpointCounts,
  contextDeadlineText,
  contextStageCounts,
  contextStageStatus,
  contextStageTiming,
  type ContextBuildStage,
  type ContextCheckpointPage,
} from "../lib/context-progress";

type Repository = { name: string; defaultBranch: string };

type ContextRelease = {
  id: string;
  repository: string;
  ref: string;
  commitSha: string;
  createdAt: string;
  publishedAt?: string;
  contextStatus: "available" | "partial" | "unavailable";
};

type DocumentDetail = ContextDocumentSummary & {
  bodyMarkdown: string;
  scope?: { ref?: string; commitSha?: string };
  citations: {
    repository?: string;
    commitSha?: string;
    path?: string;
    startLine?: number;
    endLine?: number;
  }[];
  events: { type: string; createdAt: string }[];
};

/** A build in flight, and the pages it has finished so far. */
type BuildProgress = {
  buildId: string;
  status: string;
  repository?: string;
  ref?: string;
  refSequence?: number;
  commitSha?: string;
  failureCode?: string;
  failureReason?: string;
  derivationDeadlineAt?: string;
  derivationBudgetSeconds?: number;
  derivationTokenBudget?: number;
  consumedModelTokens?: number;
  stages: ContextBuildStage[];
  pages: ContextCheckpointPage[];
  updatedAt?: string;
};

type BuildSummary = Omit<BuildProgress, "buildId" | "pages"> & {
  id: string;
};

async function fetchProfiledContextJson<T>(
  phase: string,
  url: string,
  errorMessage: (status: number) => string,
): Promise<T> {
  const startedAt = Date.now();
  let status = 0;
  let serverTiming: string | null = null;
  try {
    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
    });
    status = response.status;
    serverTiming = response.headers.get("server-timing");
    if (!response.ok) throw new Error(errorMessage(response.status));
    return (await response.json()) as T;
  } finally {
    console.info("context_load_profile", {
      phase,
      status,
      duration_ms: Date.now() - startedAt,
      server_timing: serverTiming,
    });
  }
}

export default function ContextPage() {
  const { viewer } = useDashboard();
  const { selected } = useTenant();
  const isCurrentTenant = useTenantFence();

  const [documents, setDocuments] = useState<ContextDocumentSummary[]>([]);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repositoriesLoading, setRepositoriesLoading] = useState(false);
  const [repositoryError, setRepositoryError] = useState<string | null>(null);
  const [releases, setReleases] = useState<ContextRelease[]>([]);
  const [releasesLoading, setReleasesLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [repositoryFilter, setRepositoryFilter] = useState("");
  const [refFilter, setRefFilter] = useState("");

  const [buildRepository, setBuildRepository] = useState("");
  const [building, setBuilding] = useState(false);
  const [buildNotice, setBuildNotice] = useState<string | null>(null);
  const [cancelingBuildId, setCancelingBuildId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [activeBuilds, setActiveBuilds] = useState<BuildSummary[]>([]);
  const buildProgressEpochRef = useRef(0);
  // A derivation runs for up to ninety minutes and finishes its pages one at a
  // time, so the build it started is watched rather than waited on.
  const [progress, setProgress] = useState<BuildProgress | null>(null);

  const writable = isTenantWritable(selected);
  const taskCounts = progress ? contextStageCounts(progress.stages) : null;
  const checkpointCounts = progress
    ? contextCheckpointCounts(progress.pages)
    : null;

  const loadRepositories = useCallback(async () => {
    if (!selected) return;
    const requestTenantId = selected.tenantId;
    setRepositoriesLoading(true);
    setRepositoryError(null);
    try {
      const body = await fetchProfiledContextJson<{ repositories?: Repository[] }>(
        "repositories",
        contextRepositoriesUrl(selected),
        () => "Could not load connected repositories.",
      );
      if (!isCurrentTenant(requestTenantId)) return;
      const nextRepositories = body.repositories ?? [];
      setRepositories(nextRepositories);
      setRepositoryFilter((current) =>
        current && nextRepositories.some((entry) => entry.name === current)
          ? current
          : "",
      );
    } catch (cause) {
      if (!isCurrentTenant(requestTenantId)) return;
      setRepositories([]);
      setRepositoryError(
        cause instanceof Error
          ? cause.message
          : "Could not load connected repositories.",
      );
    } finally {
      if (isCurrentTenant(requestTenantId)) setRepositoriesLoading(false);
    }
  }, [selected, isCurrentTenant]);

  const loadReleases = useCallback(async (repository: string) => {
    if (!selected || !repository) return;
    const requestTenantId = selected.tenantId;
    setReleasesLoading(true);
    setError(null);
    try {
      const body = await fetchProfiledContextJson<{ releases?: ContextRelease[] }>(
        "releases",
        contextReleasesUrl(selected, repository),
        () => "Could not load context versions.",
      );
      if (!isCurrentTenant(requestTenantId)) return;
      const seen = new Set<string>();
      const nextReleases = (body.releases ?? [])
        .filter(
          (release) =>
            release.repository.toLowerCase() === repository.toLowerCase() &&
            release.contextStatus !== "unavailable" &&
            !seen.has(release.ref) &&
            seen.add(release.ref),
        )
        .sort((left, right) =>
          (right.publishedAt ?? right.createdAt).localeCompare(
            left.publishedAt ?? left.createdAt,
          ),
        );
      setReleases(nextReleases);
      const defaultBranch = repositories.find(
        (candidate) => candidate.name === repository,
      )?.defaultBranch;
      setRefFilter((current) =>
        current && nextReleases.some((release) => release.ref === current)
          ? current
          : nextReleases.find((release) => release.ref === defaultBranch)?.ref ??
            nextReleases[0]?.ref ??
            "",
      );
    } catch (cause) {
      if (!isCurrentTenant(requestTenantId)) return;
      setReleases([]);
      setRefFilter("");
      setError(
        cause instanceof Error ? cause.message : "Could not load context versions.",
      );
    } finally {
      if (isCurrentTenant(requestTenantId)) setReleasesLoading(false);
    }
  }, [selected, isCurrentTenant, repositories]);

  const loadDocuments = useCallback(async (repository: string, ref: string) => {
    if (!selected || !repository || !ref) return;
    const requestTenantId = selected.tenantId;
    setLoading(true);
    setError(null);
    try {
      const body = await fetchProfiledContextJson<{ documents?: ContextDocumentSummary[] }>(
        "documents",
        contextDocumentsUrl(selected, repository, ref),
        (status) =>
          status === 503
            ? "Context is not configured for this deployment."
            : "Context is temporarily unavailable.",
      );
      if (!isCurrentTenant(requestTenantId)) return;
      const nextDocuments = body.documents ?? [];
      setDocuments(nextDocuments);
    } catch (cause) {
      if (!isCurrentTenant(requestTenantId)) return;
      setDocuments([]);
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load context.",
      );
    } finally {
      if (isCurrentTenant(requestTenantId)) setLoading(false);
    }
  }, [selected, isCurrentTenant]);

  useEffect(() => {
    const requestTenantId = selected?.tenantId ?? null;
    buildProgressEpochRef.current += 1;
    setSelectedId("");
    setDetail(null);
    setExpanded(new Set());
    setDocuments([]);
    setLoading(false);
    setError(null);
    setRepositories([]);
    setRepositoriesLoading(false);
    setRepositoryError(null);
    setReleases([]);
    setReleasesLoading(false);
    setRepositoryFilter("");
    setRefFilter("");
    setProgress(null);
    setActiveBuilds([]);
    setBuildNotice(null);
    setCancelingBuildId(null);
    setCancelError(null);
    setBuildRepository("");
    void loadRepositories();
    if (!selected) return;
    fetch(contextBuildsUrl(selected), {
      credentials: "include",
      cache: "no-store",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { builds?: BuildSummary[] } | null) => {
        if (!isCurrentTenant(requestTenantId)) return;
        const activeBuilds = [...(body?.builds ?? [])]
          .filter((build) => build.status === "active")
          .sort((left, right) =>
            (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
          );
        setActiveBuilds(activeBuilds);
        const active = activeBuilds[0];
        if (!active) return;
        setBuildRepository(active.repository ?? "");
        setBuildNotice(
          active.repository
            ? `Building context for ${active.repository}.`
            : "Context build in progress.",
        );
        setProgress({
          ...active,
          buildId: active.id,
          stages: active.stages ?? [],
          pages: [],
        });
      })
      .catch(() => {});
  }, [loadRepositories, selected, isCurrentTenant]);

  useEffect(() => {
    setSelectedId("");
    setDetail(null);
    setExpanded(new Set());
    setDocuments([]);
    setReleases([]);
    setRefFilter("");
    setError(null);
    if (repositoryFilter) void loadReleases(repositoryFilter);
  }, [repositoryFilter, loadReleases]);

  useEffect(() => {
    setSelectedId("");
    setDetail(null);
    setExpanded(new Set());
    setDocuments([]);
    setError(null);
    if (repositoryFilter && refFilter) {
      void loadDocuments(repositoryFilter, refFilter);
    }
  }, [repositoryFilter, refFilter, loadDocuments]);

  useEffect(() => {
    if (!selected || !selectedId) {
      setDetail(null);
      return;
    }
    const selectedDocument = documents.find(
      (document) => document.id === selectedId,
    );
    if (!selectedDocument) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    fetch(
      contextDocumentUrl(
        selected,
        selectedDocument.repository,
        selectedDocument.releaseId,
        selectedDocument.id,
      ),
      {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
      },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load this document.");
        const body = (await response.json()) as { document: DocumentDetail };
        setDetail(body.document);
      })
      .catch((cause: unknown) => {
        if (cause instanceof Error && cause.name === "AbortError") return;
        setDetail(null);
      })
      .finally(() => setDetailLoading(false));
    return () => controller.abort();
  }, [documents, selected, selectedId]);

  const matching = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return documents.filter(
      (document) =>
        (!repositoryFilter || document.repository === repositoryFilter) &&
        (!needle ||
          document.title.toLowerCase().includes(needle) ||
          document.logicalId.toLowerCase().includes(needle) ||
          document.summary.toLowerCase().includes(needle)),
    );
  }, [documents, filter, repositoryFilter]);

  const tree = useMemo(() => buildContextTree(matching), [matching]);

  // A filtered tree is small enough to read at a glance, so it opens itself.
  useEffect(() => {
    if (!filter.trim()) return;
    const open = new Set<string>();
    const walk = (nodes: ContextTreeNode[]) => {
      for (const node of nodes) {
        if (node.kind !== "document") open.add(node.path);
        walk(node.children);
      }
    };
    walk(tree);
    setExpanded(open);
  }, [filter, tree]);

  // A documentation surface should open on a document, not an empty detail
  // pane. Keep the current selection when it remains visible and otherwise
  // reveal the first file in the active repository.
  useEffect(() => {
    if (matching.some((document) => document.id === selectedId)) return;
    const first = matching[0];
    if (!first) {
      setSelectedId("");
      return;
    }
    setSelectedId(first.id);
    const node = findDocumentNode(tree, first.id);
    if (node) {
      setExpanded((current) => {
        const next = new Set(current);
        for (const path of ancestorPaths(node.path)) next.add(path);
        return next;
      });
    }
  }, [matching, selectedId, tree]);

  const reveal = (node: ContextTreeNode) => {
    setExpanded((current) => {
      const next = new Set(current);
      for (const path of ancestorPaths(node.path)) next.add(path);
      return next;
    });
  };

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const build = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !buildRepository) return;
    const requestTenantId = selected.tenantId;
    setBuilding(true);
    setBuildNotice(null);
    try {
      const response = await fetch(contextBuildUrl(selected), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repository: buildRepository,
        }),
      });
      if (!response.ok) {
        throw new Error(
          response.status === 403
            ? "Only organization admins can build context."
            : "Could not start the build.",
        );
      }
      const started = (await response.json().catch(() => null)) as {
        task?: {
          id?: string;
          metadata?: {
            repository?: string;
            ref?: string;
            refSequence?: number;
            commitSha?: string;
          };
        };
      } | null;
      const buildId = started?.task?.id;
      const metadata = started?.task?.metadata;
      if (!isCurrentTenant(requestTenantId)) return;
      setBuildNotice(`Building context for ${buildRepository}.`);
      if (buildId) {
        const startedBuild: BuildSummary = {
          id: buildId,
          status: "active",
          repository: metadata?.repository ?? buildRepository,
          ref:
            metadata?.ref ??
            repositories.find((repository) => repository.name === buildRepository)
              ?.defaultBranch,
          refSequence: metadata?.refSequence,
          commitSha: metadata?.commitSha,
          stages: [],
          updatedAt: new Date().toISOString(),
        };
        setActiveBuilds((current) => [
          startedBuild,
          ...current.filter((build) => build.id !== buildId),
        ]);
        buildProgressEpochRef.current += 1;
        setProgress({ ...startedBuild, buildId, pages: [] });
      } else {
        setProgress(null);
      }
    } catch (cause) {
      setBuildNotice(
        cause instanceof Error ? cause.message : "Could not start the build.",
      );
    } finally {
      setBuilding(false);
    }
  };

  const applyBuildProgress = useCallback((next: BuildProgress) => {
    setProgress((current) => {
      if (current && current.buildId !== next.buildId) return current;
      return current ? { ...current, ...next } : next;
    });
    setActiveBuilds((current) =>
      current.map((build) =>
        build.id === next.buildId
          ? {
              ...build,
              status: next.status,
              repository: next.repository,
              ref: next.ref,
              stages: next.stages,
              updatedAt: next.updatedAt,
            }
          : build,
      ),
    );
  }, []);

  const cancelBuild = async () => {
    const buildId = progress?.buildId;
    if (!selected || !buildId || progress.status !== "active" || !writable) return;
    if (!window.confirm("Cancel this Context build? Completed checkpoints will be retained.")) return;

    const requestTenantId = selected.tenantId;
    let cancellationAccepted = false;
    buildProgressEpochRef.current += 1;
    setCancelingBuildId(buildId);
    setCancelError(null);
    try {
      const response = await fetch(contextBuildCancelUrl(selected, buildId), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) {
        throw new Error(
          response.status === 403
            ? "Only organization admins can cancel Context builds."
            : "Could not cancel this Context build.",
        );
      }
      cancellationAccepted = true;

      const progressResponse = await fetch(contextBuildProgressUrl(selected, buildId), {
        credentials: "include",
        cache: "no-store",
      });
      if (!progressResponse.ok) {
        throw new Error("The build was canceled, but its latest status could not be refreshed yet.");
      }
      const next = (await progressResponse.json()) as BuildProgress;
      if (!isCurrentTenant(requestTenantId)) return;
      // Ignore any progress poll that began before cancellation completed.
      buildProgressEpochRef.current += 1;
      applyBuildProgress(next);
    } catch (cause) {
      if (!isCurrentTenant(requestTenantId)) return;
      setCancelError(
        cause instanceof Error
          ? cause.message
          : cancellationAccepted
            ? "The build was canceled, but its latest status could not be refreshed yet."
            : "Could not cancel this Context build.",
      );
    } finally {
      if (isCurrentTenant(requestTenantId)) {
        setCancelingBuildId((current) => (current === buildId ? null : current));
      }
    }
  };

  // Polls only while a build is live, and stops the moment it is not, so a page
  // left open does not keep asking about a build that finished hours ago.
  useEffect(() => {
    const buildId = progress?.buildId;
    const requestTenantId = selected?.tenantId ?? null;
    if (!selected || !buildId) return;
    if (progress?.status === "completed" || progress?.status === "failed") return;
    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      const requestEpoch = buildProgressEpochRef.current;
      try {
        const response = await fetch(contextBuildProgressUrl(selected, buildId), {
          credentials: "include",
          cache: "no-store",
        });
        if (
          !response.ok ||
          cancelled ||
          requestEpoch !== buildProgressEpochRef.current ||
          !isCurrentTenant(requestTenantId)
        ) {
          return;
        }
        const next = (await response.json()) as BuildProgress;
        if (
          cancelled ||
          requestEpoch !== buildProgressEpochRef.current ||
          !isCurrentTenant(requestTenantId)
        ) {
          return;
        }
        applyBuildProgress(next);
        if (next.status !== "active") setCancelError(null);
        // The catalog only changes once the build commits, so it is reloaded
        // then rather than on every poll.
        if (next.status === "completed" && repositoryFilter === next.repository) {
          void loadReleases(repositoryFilter);
          if (refFilter && (!next.ref || next.ref === refFilter)) {
            void loadDocuments(repositoryFilter, refFilter);
          }
        }
      } catch {
        // A failed poll is not worth surfacing: the next one is seconds away.
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    selected,
    progress?.buildId,
    progress?.status,
    isCurrentTenant,
    repositoryFilter,
    refFilter,
    loadReleases,
    loadDocuments,
    applyBuildProgress,
  ]);

  if (!selected) {
    return (
      <div className="page-placeholder context-page__empty" role="status">
        <h1 className="sr-only">Context Wiki</h1>
        <span className="page-placeholder__icon" aria-hidden="true"><BookIcon /></span>
        <strong>No workspace selected</strong>
        <p>Select a workspace from the sidebar to explore its repository context.</p>
      </div>
    );
  }

  const activeRepository = repositories.find(
    (repository) => repository.name === repositoryFilter,
  );
  const activeRelease = releases.find((release) => release.ref === refFilter);

  return (
    <div className="context-page">
      <header className="context-repository-bar">
        <div className="context-repository-bar__identity">
          <div>
            <h1>Context Wiki</h1>
            <p>Browse grounded repository documentation and verified source citations.</p>
          </div>
          {activeRepository ? (
            <span className="route-intro__scope">
              {repositoryFilter} · {activeRelease?.ref ?? documents[0]?.ref ?? activeRepository.defaultBranch}
            </span>
          ) : null}
        </div>
        <div className="context-repository-bar__actions">
          <label>
            <select
              aria-label="Repository"
              value={repositoryFilter}
              onChange={(event) => {
                setRepositoryFilter(event.target.value);
                setFilter("");
              }}
              disabled={repositoriesLoading || !repositories.length}
            >
              <option value="">
                {repositoriesLoading
                  ? "Loading repositories…"
                  : repositories.length
                    ? "Choose a repository"
                    : "No repositories connected"}
              </option>
              {repositories.map(
                (repository) => (
                  <option value={repository.name} key={repository.name}>
                    {repository.name}
                  </option>
                ),
              )}
            </select>
          </label>
          <label>
            <select
              aria-label="Context version"
              value={refFilter}
              onChange={(event) => {
                setRefFilter(event.target.value);
                setFilter("");
              }}
              disabled={!repositoryFilter || releasesLoading || !releases.length}
            >
              <option value="">
                {releasesLoading
                  ? "Loading versions…"
                  : releases.length
                    ? "Choose a version"
                    : "No context published"}
              </option>
              {releases.map((release) => (
                <option value={release.ref} key={release.id}>
                  {release.ref} · {release.commitSha.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <details className="context-build-menu">
            <summary>Build context</summary>
            <div className="context-build-menu__popover">
              <strong>Build repository context</strong>
              <p>Read the default branch and publish refreshed documentation.</p>
              <form onSubmit={build} className="context-build__form">
                <label>
                  Repository
                  <select
                    value={buildRepository}
                    onChange={(event) => setBuildRepository(event.target.value)}
                    disabled={repositoriesLoading || !repositories.length || building}
                  >
                    <option value="">
                      {repositoriesLoading
                        ? "Loading repositories…"
                        : repositories.length
                        ? "Select a repository"
                        : "No repositories connected"}
                    </option>
                    {repositories.map((repository) => (
                      <option key={repository.name} value={repository.name}>
                        {repository.name} · {repository.defaultBranch}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="submit"
                  disabled={
                    !buildRepository || building || !writable || !isCurrentTenant
                  }
                >
                  {building ? "Starting…" : "Build context"}
                </button>
              </form>
              {!writable ? (
                <p className="context-note">
                  Organization admin access is required.{" "}
                  <ExternalLink href={githubInstallationUrl(viewer?.github_app?.install_url, selected)}>
                    Manage installation
                  </ExternalLink>
                </p>
              ) : null}
              {repositoryError ? <p className="context-note">{repositoryError}</p> : null}
              {buildNotice ? <p className="context-note">{buildNotice}</p> : null}
            </div>
          </details>
        </div>
      </header>

      {progress ? (
        <section className="context-progress" aria-live="polite">
          <div className="context-progress__header">
            <span className="context-progress__pulse" aria-hidden="true" />
            <div>
              <span className="context-progress-repository">
                {progress.repository ?? "Repository"}
                {progress.ref ? ` · ${progress.ref}` : ""}
              </span>
              <p className="context-progress-status">
                {progress.failureCode === "build_superseded"
                  ? `Build canceled because a newer pull request commit superseded it. ${checkpointCounts?.verified ?? 0} verified checkpoint ${checkpointCounts?.verified === 1 ? "page was" : "pages were"} retained.`
                  : progress.failureCode === "build_canceled"
                  ? `Build canceled with ${checkpointCounts?.verified ?? 0} verified checkpoint ${checkpointCounts?.verified === 1 ? "page" : "pages"} retained.`
                  : progress.status === "completed"
                  ? `Build finished with ${checkpointCounts?.verified ?? 0} verified ${checkpointCounts?.verified === 1 ? "page" : "pages"}.`
                  : progress.status === "failed"
                    ? `Build failed with ${checkpointCounts?.verified ?? 0} verified checkpoint ${checkpointCounts?.verified === 1 ? "page" : "pages"} retained.`
                    : `Building — ${checkpointCounts?.verified ?? 0} verified, ${checkpointCounts?.pending ?? 0} pending, ${checkpointCounts?.invalid ?? 0} invalid checkpoint pages.`}
              </p>
            </div>
            {activeBuilds.length > 1 || (progress.status === "active" && writable) ? (
              <div className="context-progress-actions">
                {activeBuilds.length > 1 ? (
                  <label className="context-progress-build-selector">
                    Active build
                    <select
                      value={progress.buildId}
                      disabled={cancelingBuildId !== null}
                      onChange={(event) => {
                        const active = activeBuilds.find(
                          (build) => build.id === event.target.value,
                        );
                        if (!active) return;
                        buildProgressEpochRef.current += 1;
                        setCancelError(null);
                        setProgress({
                          ...active,
                          buildId: active.id,
                          stages: active.stages ?? [],
                          pages: [],
                        });
                      }}
                    >
                      {activeBuilds.map((build) => (
                        <option key={build.id} value={build.id}>
                          {contextBuildLabel(build)}
                          {build.status === "completed"
                            ? " · Complete"
                            : build.status === "failed"
                              ? " · Failed"
                              : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {progress.status === "active" && writable ? (
                  <button
                    className="context-progress-cancel"
                    type="button"
                    disabled={cancelingBuildId !== null}
                    onClick={() => void cancelBuild()}
                  >
                    {cancelingBuildId === progress.buildId ? "Canceling…" : "Cancel build"}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          {cancelError ? (
            <p className="context-progress-failure" role="alert">
              {cancelError}
            </p>
          ) : null}
          {progress.stages.length ? (
            <>
              <div className="context-progress-summary" aria-label="Build task summary">
                <span>
                  <strong>{taskCounts?.complete ?? 0}</strong> currently scheduled tasks complete
                </span>
                <span><strong>{taskCounts?.running ?? 0}</strong> running</span>
                <span><strong>{taskCounts?.waiting ?? 0}</strong> waiting</span>
                {taskCounts?.retried ? (
                  <span><strong>{taskCounts.retried}</strong> retried</span>
                ) : null}
                {taskCounts?.failed ? (
                  <span><strong>{taskCounts.failed}</strong> failed</span>
                ) : null}
                {typeof progress.consumedModelTokens === "number" &&
                typeof progress.derivationTokenBudget === "number" ? (
                  <span>
                    <strong>{progress.consumedModelTokens.toLocaleString()}</strong>
                    {" / "}
                    {progress.derivationTokenBudget.toLocaleString()} model tokens
                  </span>
                ) : null}
                {contextDeadlineText(progress.derivationDeadlineAt) ? (
                  <span>{contextDeadlineText(progress.derivationDeadlineAt)}</span>
                ) : null}
              </div>
              <ol className="context-progress-tasks">
                {progress.stages.map((stage) => (
                  <li key={stage.id} data-status={stage.status}>
                    <span className="context-progress-task-state">
                      {contextStageStatus(stage)}
                    </span>
                    <span className="context-progress-task-body">
                      <strong>{stage.title}</strong>
                      <span>
                        {stage.type.replace(/-/g, " ")}
                        {" · "}
                        Attempt {stage.attempt}
                        {contextStageTiming(stage)
                          ? ` · ${contextStageTiming(stage)}`
                          : ""}
                      </span>
                      {stage.failureReason ? (
                        <span className="context-progress-task-error">
                          {stage.failureReason}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
          {progress.failureReason ? (
            <p className="context-progress-failure">
              <strong>Reason:</strong> {progress.failureReason}
            </p>
          ) : null}
          <ol className="context-progress-pages">
            {[...progress.pages]
              .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
              .map((page) => (
                <li key={page.documentPath}>
                  <span className="context-progress-path">{page.documentPath}</span>
                  <span className="context-progress-title">{page.title}</span>
                  <span className="context-progress-checkpoint-status">
                    {page.validationStatus}
                  </span>
                  {page.diagnostics?.[0] ? (
                    <span className="context-progress-task-error">
                      {page.diagnostics[0]}
                    </span>
                  ) : null}
                </li>
              ))}
          </ol>
        </section>
      ) : null}

      {repositoriesLoading ? (
        <div className="page-placeholder context-page__empty" role="status">
          <span className="page-placeholder__icon" aria-hidden="true"><BookIcon /></span>
          <strong>Loading repositories</strong>
          <p>Checking this workspace for published context.</p>
        </div>
      ) : repositories.length === 0 ? (
        <div className="page-placeholder context-page__empty" role="status">
          <span className="page-placeholder__icon" aria-hidden="true"><BookIcon /></span>
          <strong>No repositories connected</strong>
          <p>Connect a GitHub organization or repository before building your Context Wiki.</p>
          <ExternalLink className="btn btn--primary btn--sm" href="/integrations">Open integrations</ExternalLink>
        </div>
      ) : !repositoryFilter ? (
        <div className="page-placeholder context-page__empty" role="status">
          <span className="page-placeholder__icon" aria-hidden="true"><BookIcon /></span>
          <strong>Choose a repository</strong>
          <p>Select a repository above to browse its Context Wiki.</p>
        </div>
      ) : !loading && !error && documents.length === 0 && !progress ? (
        <div className="page-placeholder context-page__empty" role="status">
          <span className="page-placeholder__icon" aria-hidden="true"><BookIcon /></span>
          <strong>No context has been published</strong>
          <p>Build context for {repositoryFilter} to generate grounded Markdown pages and citations.</p>
          <span className="page-placeholder__hint">Use “Build context” above to start the first build.</span>
        </div>
      ) : (
      <section className="context-browser">
        <aside className="context-browser__tree">
          <div className="context-tree__header">
            <span>Files</span>
            <span>{matching.length}</span>
          </div>
          <label className="context-filter">
            <SearchIcon />
            <input
              type="search"
              value={filter}
              placeholder="Search documentation…"
              aria-label="Search documentation"
              onChange={(event) => setFilter(event.target.value)}
            />
            <kbd>/</kbd>
          </label>
          {loading ? <p className="context-note">Loading…</p> : null}
          {error ? <p className="context-error">{error}</p> : null}
          {!loading && !error && !documents.length ? (
            <p className="context-note">
              No context yet. Build a repository and its Markdown files will
              appear here.
            </p>
          ) : null}
          {!loading && documents.length > 0 && !matching.length ? (
            <p className="context-note">Nothing matches “{filter}”.</p>
          ) : null}
          <ul className="context-tree" role="tree">
            {tree.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                expanded={expanded}
                selectedId={selectedId}
                onToggle={toggle}
                onSelect={(document, treeNode) => {
                  setSelectedId(document.id);
                  reveal(treeNode);
                }}
              />
            ))}
          </ul>
          {detail ? (
            <div className="context-tree__footer">
              <span>Last indexed</span>
              <span>{formatRelativeDate(detail.createdAt)}</span>
              <code>{detail.scope?.commitSha?.slice(0, 7) ?? detail.commitSha?.slice(0, 7)}</code>
            </div>
          ) : null}
        </aside>

        <div className="context-browser__detail">
          {detailLoading ? <DocumentSkeleton /> : null}
          {!detailLoading && !detail ? (
            <div className="context-document-empty">
              <BookIcon />
              <strong>Select a Markdown file</strong>
              <span>Choose a document from the repository tree to read it.</span>
            </div>
          ) : null}
          {detail && !detailLoading ? <DocumentPanel document={detail} /> : null}
        </div>

      </section>
      )}
    </div>
  );
}

function TreeNode({
  node,
  depth,
  expanded,
  selectedId,
  onToggle,
  onSelect,
}: {
  node: ContextTreeNode;
  depth: number;
  expanded: Set<string>;
  selectedId: string;
  onToggle: (path: string) => void;
  onSelect: (document: ContextDocumentSummary, node: ContextTreeNode) => void;
}) {
  const isOpen = expanded.has(node.path);
  const label = node.kind === "category" ? categoryLabel(node.name) : node.name;

  if (node.kind === "document" && node.document) {
    const document = node.document;
    const isSelected = document.id === selectedId;
    return (
      <li role="treeitem" aria-selected={isSelected}>
        <button
          type="button"
          className={`context-tree__document${isSelected ? " is-selected" : ""}`}
          style={{ paddingLeft: `${depth * 14 + 12}px` }}
          onClick={() => onSelect(document, node)}
          title={document.logicalId}
        >
          <FileIcon />
          <span className="context-tree__name">{markdownFileName(label)}</span>
          {document.reviewStatus !== "generated" ? (
            <span className="context-tree__status">
              {document.reviewStatus}
            </span>
          ) : null}
        </button>
      </li>
    );
  }

  return (
    <li role="treeitem" aria-expanded={isOpen}>
      <button
        type="button"
        className="context-tree__folder"
        style={{ paddingLeft: `${depth * 14 + 12}px` }}
        onClick={() => onToggle(node.path)}
      >
        <span aria-hidden="true" className="context-tree__chevron">
          {isOpen ? "▾" : "▸"}
        </span>
        <FolderIcon />
        <span className="context-tree__name">{label}</span>
        <span className="context-tree__count">{node.documentCount}</span>
      </button>
      {isOpen ? (
        <ul role="group">
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              selectedId={selectedId}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function DocumentPanel({ document }: { document: DocumentDetail }) {
  const path = documentSubject(document.logicalId);
  const segments = path.split("/").filter(Boolean);

  return (
    <article className="context-document">
      <nav className="context-document__breadcrumb" aria-label="Document path">
        {segments.map((segment, index) => (
          <span key={`${segment}-${index}`}>
            {index ? <b>/</b> : null}
            {index === segments.length - 1 ? markdownFileName(segment) : segment}
          </span>
        ))}
      </nav>
      <header id="document-overview">
        <span className="context-document__kind">{categoryLabel(document.kind)}</span>
        <h1>{document.title}</h1>
        {document.summary ? (
          <p className="context-document__summary">{document.summary}</p>
        ) : null}
      </header>
      <MarkdownDocument markdown={document.bodyMarkdown} />
      {document.citations.length ? (
        <footer className="context-document__citations">
          <h2 id="sources">Sources</h2>
          <ul>
            {document.citations.map((citation, index) => (
              <li key={index}>
                <code>{formatCitation(citation)}</code>
              </li>
            ))}
          </ul>
        </footer>
      ) : null}
    </article>
  );
}

function MarkdownDocument({ markdown }: { markdown: string }) {
  return (
    <div className="context-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h2 id={headingId(children)}>{children}</h2>,
          h2: ({ children }) => <h2 id={headingId(children)}>{children}</h2>,
          h3: ({ children }) => <h3 id={headingId(children)}>{children}</h3>,
          h4: ({ children }) => <h4 id={headingId(children)}>{children}</h4>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          pre: ({ children }) => {
            const child = children as ReactElement<{ className?: string }>;
            return isValidElement(child) &&
              child.props.className?.includes("language-mermaid") ? (
              <>{children}</>
            ) : (
              <pre>{children}</pre>
            );
          },
          code: ({ className, children }) =>
            className?.includes("language-mermaid") ? (
              <MermaidDiagram code={String(children).replace(/\n$/, "")} />
            ) : (
              <code className={className}>{children}</code>
            ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

function MermaidDiagram({ code }: { code: string }) {
  const id = useId().replace(/:/g, "");
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme:
            window.matchMedia("(prefers-color-scheme: dark)").matches
              ? "dark"
              : "neutral",
          fontFamily: "var(--font-sans)",
          flowchart: { useMaxWidth: false },
        });
        const rendered = await mermaid.render(`context-mermaid-${id}`, code);
        if (!cancelled && hostRef.current) {
          hostRef.current.innerHTML = rendered.svg;
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code, id]);

  return (
    <figure className="context-mermaid">
      <figcaption>
        <span>Diagram</span>
        <span>Mermaid</span>
      </figcaption>
      {error ? (
        <pre className="context-mermaid__fallback">
          <code>{code}</code>
        </pre>
      ) : (
        <div ref={hostRef} className="context-mermaid__canvas" />
      )}
    </figure>
  );
}

function DocumentSkeleton() {
  return (
    <div className="context-document-skeleton" aria-label="Loading document">
      <span />
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

function findDocumentNode(
  nodes: readonly ContextTreeNode[],
  documentId: string,
): ContextTreeNode | undefined {
  for (const node of nodes) {
    if (node.document?.id === documentId) return node;
    const child = findDocumentNode(node.children, documentId);
    if (child) return child;
  }
  return undefined;
}

function headingId(children: ReactNode): string {
  return slugify(String(children));
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-") || "section"
  );
}

function markdownFileName(value: string): string {
  return /\.mdx?$/i.test(value) ? value : `${value}.md`;
}

function formatRelativeDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "recently";
  const elapsed = Date.now() - timestamp;
  const minutes = Math.max(1, Math.floor(elapsed / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function BookIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 3.25A1.75 1.75 0 0 1 4.25 1.5H8v11H4.25A1.75 1.75 0 0 0 2.5 14.25v-11Z" stroke="currentColor" strokeWidth="1.2" />
      <path d="M13.5 3.25a1.75 1.75 0 0 0-1.75-1.75H8v11h3.75a1.75 1.75 0 0 1 1.75 1.75v-11Z" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg className="context-tree__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.75 4.25h4l1.1-1.5h2.9a1.5 1.5 0 0 1 1.5 1.5v.5h2a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1v-8Z" stroke="currentColor" strokeWidth="1.15" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="context-tree__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.25 1.75h5l4.5 4.5v8H3.25v-12.5Z" stroke="currentColor" strokeWidth="1.15" />
      <path d="M8.25 1.75v4.5h4.5M5.25 9h5.5M5.25 11.5h4" stroke="currentColor" strokeWidth="1.15" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
