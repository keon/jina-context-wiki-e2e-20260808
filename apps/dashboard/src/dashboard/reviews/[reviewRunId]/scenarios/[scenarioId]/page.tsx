"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { useDashboard, useTenant, useTenantFence } from "../../../../providers";
import {
  Badge,
  BackLink,
  DetailHeader,
  EmptyState,
  ExternalLink,
} from "../../../../components/ui";
import { getScenarioLineageRuns } from "../../../../lib/api";
import { scenarioPath, scenariosFromRun, type ParsedScenario } from "../../../../lib/historical-scenarios";
import {
  formatDate,
  formatDuration,
  formatJson,
  riskMeetsThreshold,
  riskTone,
  scenarioFailureBlocks,
  scenarioEvaluationPending,
  scenarioExpectedOutcome,
  scenarioFinalVerdict,
  scenarioLineageKey,
  scenarioRationale,
  scenarioResultBadge,
  scenarioRiskLabel,
  scenarioSimulation,
  scenarioSummary,
  scenarioTrail,
  shortSha,
  simulationStatusTone,
} from "../../../../lib/presentation";
import { runResult } from "../../../../lib/run-result";
import { useReviewRunDetail } from "../../../../lib/use-review-run-detail";
import type {
  ReviewEvent,
  ReviewRun,
  ScenarioSimulationScenario,
  ScenarioSimulationStep,
  ScenarioTrailEntry,
} from "../../../../lib/types";

export default function ScenarioPage({
  params,
}: {
  params: Promise<{ reviewRunId: string; scenarioId: string }>;
}) {
  const { reviewRunId, scenarioId } = use(params);
  const decodedReviewRunId = decodeURIComponent(reviewRunId);
  const { data, loading } = useDashboard();
  // The run from the list is seeded into the detail read itself (see useReviewRunDetail).
  const {
    run,
    loading: detailLoading,
    error: detailError,
    loaded: detailLoaded,
  } = useReviewRunDetail(decodedReviewRunId);

  if ((loading && !data) || (detailLoading && !detailLoaded)) {
    return <div className="notice">Loading scenario context…</div>;
  }

  if (detailError && !detailLoaded) {
    return (
      <div className="notice notice--bad">
        {detailError}{" "}
        <Link className="link" href="/reviews">
          Back to dashboard
        </Link>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="notice notice--bad">
        {detailError ?? "Scenario run not found."}{" "}
        <Link className="link" href="/reviews">
          Back to dashboard
        </Link>
      </div>
    );
  }

  const result = runResult(run);
  const scenarios = scenariosFromRun(run);
  const decodedScenarioId = decodeURIComponent(scenarioId);
  const scenario = scenarios.find(
    (item) => item.id === decodedScenarioId || item.sourceId === decodedScenarioId,
  );
  if (!scenario) {
    return (
      <div className="notice notice--bad">
        Scenario not found for this review run.{" "}
        <Link className="link" href="/reviews">
          Back to dashboard
        </Link>
      </div>
    );
  }

  const previousScenario = scenarios[scenario.index - 2];
  const nextScenario = scenarios[scenario.index];
  const gate = result?.review_gate;
  const simulation = scenarioSimulation(scenario, run);
  const simulationResult = result?.simulation;
  const simulationError = simulationResult?.error;
  const scenarioBadge = scenarioResultBadge(scenario, run);
  const trail = scenarioTrail(scenario);
  const evaluationPending = !simulationResult && scenarioEvaluationPending(run);
  const expectedOutcome = scenarioExpectedOutcome(scenario);
  // Outcome-driven and trust-gated (matches checkRunConclusion /
  // blockingScenarioFailures): a scenario blocks only when it actually FAILED
  // simulation at or above the configured risk level AND the failure is
  // trustworthy (judge consensus, high confidence, or a corroborating
  // final-review finding). A low-confidence, uncorroborated FAIL is surfaced as a
  // concern but does NOT block — the simulation predicts behavior without running
  // the code, so a flimsy verdict should not gate a merge. Merely generating a
  // high-risk scenario is not blocking either (gate.blocking is informational).
  const blockingLevel = gate?.blocking_level ?? "high";
  const findings = result?.final_review?.findings ?? result?.findings ?? [];
  const isBlocking = !evaluationPending && scenarioFailureBlocks(simulation, blockingLevel, findings);
  // Failed at/above threshold, but the failure was not trusted enough to block.
  const failedButNotBlocking =
    !evaluationPending &&
    !isBlocking &&
    blockingLevel !== "off" &&
    simulation?.status === "fail" &&
    riskMeetsThreshold(scenario.risk, blockingLevel);

  return (
    <article className="detail">
      <BackLink href={`/reviews/${encodeURIComponent(run.review_run_id)}`}>Review run</BackLink>

      <DetailHeader
        kicker={`Scenario ${scenario.index} of ${scenarios.length}`}
        title={scenario.title}
        badges={
          <>
            <Badge tone={riskTone(scenario.risk)}>Risk: {scenarioRiskLabel(scenario.risk)}</Badge>
            <Badge tone={scenarioBadge.tone}>Scenario: {scenarioBadge.label}</Badge>
            <span className="cell-mono">{shortSha(run.pull_request.head_sha)}</span>
          </>
        }
        actions={
          <>
            {previousScenario ? (
              <Link className="btn btn--sm" href={scenarioPath(run.review_run_id, previousScenario.id)}>
                Previous
              </Link>
            ) : null}
            {nextScenario ? (
              <Link className="btn btn--sm" href={scenarioPath(run.review_run_id, nextScenario.id)}>
                Next
              </Link>
            ) : null}
            {run.pull_request.html_url ? (
              <ExternalLink className="btn btn--sm" href={run.pull_request.html_url}>
                PR #{run.pull_request.number ?? "—"}
              </ExternalLink>
            ) : null}
            {result?.github_comment_url ? (
              <ExternalLink className="btn btn--sm" href={result.github_comment_url}>
                PR comment
              </ExternalLink>
            ) : null}
            {result?.github_check_run_url ? (
              <ExternalLink className="btn btn--sm" href={result.github_check_run_url}>
                Check run
              </ExternalLink>
            ) : null}
          </>
        }
      />

      <section className={`verdict verdict--${scenarioBadge.tone || "info"}`}>
        <div className="verdict__head">
          <span className="verdict__status">{scenarioBadge.label}</span>
          <span className="verdict__metrics">
            {simulation ? (
              <span>
                Confidence <b>{Math.round(simulation.confidence * 100)}%</b>
              </span>
            ) : null}
            {simulation ? (
              <span>
                Steps{" "}
                <b>
                  {simulation.executed_steps.length}/{simulation.total_steps}
                </b>
              </span>
            ) : null}
            {simulation?.duration_ms !== undefined ? (
              <span>
                Duration <b>{formatDuration(simulation.duration_ms)}</b>
              </span>
            ) : null}
          </span>
        </div>
        <p className="verdict__text">{scenarioFinalVerdict(simulation)}</p>
        {isBlocking ? (
          <p className="verdict__note">
            <strong>Blocks the merge.</strong> The simulation failed with a trustworthy verdict (judge consensus, high
            confidence, or a corroborating final-review finding), and the scenario risk (
            {scenarioRiskLabel(scenario.risk)}) is at or above the configured blocking threshold of {blockingLevel}.
          </p>
        ) : null}
        {failedButNotBlocking ? (
          <p className="verdict__note">
            <strong>Failed, but not blocking.</strong> The failure was low-confidence and not corroborated by the final
            review. Because the simulation predicts behavior without executing the code, a flimsy failure is treated as a
            concern to verify rather than a hard merge block.
          </p>
        ) : null}
        {evaluationPending ? <p className="verdict__note">Simulation is still running for this scenario.</p> : null}
        {!simulation && simulationResult ? (
          <p className="verdict__note">
            <strong>Simulation unavailable.</strong>{" "}
            {simulationError ?? "No simulation result was produced for this scenario."}
          </p>
        ) : null}
        {simulation?.warning ? <p className="verdict__note">{simulation.warning}</p> : null}
      </section>

      <section className="section">
        <div className="section__title">Scenario</div>
        <div className="def">
          <div className="def__block">
            <div className="def__term">Summary</div>
            <p className="def__desc">{scenarioSummary(scenario)}</p>
          </div>
          <div className="def__block">
            <div className="def__term">Why this scenario</div>
            <p className="def__desc def__desc--muted">{scenarioRationale(scenario, run)}</p>
          </div>
          <div className="def__block">
            <div className="def__term">Pre-conditions</div>
            <TextList items={scenario.preconditions} emptyText="No pre-conditions recorded." />
          </div>
          <div className="def__block">
            <div className="def__term">Expected outcome</div>
            <TextList items={expectedOutcome} emptyText="No expected outcome recorded." />
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section__title">Simulation</div>
        <ScenarioTrail entries={trail} simulation={simulation} />
      </section>

      <ScenarioSimulationRuns runs={data?.review_runs ?? []} currentRun={run} currentScenario={scenario} />

      <details className="more-context">
        <summary className="more-context__summary">
          <span className="more-context__title">Additional context</span>
          <span className="more-context__hint">Scenario, run, artifacts, diff &amp; events</span>
        </summary>
        <div className="more-context__body">
          <section className="two-col">
            <section className="section">
              <div className="section__title">Scenario context</div>
              <pre className="code-block">{scenario.markdown}</pre>
            </section>

            <section className="section">
              <div className="section__title">Run context</div>
              <dl className="dl">
                <ContextItem label="Repository" value={run.repository.full_name ?? "—"} />
                <ContextItem
                  label="Pull request"
                  value={`#${run.pull_request.number ?? "—"} ${run.pull_request.title ?? ""}`}
                />
                <ContextItem label="Author" value={run.pull_request.author ?? "—"} />
                <ContextItem
                  label="Branch"
                  value={`${run.pull_request.head_ref ?? "—"} → ${run.pull_request.base_ref ?? "—"}`}
                />
                <ContextItem label="Review run" value={run.review_run_id} />
                <ContextItem label="Trigger run" value={run.trigger_run_id ?? "—"} />
                <ContextItem label="Created" value={formatDate(run.created_at)} />
                <ContextItem label="Finished" value={formatDate(run.finished_at)} />
              </dl>
            </section>
          </section>

          <section className="two-col">
            <section className="section">
              <div className="section__title">Scenario generation details</div>
              <dl className="dl">
                <ContextItem label="Scenario ID" value={scenario.sourceId ?? scenario.id} />
                <ContextItem label="Surface" value={listText(scenario.surface)} />
                <ContextItem label="Risk types" value={listText(scenario.riskTypes)} />
                <ContextItem label="Evidence sources" value={listText(scenario.evidenceSources)} />
                <ContextItem label="Symbols" value={listText(scenario.symbols)} />
              </dl>
            </section>

            <section className="section">
              <div className="section__title">Simulation/Judge details</div>
              {simulation ? (
                <>
                  <dl className="dl">
                    <ContextItem label="Scenario ID" value={simulation.id} />
                    <ContextItem label="Index" value={String(simulation.index)} />
                    <ContextItem label="Title" value={simulation.title} />
                    <ContextItem label="Risk" value={simulation.risk} />
                    <ContextItem label="Source files" value={listText(simulation.source_files)} />
                  </dl>
                  <StepVerdicts steps={simulation.steps} />
                </>
              ) : (
                <EmptyState>No simulation or judge details recorded.</EmptyState>
              )}
            </section>
          </section>

          <section className="section">
            <div className="section__title">Artifacts &amp; files</div>
            <div className="split">
              <ArtifactGroup title="Relevant paths" files={scenario.relevantPaths} emptyText="No relevant paths recorded." />
              <ArtifactGroup
                title="Changed files"
                files={result?.changed_files ?? []}
                emptyText="No changed files recorded."
              />
            </div>
          </section>

          <section className="section">
            <div className="section__title">Diff stat</div>
            <pre className="code-block code-block--sm">{result?.diff_stat || "No diff stat recorded."}</pre>
          </section>

          <section className="section">
            <div className="section__title">Review events</div>
            <EventTimeline events={run.events} />
          </section>
        </div>
      </details>
    </article>
  );
}

function ScenarioSimulationRuns({
  runs,
  currentRun,
  currentScenario,
}: {
  runs: ReviewRun[];
  currentRun: ReviewRun;
  currentScenario: ParsedScenario;
}) {
  interface Entry { run: ReviewRun; scenario: ParsedScenario; sim: ScenarioSimulationScenario }
  // Group strictly by the stable lineage_key — i.e. the *same target scenario*
  // retried across review runs. Without a lineage_key (e.g. no simulation result
  // yet) we cannot tell scenarios apart, so we do not group: showing positional,
  // index-matched scenarios would surface completely unrelated scenarios.
  const lineageKey = scenarioLineageKey(currentScenario, currentRun);
  const { selected, ready, legacyReviewMode } = useTenant();
  const isCurrentTenant = useTenantFence();
  const requestReady = ready && (selected !== null || legacyReviewMode);
  const [lineageRuns, setLineageRuns] = useState<ReviewRun[] | undefined>();
  const [lineageTenantId, setLineageTenantId] = useState<string | null | undefined>();

  useEffect(() => {
    if (!lineageKey || !requestReady) {
      setLineageRuns(undefined);
      return;
    }
    const controller = new AbortController();
    const requestTenantId = selected?.tenantId ?? null;
    setLineageRuns(undefined);
    setLineageTenantId(requestTenantId);
    getScenarioLineageRuns(currentRun.review_run_id, lineageKey, requestTenantId, controller.signal)
      .then((items) => {
        if (isCurrentTenant(requestTenantId)) {
          setLineageRuns(items);
          setLineageTenantId(requestTenantId);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          // An authorization or transport failure must not fall back to previously loaded review
          // history. An empty array is a resolved, fail-closed result; undefined means loading.
          setLineageRuns([]);
          setLineageTenantId(requestTenantId);
        }
      });
    return () => controller.abort();
  }, [currentRun.review_run_id, isCurrentTenant, lineageKey, requestReady, selected?.tenantId]);

  if (!lineageKey) {
    return null;
  }
  const scopedLineageRuns = lineageTenantId === (selected?.tenantId ?? null) ? lineageRuns : undefined;
  const sourceRuns = scopedLineageRuns ?? runs;
  const entries: Entry[] = sourceRuns
    .filter(
      (item) =>
        item.repository.full_name === currentRun.repository.full_name &&
        item.pull_request.number === currentRun.pull_request.number,
    )
    .map((item) => {
      const sim = (runResult(item)?.simulation?.scenarios ?? []).find((s) => s.lineage_key === lineageKey);
      if (!sim) {
        return undefined;
      }
      const scenario = scenariosFromRun(item).find(
        (candidate) => candidate.id === sim.id || candidate.sourceId === sim.id || candidate.index === sim.index,
      );
      if (!scenario) {
        return undefined;
      }
      return { run: item, scenario, sim };
    })
    .filter((entry): entry is Entry => Boolean(entry));

  if (entries.length <= 1) {
    return null;
  }

  return (
    <section className="section">
      <div className="section__title">Simulation runs for this scenario ({entries.length})</div>
      <div>
        {entries.map(({ run, scenario, sim }) => {
          const tone = simulationStatusTone(sim?.status);
          const current = run.review_run_id === currentRun.review_run_id;
          return (
            <Link
              key={run.review_run_id}
              className={`sim-run${current ? " sim-run--current" : ""}`}
              href={scenarioPath(run.review_run_id, scenario.id)}
            >
              <Badge tone={tone}>{sim?.status ?? "no sim"}</Badge>
              <span className="cell-mono">{shortSha(run.pull_request.head_sha)}</span>
              <span className="cell-meta">{formatDate(run.created_at)}</span>
              <span className="sim-run__verdict">{sim?.final_verdict ?? "—"}</span>
              {current ? <Badge>current</Badge> : null}
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function TrailRow({ entry, sim }: { entry: ScenarioTrailEntry; sim?: ScenarioSimulationStep | undefined }) {
  return (
    <div className="trail__row">
      <span className="trail__marker">{entry.marker}</span>
      <span className={`trail__dot trail__dot--${entry.type}`} aria-hidden="true" />
      <div className="trail__body">
        <p>{entry.description}</p>
        {entry.detail ? <code>{entry.detail}</code> : null}
        {sim ? (
          <div className="trail__sim">
            <Badge tone={simStepTone(sim)}>{sim.step_status}</Badge>
            <span className="cell-meta">{sim.consensus_reached ? "consensus" : "no consensus"}</span>
            {sim.rounds !== undefined ? (
              <span className="cell-meta">{sim.rounds} round{sim.rounds === 1 ? "" : "s"}</span>
            ) : null}
            {sim.duration_ms !== undefined ? <span className="cell-meta">{formatDuration(sim.duration_ms)}</span> : null}
            {sim.confidence !== undefined ? (
              <span className="cell-meta">{Math.round(sim.confidence * 100)}% confidence</span>
            ) : null}
            {sim.predicted_output ? <code>{sim.predicted_output}</code> : null}
            <StepEvidence step={sim} />
          </div>
        ) : null}
      </div>
      <span className="trail__type">{sim ? sim.step_status : entry.type}</span>
    </div>
  );
}

function simStepTone(step: ScenarioSimulationStep): "ok" | "warn" | "bad" {
  if (step.step_status === "FAIL") return "bad";
  if (step.step_status === "INSUFFICIENT_CONTEXT") return "warn";
  return "ok";
}

function StepEvidence({ step }: { step: ScenarioSimulationStep }) {
  const blocks = [
    { title: "State changes", value: step.state_changes },
    { title: "Boundary findings", value: step.boundary_findings },
    { title: "Source citations", value: step.source_citations },
  ].filter((block) => block.value.length > 0);

  if (blocks.length === 0) {
    return null;
  }

  return (
    <div className="trail-evidence">
      {blocks.map((block) => (
        <details className="disclosure trail-evidence__item" key={block.title}>
          <summary>{block.title}</summary>
          <pre className="code-block code-block--sm">{formatJson(block.value)}</pre>
        </details>
      ))}
    </div>
  );
}

function stepNumberFromMarker(marker: string): number | undefined {
  const match = /^step (\d+)$/.exec(marker);
  return match ? Number(match[1]) : undefined;
}

function TextList({ items, emptyText }: { items: string[]; emptyText: string }) {
  if (items.length === 0) {
    return <p className="def__desc def__desc--muted">{emptyText}</p>;
  }

  return (
    <ul className="scenario-list">
      {items.map((item, index) => (
        <li key={`${index}:${item}`}>{item}</li>
      ))}
    </ul>
  );
}

function StepVerdicts({ steps }: { steps: ScenarioSimulationStep[] }) {
  const verdicts = steps.filter((step) => step.scenario_verdict);
  if (verdicts.length === 0) {
    return null;
  }

  return (
    <div className="step-verdicts">
      <div className="split__title">Step verdicts</div>
      <ol>
        {verdicts.map((step) => (
          <li key={step.step_index}>
            <span className="cell-mono">step {step.step_index}</span>
            <p>{step.scenario_verdict}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ContextItem({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function ArtifactGroup({ title, files, emptyText }: { title: string; files: string[]; emptyText: string }) {
  return (
    <div>
      <div className="split__title">{title}</div>
      {files.length === 0 ? (
        <EmptyState>{emptyText}</EmptyState>
      ) : (
        <ul className="file-list">
          {files.map((file) => (
            <li key={file}>{file}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function listText(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "—";
}

function ScenarioTrail({
  entries,
  simulation,
}: {
  entries: ScenarioTrailEntry[];
  simulation: ScenarioSimulationScenario | undefined;
}) {
  const simSteps = simulation?.steps ?? [];
  const stepsByIndex = new Map(simSteps.map((step) => [step.step_index, step]));
  const covered = new Set<number>();

  const trailRows = entries.map((entry, index) => {
    const stepNumber = stepNumberFromMarker(entry.marker);
    const sim = stepNumber !== undefined ? stepsByIndex.get(stepNumber) : undefined;
    if (sim) {
      covered.add(sim.step_index);
    }
    return <TrailRow key={`${entry.marker}:${index}`} entry={entry} sim={sim} />;
  });

  // Surface any judged steps that have no matching planned trail entry.
  const orphanRows = simSteps
    .filter((step) => !covered.has(step.step_index))
    .map((step) => (
      <TrailRow
        key={`sim-step:${step.step_index}`}
        entry={{ marker: `step ${step.step_index}`, type: "action", description: step.step_text }}
        sim={step}
      />
    ));

  if (trailRows.length === 0 && orphanRows.length === 0) {
    return (
      <EmptyState>
        No steps were recorded for this scenario. Re-run the review with the latest worker to generate step-by-step
        scenarios.
      </EmptyState>
    );
  }

  return (
    <div className="sim-detail">
      {simulation ? (
        <div className="sim-detail__summary">
          <Badge tone={simulationStatusTone(simulation.status)}>{simulation.status}</Badge>
          <span hidden>Verdict: {simulation.final_verdict}</span>
          <span>Confidence: {Math.round(simulation.confidence * 100)}%</span>
          <span>
            Steps: {simulation.executed_steps.length}/{simulation.total_steps}
          </span>
          {simulation.duration_ms !== undefined ? <span>Duration: {formatDuration(simulation.duration_ms)}</span> : null}
        </div>
      ) : null}
      {simulation?.warning ? <div className="error-text">{simulation.warning}</div> : null}
      <div className="trail">
        {trailRows}
        {orphanRows}
      </div>
    </div>
  );
}

function EventTimeline({ events }: { events: ReviewEvent[] }) {
  if (events.length === 0) {
    return <EmptyState>No events recorded.</EmptyState>;
  }

  return (
    <ol className="events">
      {events.map((event, index) => (
        <li key={`${event.recorded_at}:${event.status}:${index}`}>
          <div className="events__row">
            <strong>{event.status}</strong>
            <span>{formatDate(event.recorded_at)}</span>
          </div>
          {event.payload ? (
            <details className="disclosure">
              <summary>Payload</summary>
              <pre className="code-block code-block--sm">{formatJson(event.payload)}</pre>
            </details>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
