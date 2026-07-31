import Link from "next/link";
import { contextFailureText } from "../lib/context-failures";
import {
  getContextMetrics,
  JinaApiError,
  listAllReleases,
  listContextBuildProgress,
  listContextBuilds,
  listContextDocuments,
  type AdminContextBuild,
  type AdminContextRelease
} from "../lib/jina-api";

export const dynamic = "force-dynamic";

export default async function ContextAdminPage({
  searchParams
}: {
  readonly searchParams: Promise<{ readonly repository?: string }>;
}) {
  const { repository } = await searchParams;
  let releases: readonly AdminContextRelease[];
  let builds: readonly AdminContextBuild[];
  let buildProgress: Awaited<ReturnType<typeof listContextBuildProgress>>;
  let documents: Awaited<ReturnType<typeof listContextDocuments>>;
  let metrics: Awaited<ReturnType<typeof getContextMetrics>>;
  try {
    [releases, metrics, builds] = await Promise.all([listAllReleases(), getContextMetrics(), listContextBuilds()]);
    const scopedBuilds = repository ? builds.filter((build) => build.repository === repository) : builds;
    [documents, buildProgress] = await Promise.all([
      listContextDocuments(releases, repository),
      listContextBuildProgress(scopedBuilds)
    ]);
  } catch (error) {
    return (
      <div className="error-state">
        <p>Could not load repository context from the Jina API.</p>
        <p>
          <code>{error instanceof JinaApiError ? error.message : "unexpected error"}</code>
        </p>
        <p className="muted">
          Check <code>JINA_API_URL</code> and <code>INTERNAL_API_TOKEN</code>, or start the local stack.
        </p>
      </div>
    );
  }

  const repositories = [...new Set(releases.map((release) => release.repository))].sort();
  const visible = repository ? releases.filter((release) => release.repository === repository) : releases;
  const visibleBuilds = repository ? builds.filter((build) => build.repository === repository) : builds;
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

  return (
    <main>
      <div className="stat-row">
        <Stat label="Context releases" value={metrics.publishedGenerationCount} />
        <Stat label="Repositories" value={repository ? 1 : repositories.length} />
        <Stat label="Derived context docs" value={currentDocuments} />
        <Stat label="Projection backlog" value={pending} />
        <Stat label="Active builds" value={activeBuilds} />
        <Stat label="Active model tasks" value={activeModelTasks} />
        <Stat label="Verified checkpoints" value={verifiedCheckpoints} />
        <Stat label="Hierarchy nodes" value={metrics.hierarchyNodeCount} />
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

      {visible.length === 0 ? (
        <div className="empty-state">
          <p>No context releases have been published{repository ? ` for ${repository}` : ""}.</p>
          <p>
            Verified pages remain private, resumable checkpoints until the complete catalog passes citation,
            maintenance-task, and certification gates and publishes atomically.
          </p>
        </div>
      ) : (
        <table className="context-table">
          <thead>
            <tr>
              <th>Repository</th>
              <th>Ref</th>
              <th>Commit</th>
              <th>Published</th>
              <th>Publication</th>
              <th>Context</th>
              <th>Release ID</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((release) => (
              <tr key={release.id}>
                <td>
                  <Link href={`/?repository=${encodeURIComponent(release.repository)}`}>{release.repository}</Link>
                </td>
                <td>
                  <code>{shortRef(release.ref)}</code>
                </td>
                <td>
                  <code>{release.commitSha.slice(0, 10)}</code>
                </td>
                <td title={release.publishedAt ?? release.createdAt}>
                  {formatTimestamp(release.publishedAt ?? release.createdAt)}
                </td>
                <td>{release.completeness}</td>
                <td>{release.contextStatus}</td>
                <td className="summary-cell">
                  <code>{release.id}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <section className="context-admin-section">
        <h2>Build and checkpoint state</h2>
        <p className="muted">
          {visibleBuilds.length} recent builds. Checkpoint counts are shown for the {buildProgress.length} most recent
          builds; valid checkpoint pages remain private until atomic publication.
        </p>
        {visibleBuilds.length > 0 ? (
          <table className="context-table">
            <thead>
              <tr>
                <th>Repository</th>
                <th>Ref / sequence</th>
                <th>Commit</th>
                <th>Status</th>
                <th>Build limits</th>
                <th>Stages</th>
                <th>Checkpoints</th>
                <th>Build ID</th>
              </tr>
            </thead>
            <tbody>
              {visibleBuilds.slice(0, 50).map((build) => {
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
                    <td>
                      {build.status}
                      {buildFailure ? <span className="failure-detail">{buildFailure}</span> : null}
                    </td>
                    <td>
                      {build.derivationTokenBudget !== undefined ? (
                        <>
                          {compactNumber(progress?.consumedModelTokens ?? build.consumedModelTokens ?? 0)} /{" "}
                          {compactNumber(build.derivationTokenBudget)} tokens
                        </>
                      ) : (
                        "not recorded"
                      )}
                      {build.derivationDeadlineAt ? (
                        <>
                          <br />
                          <span className="muted">deadline {formatTimestamp(build.derivationDeadlineAt)}</span>
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
                              {stage.attempt} · updated {formatTimestamp(stage.updatedAt)}
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
                    <td>{progress ? `${valid} valid${invalid > 0 ? ` · ${invalid} invalid` : ""}` : "not sampled"}</td>
                    <td className="summary-cell">
                      <code>{build.id}</code>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">No Context builds are visible for this repository scope.</div>
        )}
      </section>

      <section className="context-admin-section">
        <h2>Context index health</h2>
        <p className="muted">
          {metrics.fragmentCount} lexical fragments and {metrics.hierarchyNodeCount} hierarchy nodes. Dense embeddings
          remain disabled ({metrics.embeddingCount} stored).
        </p>
        {(metrics.projectors?.length ?? 0) > 0 ? (
          <table className="context-table">
            <thead>
              <tr>
                <th>Projection</th>
                <th>Status</th>
                <th>Backlog</th>
                <th>Version</th>
                <th>Release checkpoint</th>
              </tr>
            </thead>
            <tbody>
              {metrics.projectors!.map((projector) => (
                <tr key={projector.name}>
                  <td>{projector.name}</td>
                  <td>{projector.status}</td>
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
          </table>
        ) : (
          <div className="empty-state">No published Context index checkpoint is available.</div>
        )}
      </section>

      <section className="context-admin-section">
        <h2>Agent-derived context</h2>
        <p className="muted">
          {documents.length} current documents across{" "}
          {[...contextKinds.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([kind, count]) => `${kind}: ${count}`)
            .join(", ") || "no document kinds"}
          .
        </p>
        {documents.length > 0 ? (
          <table className="context-table">
            <thead>
              <tr>
                <th>Repository</th>
                <th>Kind</th>
                <th>Document</th>
                <th>Commit</th>
                <th>Citations</th>
                <th>Release</th>
              </tr>
            </thead>
            <tbody>
              {documents.slice(0, 100).map((document) => (
                <tr key={document.id}>
                  <td>{document.repository}</td>
                  <td>{document.kind ?? "context"}</td>
                  <td className="summary-cell" title={document.logicalId}>
                    <strong>{document.title}</strong>
                    <br />
                    <span className="muted">{document.summary}</span>
                  </td>
                  <td>
                    <code>{document.commitSha.slice(0, 10)}</code>
                  </td>
                  <td>{document.citations.length}</td>
                  <td>
                    <code>{document.releaseId}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </main>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: number }) {
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

function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
