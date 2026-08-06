import Link from "next/link";
import type { ReactNode } from "react";
import { contextFailureText } from "../lib/context-failures";
import { statusTone } from "../lib/status-tone";
import {
  CONTEXT_BUILD_PROGRESS_LIMIT,
  getContextMetrics,
  listAllReleases,
  listContextBuildProgress,
  listContextBuilds,
  listContextDocuments,
  type AdminContextBuild,
  type AdminContextBuildProgress,
  type AdminContextDocument,
  type AdminContextMetrics,
  type AdminContextRelease
} from "../lib/jina-api";

export const dynamic = "force-dynamic";

// Banner entries name the heading a reader can actually see on this page, not
// the internal loader. Keep these strings identical to the rendered headings.
const HEADINGS = {
  releases: "Published releases",
  builds: "Build and checkpoint state",
  checkpoints: "Build and checkpoint state — checkpoint counts",
  health: "Context index health",
  documents: "Agent-derived context"
} as const;

// Row caps. Every capped table states its cap in the visible count so an
// operator never reads a truncated list as the whole population.
const RELEASE_ROW_LIMIT = 100;
const BUILD_ROW_LIMIT = 50;
const DOCUMENT_ROW_LIMIT = 100;

export default async function ContextAdminPage({
  searchParams
}: {
  readonly searchParams: Promise<{ readonly repository?: string }>;
}) {
  const { repository } = await searchParams;
  // The production API intentionally runs as one replica. Keep this operator
  // page from turning one navigation into a burst of expensive Board and
  // catalog reads that competes with workers, MCP, and webhook admission.
  const releasesSection = await loadSection<readonly AdminContextRelease[]>(listAllReleases, [], HEADINGS.releases);
  const metricsSection = await loadSection(getContextMetrics, EMPTY_METRICS, HEADINGS.health);
  const buildsSection = await loadSection<readonly AdminContextBuild[]>(listContextBuilds, [], HEADINGS.builds);

  const releases = releasesSection.value;
  const metrics = metricsSection.value;
  const builds = buildsSection.value;
  const scopedBuilds = repository ? builds.filter((build) => build.repository === repository) : builds;

  // A dependency failure is not an empty result: the derived-context read is
  // never attempted when the release list it needs did not load.
  const documentsSection = !isLoaded(releasesSection)
    ? blockedSection<readonly AdminContextDocument[]>([], HEADINGS.documents, HEADINGS.releases)
    : releases.length > 0
      ? await loadSection<readonly AdminContextDocument[]>(
          () => listContextDocuments(releases, repository),
          [],
          HEADINGS.documents
        )
      : loadedSection<readonly AdminContextDocument[]>([], HEADINGS.documents);
  const buildProgressSection = !isLoaded(buildsSection)
    ? blockedSection<readonly AdminContextBuildProgress[]>([], HEADINGS.checkpoints, HEADINGS.builds)
    : scopedBuilds.length > 0
      ? await loadSection<readonly AdminContextBuildProgress[]>(
          () => listContextBuildProgress(scopedBuilds),
          [],
          HEADINGS.checkpoints
        )
      : loadedSection<readonly AdminContextBuildProgress[]>([], HEADINGS.checkpoints);

  const documents = documentsSection.value;
  const buildProgress = buildProgressSection.value;
  const degraded = [releasesSection, metricsSection, buildsSection, buildProgressSection, documentsSection].filter(
    (section) => !isLoaded(section)
  );

  const repositories = [
    ...new Set([...releases.map((release) => release.repository), ...builds.map((build) => build.repository)])
  ].sort();
  const visible = repository ? releases.filter((release) => release.repository === repository) : releases;
  const shownReleases = visible.slice(0, RELEASE_ROW_LIMIT);
  const visibleBuilds = repository ? builds.filter((build) => build.repository === repository) : builds;
  const shownBuilds = visibleBuilds.slice(0, BUILD_ROW_LIMIT);
  const shownDocuments = documents.slice(0, DOCUMENT_ROW_LIMIT);
  const progressByBuild = new Map(buildProgress.map((progress) => [progress.buildId, progress]));
  const pending = Object.values(metrics.outboxDepthByConsumer).reduce((sum, count) => sum + count, 0);
  const activeBuilds = metrics.quotas?.active.builds ?? 0;
  const activeModelTasks = metrics.quotas?.active.modelTasks ?? 0;
  const currentDocuments = new Map(
    documents.map((document) => [`${document.repository}\0${document.logicalId}`, document])
  ).size;
  const verifiedCheckpoints = buildProgress.reduce(
    (count, progress) => count + progress.pages.filter((page) => page.validationStatus === "valid").length,
    0
  );
  const contextKinds = new Map<string, number>();
  for (const document of documents) {
    const kind = document.kind ?? "context";
    contextKinds.set(kind, (contextKinds.get(kind) ?? 0) + 1);
  }

  const metricsKnown = isLoaded(metricsSection);
  // The repository roll-up reads from both lists, so it is only a measurement
  // when both of them loaded.
  const repositoriesKnown = isLoaded(releasesSection) && isLoaded(buildsSection);

  return (
    <main id="overview" className="admin-main">
      <header className="admin-page-heading">
        <div>
          <span className="admin-eyebrow">Repository context</span>
          <h1>Context operations</h1>
          <p>Monitor immutable releases, resumable builds, index health, and agent-derived context.</p>
        </div>
        <span className="admin-scope-badge">All context</span>
      </header>
      {degraded.length > 0 ? (
        <div className="error-state" role="alert">
          <p className="error-state__title">
            {degraded.length === 1 ? "1 section is not reporting" : `${degraded.length} sections are not reporting`}
          </p>
          <ul>
            {degraded.map((section) => (
              <li key={section.heading}>{sectionMessage(section)}</li>
            ))}
          </ul>
          <p>
            Counts shown as “—” were never measured and are not zero. The admin server log records the API status behind
            each failure.
          </p>
        </div>
      ) : null}
      <div className="stat-row">
        <Stat label="Context releases" value={metricsKnown ? metrics.publishedGenerationCount : undefined} />
        <Stat label="Repositories" value={repository ? 1 : repositoriesKnown ? repositories.length : undefined} />
        <Stat label="Derived context docs" value={isLoaded(documentsSection) ? currentDocuments : undefined} />
        <Stat label="Projection backlog" value={metricsKnown ? pending : undefined} />
        <Stat label="Active builds" value={metricsKnown ? activeBuilds : undefined} />
        <Stat label="Active model tasks" value={metricsKnown ? activeModelTasks : undefined} />
        <Stat label="Verified checkpoints" value={isLoaded(buildProgressSection) ? verifiedCheckpoints : undefined} />
        <Stat label="Hierarchy nodes" value={metricsKnown ? metrics.hierarchyNodeCount : undefined} />
      </div>

      <section id="releases" className="context-admin-section admin-data-section">
        <div className="admin-section-heading">
          <div>
            <h2>{HEADINGS.releases}</h2>
            <p className="muted">
              Immutable repository context available to agents and operators.
              {isLoaded(releasesSection)
                ? ` ${rowCountLabel(shownReleases.length, visible.length, "releases")}, authoritative current release for each ref first.`
                : ""}
            </p>
          </div>
          {repositories.length > 1 || repository ? (
            <nav className="repo-filter" aria-label="Filter by repository">
              <Link href="/" className={repository ? "" : "active"}>
                All repositories
              </Link>
              {repositories.map((candidate) => (
                <Link
                  key={candidate}
                  href={`/?repository=${encodeURIComponent(candidate)}`}
                  className={candidate === repository ? "active" : ""}
                >
                  {candidate}
                </Link>
              ))}
            </nav>
          ) : null}
        </div>

        {!isLoaded(releasesSection) ? (
          <SectionError section={releasesSection} />
        ) : visible.length === 0 ? (
          <div className="empty-state">
            <p>No context releases have been published{repository ? ` for ${repository}` : ""}.</p>
            <p>
              Verified pages remain private, resumable checkpoints until the complete catalog passes citation,
              maintenance-task, and certification gates and publishes atomically.
            </p>
          </div>
        ) : (
          <TableScroll
            id="releases-table"
            caption={`${HEADINGS.releases}: ${rowCountLabel(shownReleases.length, visible.length, "releases")}, authoritative current release for each ref first.`}
          >
            <thead>
              <tr>
                <th scope="col">Repository</th>
                <th scope="col">Ref</th>
                <th scope="col">Commit</th>
                <th scope="col">Published</th>
                <th scope="col">Publication</th>
                <th scope="col">Context</th>
                <th scope="col">Release ID</th>
              </tr>
            </thead>
            <tbody>
              {shownReleases.map((release) => (
                <tr key={release.id}>
                  <td>
                    <Link href={`/?repository=${encodeURIComponent(release.repository)}`}>{release.repository}</Link>
                  </td>
                  <td>
                    <code>{shortRef(release.ref)}</code>
                  </td>
                  <td>
                    <code>{release.commitSha ? release.commitSha.slice(0, 10) : "unresolved"}</code>
                  </td>
                  <td title={release.publishedAt ?? release.createdAt}>
                    {formatTimestamp(release.publishedAt ?? release.createdAt)}
                  </td>
                  <td data-tone={statusTone(release.completeness)}>{release.completeness}</td>
                  <td data-tone={statusTone(release.contextStatus)}>{release.contextStatus}</td>
                  <td className="summary-cell">
                    <code>{release.id}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </section>

      <section id="builds" className="context-admin-section admin-data-section">
        <h2>{HEADINGS.builds}</h2>
        <p className="muted">
          {isLoaded(buildsSection)
            ? `${rowCountLabel(shownBuilds.length, visibleBuilds.length, "builds")}, most recently updated first. `
            : "Build rows did not load. "}
          {isLoaded(buildProgressSection)
            ? `Checkpoint counts are sampled for up to ${CONTEXT_BUILD_PROGRESS_LIMIT} active builds (${buildProgress.length} sampled);`
            : "Checkpoint counts did not load;"}{" "}
          valid checkpoint pages remain private until atomic publication.
        </p>
        {!isLoaded(buildsSection) ? (
          <SectionError section={buildsSection} />
        ) : visibleBuilds.length === 0 ? (
          <div className="empty-state">No Context builds are visible for this repository scope.</div>
        ) : (
          <>
            {!isLoaded(buildProgressSection) ? <SectionError section={buildProgressSection} /> : null}
            <TableScroll
              id="builds-table"
              caption={`${HEADINGS.builds}: ${rowCountLabel(shownBuilds.length, visibleBuilds.length, "builds")}, most recently updated first.`}
            >
              <thead>
                <tr>
                  <th scope="col">Repository</th>
                  <th scope="col">Ref / sequence</th>
                  <th scope="col">Commit</th>
                  <th scope="col">Status</th>
                  <th scope="col">Build limits</th>
                  <th scope="col">Stages</th>
                  <th scope="col">Checkpoints</th>
                  <th scope="col">Build ID</th>
                </tr>
              </thead>
              <tbody>
                {shownBuilds.map((build) => {
                  const progress = progressByBuild.get(build.id);
                  const stages = progress?.stages ?? build.stages;
                  const done = stages.filter((stage) => stage.status === "done").length;
                  const retries = stages.filter((stage) => stage.attempt > 1).length;
                  const valid = progress?.pages.filter((page) => page.validationStatus === "valid").length ?? 0;
                  const invalid = progress?.pages.filter((page) => page.validationStatus === "invalid").length ?? 0;
                  const buildFailure = build.status === "failed" ? contextFailureText(progress ?? build) : undefined;
                  const failedStages = stages.flatMap((stage) => {
                    const failure = stage.status === "failed" ? contextFailureText(stage) : undefined;
                    return failure ? [{ id: stage.id, title: stage.title, failure }] : [];
                  });
                  const activeStages = stages.filter(
                    (stage) => stage.status === "in_progress" || stage.status === "queued" || stage.status === "triage"
                  );
                  const queuedFollowup = progress?.queuedFollowup ?? build.queuedFollowup;
                  const queuedFollowupCount = progress?.queuedFollowupCount ?? build.queuedFollowupCount ?? 0;
                  return (
                    <tr key={build.id}>
                      <td>{build.repository}</td>
                      <td>
                        <code>{shortRef(build.ref)}</code>
                        <br />
                        <span className="muted">sequence {build.refSequence}</span>
                      </td>
                      <td>
                        <code>{build.commitSha?.slice(0, 10) ?? "unresolved"}</code>
                      </td>
                      <td data-tone={statusTone(build.status)}>
                        {build.status}
                        {buildFailure ? <span className="failure-detail">{buildFailure}</span> : null}
                        {queuedFollowup ? (
                          <span className="muted">
                            Next: {queuedFollowup.ref}
                            {queuedFollowup.commitSha ? `@${queuedFollowup.commitSha.slice(0, 10)}` : ""} after this
                            build
                            {queuedFollowupCount > 1 ? ` (+${queuedFollowupCount - 1} more)` : ""}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        {build.derivationTokenBudget !== undefined ? (
                          <>
                            {compactNumber(progress?.consumedModelTokens ?? build.consumedModelTokens ?? 0)} /{" "}
                            {compactNumber(build.derivationTokenBudget)} tokens
                            {(progress?.activeModelReservedTokens ?? build.activeModelReservedTokens ?? 0) > 0 ? (
                              <>
                                <br />
                                <span className="muted">
                                  {compactNumber(
                                    progress?.activeModelReservedTokens ?? build.activeModelReservedTokens ?? 0
                                  )}{" "}
                                  actively reserved
                                </span>
                              </>
                            ) : null}
                          </>
                        ) : (
                          "not recorded"
                        )}
                        {(progress?.derivationDeadlineAt ?? build.derivationDeadlineAt) ? (
                          <>
                            <br />
                            <span className="muted">
                              deadline{" "}
                              {formatTimestamp((progress?.derivationDeadlineAt ?? build.derivationDeadlineAt)!)}
                            </span>
                          </>
                        ) : null}
                        {(progress?.consumedExecutionSeconds ?? build.consumedExecutionSeconds) !== undefined ? (
                          <>
                            <br />
                            <span className="muted">
                              {compactDuration(
                                progress?.consumedExecutionSeconds ?? build.consumedExecutionSeconds ?? 0
                              )}{" "}
                              used ·{" "}
                              {compactDuration(
                                progress?.remainingExecutionSeconds ?? build.remainingExecutionSeconds ?? 0
                              )}{" "}
                              execution remaining
                            </span>
                          </>
                        ) : null}
                      </td>
                      <td>
                        {done}/{stages.length} complete
                        {retries > 0 ? (
                          <>
                            <br />
                            <span className="muted">{retries} retried</span>
                          </>
                        ) : null}
                        {activeStages.length > 0 ? (
                          <ul className="active-stage-list">
                            {activeStages.map((stage) => (
                              <li key={stage.id}>
                                <strong>{stage.title}</strong>: {stage.status.replaceAll("_", " ")} · attempt{" "}
                                {stage.attempt}
                                {stage.modelTotalTokens !== undefined
                                  ? ` · ${compactNumber(stage.modelTotalTokens)} tokens`
                                  : ""}
                                {stage.lastRetryFailureReason ? ` · previous: ${stage.lastRetryFailureReason}` : ""} ·
                                updated {formatTimestamp(stage.updatedAt)}
                                {stage.phaseCheckpoints?.at(-1)
                                  ? ` · durable phase ${stage.phaseCheckpoints.at(-1)!.phase.replaceAll("-", " ")} at ${formatTimestamp(stage.phaseCheckpoints.at(-1)!.recordedAt)}`
                                  : ""}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {failedStages.length > 0 ? (
                          <ul className="failure-stage-list">
                            {failedStages.map((stage) => (
                              <li key={stage.id}>
                                <strong>{stage.title}</strong>: {stage.failure}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </td>
                      <td>
                        {progress
                          ? `${valid} valid${invalid > 0 ? ` · ${invalid} invalid` : ""}`
                          : isLoaded(buildProgressSection)
                            ? "not sampled"
                            : "unknown"}
                      </td>
                      <td className="summary-cell">
                        <code>{build.id}</code>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </TableScroll>
          </>
        )}
      </section>

      <section id="health" className="context-admin-section admin-data-section">
        <h2>{HEADINGS.health}</h2>
        <p className="muted">
          {metricsKnown
            ? `${metrics.fragmentCount} lexical fragments and ${metrics.hierarchyNodeCount} hierarchy nodes. Dense embeddings remain disabled (${metrics.embeddingCount} stored).`
            : "Index counts could not be read, so none are shown."}
        </p>
        {!metricsKnown ? (
          <SectionError section={metricsSection} />
        ) : (metrics.projectors?.length ?? 0) > 0 ? (
          <TableScroll
            id="health-table"
            caption={`${HEADINGS.health}: ${rowCountLabel(metrics.projectors!.length, metrics.projectors!.length, "immutable projector checkpoints")}.`}
          >
            <thead>
              <tr>
                <th scope="col">Projection</th>
                <th scope="col">Status</th>
                <th scope="col">Backlog</th>
                <th scope="col">Version</th>
                <th scope="col">Release checkpoint</th>
              </tr>
            </thead>
            <tbody>
              {metrics.projectors!.map((projector) => (
                <tr key={projector.name}>
                  <td>{projector.name}</td>
                  <td data-tone={statusTone(projector.status)}>{projector.status}</td>
                  <td>{projector.backlog}</td>
                  <td>
                    <code>{projector.version}</code>
                  </td>
                  <td className="summary-cell">
                    <code>{projector.checkpoint}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        ) : (
          <div className="empty-state">No published Context index checkpoint is available.</div>
        )}
      </section>

      <section id="documents" className="context-admin-section admin-data-section">
        <h2>{HEADINGS.documents}</h2>
        <p className="muted">
          {isLoaded(documentsSection)
            ? `${rowCountLabel(shownDocuments.length, documents.length, "current documents")} across ${
                [...contextKinds.entries()]
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([kind, count]) => `${kind}: ${count}`)
                  .join(", ") || "no document kinds"
              }, ordered by logical ID.`
            : "Derived context documents did not load, so no counts are shown."}
        </p>
        {!isLoaded(documentsSection) ? (
          <SectionError section={documentsSection} />
        ) : documents.length === 0 ? (
          <div className="empty-state">
            No agent-derived context documents are published{repository ? ` for ${repository}` : ""}.
          </div>
        ) : (
          <TableScroll
            id="documents-table"
            caption={`${HEADINGS.documents}: ${rowCountLabel(shownDocuments.length, documents.length, "current documents")}, ordered by logical ID.`}
          >
            <thead>
              <tr>
                <th scope="col">Repository</th>
                <th scope="col">Kind</th>
                <th scope="col">Document</th>
                <th scope="col">Commit</th>
                <th scope="col">Citations</th>
                <th scope="col">Release</th>
              </tr>
            </thead>
            <tbody>
              {shownDocuments.map((document) => (
                <tr key={document.id}>
                  <td>{document.repository}</td>
                  <td>{document.kind ?? "context"}</td>
                  <td className="summary-cell" title={document.logicalId}>
                    <strong>{document.title}</strong>
                    <br />
                    <span className="muted">{document.summary}</span>
                  </td>
                  <td>
                    <code>{document.commitSha ? document.commitSha.slice(0, 10) : "unresolved"}</code>
                  </td>
                  <td>{document.citations.length}</td>
                  <td>
                    <code>{document.releaseId}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </section>
    </main>
  );
}

const EMPTY_METRICS: AdminContextMetrics = {
  outboxDepthByConsumer: {},
  publishedGenerationCount: 0,
  documentCount: 0,
  fragmentCount: 0,
  hierarchyNodeCount: 0,
  embeddingCount: 0
};

/**
 * A section is either measured, failed, or never attempted because something it
 * depends on failed. The page must be able to say which: reporting a failed read
 * as an empty result is how a monitoring page hides an outage.
 */
interface Section<T> {
  readonly heading: string;
  readonly state: "loaded" | "failed" | "blocked";
  readonly value: T;
  readonly blockedBy?: string;
}

function isLoaded(section: Section<unknown>): boolean {
  return section.state === "loaded";
}

function loadedSection<T>(value: T, heading: string): Section<T> {
  return { heading, state: "loaded", value };
}

function blockedSection<T>(fallback: T, heading: string, blockedBy: string): Section<T> {
  return { heading, state: "blocked", value: fallback, blockedBy };
}

async function loadSection<T>(load: () => Promise<T>, fallback: T, heading: string): Promise<Section<T>> {
  try {
    return { heading, state: "loaded", value: await load() };
  } catch (error) {
    // Server-side only. Without this an operator cannot tell an API outage from
    // a credential/principal misconfiguration, because both render identically.
    console.error(
      "[admin] section %s failed to load: %s",
      heading,
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    );
    return { heading, state: "failed", value: fallback };
  }
}

function sectionMessage(section: Section<unknown>): string {
  return section.state === "blocked"
    ? `${section.heading} — not attempted because ${section.blockedBy} could not be loaded.`
    : `${section.heading} — the Jina API request failed.`;
}

function SectionError({ section }: { readonly section: Section<unknown> }) {
  return (
    <div className="section-error">
      <p className="section-error__title">{section.heading} is unavailable</p>
      <p>
        {section.state === "blocked"
          ? `This section was not attempted because ${section.blockedBy} could not be loaded. Nothing below reflects current state.`
          : "The Jina API request for this section failed, so nothing below reflects current state. This is not an empty result."}
      </p>
      <p>
        Retry after checking API availability and this app’s credentials; the failure is recorded in the server log.
      </p>
    </div>
  );
}

/**
 * Scrolling belongs to a wrapper so the table keeps its own formatting context
 * and its roles. The wrapper is focusable and named so a keyboard-only reader
 * can scroll it.
 */
function TableScroll({
  id,
  caption,
  children
}: {
  readonly id: string;
  readonly caption: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="table-scroll" role="region" aria-labelledby={`${id}-caption`} tabIndex={0}>
      <table className="context-table">
        <caption id={`${id}-caption`} className="sr-only">
          {caption}
        </caption>
        {children}
      </table>
    </div>
  );
}

/** States the cap whenever the rendered rows are not the whole population. */
function rowCountLabel(shown: number, total: number, plural: string): string {
  if (shown !== total) return `Showing ${shown} of ${total} ${plural}`;
  return total === 1 ? `1 ${plural.replace(/s$/, "")} shown` : `${total} ${plural} shown`;
}

function Stat({ label, value }: { readonly label: string; readonly value: number | undefined }) {
  if (value === undefined) {
    return (
      <div className="stat stat--unknown">
        <div className="value" title="Not measured: this data did not load">
          <span aria-hidden="true">—</span>
          <span className="sr-only">Unavailable</span>
        </div>
        <div className="label">{label}</div>
      </div>
    );
  }
  return (
    <div className="stat">
      <div className="value">{value.toLocaleString("en-US")}</div>
      <div className="label">{label}</div>
    </div>
  );
}

function shortRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "") || ref;
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function compactDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
