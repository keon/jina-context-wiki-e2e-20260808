import type { ParsedScenario, ScenarioRisk } from "./historical-scenarios";
import { runResult } from "./run-result";
import type {
  ReviewIssue,
  ReviewRun,
  ScenarioDisplayStatus,
  ScenarioSimulationScenario,
  ScenarioSimulationStatus,
  ScenarioTrailEntry,
  Tone,
} from "./types";

export function scenarioRiskLabel(risk: ScenarioRisk): string {
  if (risk === "high") return "High";
  if (risk === "medium") return "Medium";
  if (risk === "low") return "Low";
  return "Unknown";
}

export function scenarioResultBadge(
  scenario: ParsedScenario,
  run: ReviewRun,
): { label: string; tone: Tone } {
  const simulation = scenarioSimulation(scenario, run);
  if (simulation?.status === "pass") return { label: "Passed", tone: "ok" };
  if (simulation?.status === "fail") return { label: "Failed", tone: "bad" };
  if (simulation?.status === "warn") return { label: "Warn", tone: "warn" };
  return { label: "Pending", tone: "info" };
}

export function scenarioSummary(scenario: ParsedScenario): string {
  return scenario.summary || scenario.expectedResult || scenario.steps[0] || "No summary recorded.";
}

export function scenarioRationale(scenario: ParsedScenario, run: ReviewRun): string {
  const result = runResult(run);
  return (
    scenario.rationale ||
    scenario.context ||
    (scenario.relevantPaths.length > 0
      ? `Connected to ${scenario.relevantPaths.join(", ")}.`
      : firstSentence(result?.codegraph_context) ||
        "Generated from the PR diff, repository history, and CodeGraph context.")
  );
}

export function scenarioExpectedOutcome(scenario: ParsedScenario): string[] {
  return scenario.expectedOutcomes.length > 0
    ? scenario.expectedOutcomes
    : scenario.expectedResult
      ? [scenario.expectedResult]
      : [];
}

export function scenarioFinalVerdict(
  simulation: ScenarioSimulationScenario | undefined,
): string {
  return simulation?.final_verdict || "No final verdict recorded.";
}

export function scenarioDisplayStatus(scenario: ParsedScenario, run: ReviewRun): ScenarioDisplayStatus {
  const result = runResult(run);
  const simulation = scenarioSimulation(scenario, run);
  if (simulation) {
    return simulation.status;
  }

  if (result?.simulation) {
    return "generated";
  }

  if (scenarioEvaluationPending(run)) {
    return run.status.toLowerCase().includes("queued") ? "queued" : "running";
  }

  const gate = result?.review_gate;
  if (gate?.blocking && riskMeetsThreshold(scenario.risk, gate.blocking_level)) {
    return "blocking";
  }

  const status = run.status.toLowerCase();
  if (status.includes("queued")) return "queued";
  if (status.includes("running") || status.includes("review") || status.includes("token")) return "running";
  if (status.includes("complete") || status.includes("published") || status.includes("pass")) return "complete";
  return "generated";
}

export function scenarioEvaluationPending(run: ReviewRun): boolean {
  if (run.finished_at) {
    return false;
  }

  const status = run.status.toLowerCase();
  return (
    status.includes("queued") ||
    status.includes("token") ||
    status.includes("history") ||
    status.includes("codegraph") ||
    status.includes("scenario_generation") ||
    status.includes("scenario_simulation") ||
    status.includes("final_review") ||
    status.includes("running") ||
    status.includes("started")
  );
}

const SCENARIO_STATUS_LABELS: Partial<Record<ScenarioDisplayStatus, string>> = {
  pass: "Passed",
  fail: "Failed",
  warn: "Warn",
  blocking: "Blocking",
  running: "Generating",
  queued: "Queued",
  complete: "Complete",
};

export function scenarioStatusLabel(status: ScenarioDisplayStatus): string {
  return SCENARIO_STATUS_LABELS[status] ?? "Generated";
}

export function scenarioSimulation(
  scenario: ParsedScenario,
  run: ReviewRun,
): ScenarioSimulationScenario | undefined {
  return runResult(run)?.simulation?.scenarios?.find(
    (item) => item.id === scenario.id || item.id === scenario.sourceId || item.index === scenario.index,
  );
}

export function scenarioLineageKey(scenario: ParsedScenario, run: ReviewRun): string | undefined {
  return scenarioSimulation(scenario, run)?.lineage_key;
}

export function simulationStatusTone(status: ScenarioSimulationStatus | undefined): Tone {
  if (status === "pass") return "ok";
  if (status === "fail") return "bad";
  if (status === "warn") return "warn";
  return "";
}

// Historical scenario displays used this trust threshold when simulation was
// still part of the active review path.
const HISTORICAL_SCENARIO_BLOCKING_MIN_CONFIDENCE = 0.7;

// Historical display logic for old simulation runs: a simulated FAIL only
// blocks when it was considered trustworthy.
export function scenarioFailureBlocks(
  simulation: ScenarioSimulationScenario | undefined,
  blockingLevel: string,
  findings: ReviewIssue[] = [],
): boolean {
  if (!simulation || blockingLevel === "off" || simulation.status !== "fail") {
    return false;
  }
  if (!riskMeetsThreshold(simulation.risk, blockingLevel)) {
    return false;
  }

  // Strongest: multiple judge providers agreed on a failing step.
  const reachedConsensus = (simulation.steps ?? []).some(
    (step) => step.consensus_reached && String(step.step_status).toUpperCase() === "FAIL",
  );
  if (reachedConsensus) {
    return true;
  }

  // High judge confidence (scenario verdict, or the best failing step).
  const failConfidence = Math.max(
    typeof simulation.confidence === "number" ? simulation.confidence : 0,
    ...(simulation.steps ?? [])
      .filter((step) => String(step.step_status).toUpperCase() === "FAIL")
      .map((step) => (typeof step.confidence === "number" ? step.confidence : 0)),
    0,
  );
  if (failConfidence >= HISTORICAL_SCENARIO_BLOCKING_MIN_CONFIDENCE) {
    return true;
  }

  // Corroborated by an independent final-review finding on the same file.
  const sources = new Set((simulation.source_files ?? []).filter(Boolean));
  return sources.size > 0 && findings.some((finding) => Boolean(finding.file_path) && sources.has(finding.file_path as string));
}

export function riskMeetsThreshold(risk: ScenarioRisk, threshold: string): boolean {
  const levels: Record<ScenarioRisk, number> = { unknown: 0, low: 1, medium: 2, high: 3 };
  // Fail safe: an unrecognized threshold falls back to the lowest real level
  // ("low") so the gate still blocks rather than silently letting everything
  // through (which a +Infinity default would do).
  const thresholdValue = levels[threshold.toLowerCase() as ScenarioRisk] ?? levels.low;
  return levels[risk] >= thresholdValue;
}

export function riskTone(risk: ScenarioRisk): Tone {
  if (risk === "high") return "bad";
  if (risk === "medium") return "warn";
  if (risk === "low") return "ok";
  return "";
}

export function scenarioTrail(scenario: ParsedScenario): ScenarioTrailEntry[] {
  const entries: ScenarioTrailEntry[] = scenario.steps.map((step, index) => ({
    marker: `step ${index + 1}`,
    type: stepType(step),
    description: step,
  }));

  if (scenario.expectedResult) {
    entries.push({ marker: "expect", type: "assertion", description: scenario.expectedResult });
  }

  if (scenario.context) {
    entries.push({ marker: "why", type: "context", description: scenario.context });
  }

  return entries;
}

function stepType(step: string): ScenarioTrailEntry["type"] {
  const value = step.toLowerCase();
  if (/(seed|setup|precondition|prepare|provision|create test|fixture)/.test(value)) return "setup";
  if (/(assert|expect|verify|confirm|should|must|prove)/.test(value)) return "assertion";
  if (/(observe|inspect|check|record|measure|capture)/.test(value)) return "observation";
  return "action";
}

function firstSentence(value?: string): string | undefined {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  const match = cleaned.match(/^(.+?[.!?])\s/);
  return match?.[1] ?? cleaned.slice(0, 180);
}

export function statusTone(status: string): Tone {
  const value = status.toLowerCase();
  if (value.includes("fail") || value.includes("error") || value.includes("block")) return "bad";
  if (value.includes("warn")) return "warn";
  if (value.includes("complete") || value.includes("published") || value.includes("pass")) return "ok";
  if (value.includes("queued") || value.includes("running") || value.includes("review") || value.includes("token")) {
    return "warn";
  }
  return "";
}

export function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

export function formatRelative(value?: string) {
  if (!value) return "—";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "—";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(value).toLocaleDateString();
}

export function formatDuration(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1_000) return `${Math.round(value)}ms`;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder > 0 ? `${hours}h ${minuteRemainder}m` : `${hours}h`;
}

export function shortSha(value?: string) {
  return value ? value.slice(0, 8) : "—";
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
