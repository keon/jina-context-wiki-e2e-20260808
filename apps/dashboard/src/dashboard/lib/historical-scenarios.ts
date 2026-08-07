import { runResult } from "./run-result";
import type { ReviewRun } from "./types";

export type ScenarioRisk = "high" | "medium" | "low" | "unknown";

export interface ParsedScenario {
  id: string;
  sourceId?: string | undefined;
  index: number;
  risk: ScenarioRisk;
  title: string;
  summary?: string | undefined;
  steps: string[];
  expectedOutcomes: string[];
  expectedResult?: string | undefined;
  context?: string | undefined;
  preconditions: string[];
  rationale?: string | undefined;
  surface: string[];
  riskTypes: string[];
  evidenceSources: string[];
  files: string[];
  symbols: string[];
  relevantPaths: string[];
  markdown: string;
}

const scenarioLinePattern = /^\s*-\s\[(?:\s?|x|X)\]\s*(.+)$/;
const riskPattern = /\[risk:\s*(high|medium|low)\]/i;
const simulationStatusPattern = /\[(?:pass|fail|warn)\]\s*/i;
const detailsLinkPattern = /\s*\[details\]\([^)]+\)\s*$/i;
const relevantPathsPattern = /Relevant paths:\s*([^.\n]+(?:\.[^.\n]+)*)(?:\.|$)/i;
const numberedStepPattern = /^\s*\d+\.\s+(.+)$/;
const bulletStepPattern = /^\s*[-*]\s+(.+)$/;

function parseScenarios(markdown: string | undefined): ParsedScenario[] {
  if (!markdown) {
    return [];
  }

  const scenarios: ParsedScenario[] = [];
  let currentLines: string[] = [];

  for (const line of markdown.split("\n")) {
    if (scenarioLinePattern.test(line)) {
      pushScenario(scenarios, currentLines);
      currentLines = [line];
      continue;
    }

    if (currentLines.length === 0) {
      continue;
    }

    if (line.trim() === "" || line.startsWith(" ") || line.startsWith("\t")) {
      currentLines.push(line);
      continue;
    }

    pushScenario(scenarios, currentLines);
    currentLines = [];
  }

  pushScenario(scenarios, currentLines);
  return scenarios;
}

export function scenariosFromRun(run: ReviewRun): ParsedScenario[] {
  return scenariosFromResult(runResult(run));
}

export function scenariosFromResult(result: ReviewRun["result"]): ParsedScenario[] {
  const structured = parseScenarioJson(result?.scenario_json);
  if (structured.length > 0) {
    return structured;
  }

  return parseScenarios(result?.review_markdown ?? result?.markdown_preview);
}

export function scenarioPath(reviewRunId: string, scenarioId: string): string {
  return `/reviews/${encodeURIComponent(reviewRunId)}/scenarios/${encodeURIComponent(scenarioId)}`;
}

function pushScenario(scenarios: ParsedScenario[], lines: string[]): void {
  if (lines.length === 0) {
    return;
  }

  const markdown = lines.join("\n").trimEnd();
  const firstLine = lines[0] ?? "";
  const risk = riskFromLine(firstLine);
  const index = scenarios.length + 1;
  const details = scenarioDetails(lines);

  scenarios.push({
    id: `scenario-${index}`,
    index,
    risk,
    title: titleFromLine(firstLine, index),
    summary: undefined,
    steps: details.steps,
    expectedOutcomes: details.expectedResult ? [details.expectedResult] : [],
    expectedResult: details.expectedResult,
    context: details.context,
    preconditions: details.preconditions,
    rationale: details.context,
    surface: [],
    riskTypes: [],
    evidenceSources: [],
    files: relevantPathsFromLine(firstLine),
    symbols: [],
    relevantPaths: relevantPathsFromLine(firstLine),
    markdown,
  });
}

function parseScenarioJson(value: unknown): ParsedScenario[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const scenarios = (value as { scenarios?: unknown }).scenarios;
  if (!Array.isArray(scenarios)) {
    return [];
  }

  return scenarios
    .map((scenario, index) => scenarioFromJson(scenario, index))
    .filter((scenario): scenario is ParsedScenario => Boolean(scenario));
}

function scenarioFromJson(value: unknown, index: number): ParsedScenario | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const sourceId = stringField(raw.id);
  const title = stringField(raw.title) || `Scenario ${index + 1}`;
  const summary = stringField(raw.summary);
  const risk = riskFromValue(raw.riskLevel ?? raw.risk);
  const files = stringList(raw.files);
  const surface = stringList(raw.surface);
  const riskTypes = stringList(raw.riskTypes);
  const evidenceSources = stringList(raw.evidenceSources);
  const symbols = stringList(raw.symbols);
  const steps = stringList(raw.steps);
  const expectedOutcome = stringList(raw.expectedOutcome);
  const rationale = stringField(raw.rationale);
  const preconditions = stringList(raw.preconditions);
  const relevantPaths = files.length > 0 ? files : surface;

  return {
    id: `scenario-${index + 1}`,
    sourceId,
    index: index + 1,
    risk,
    title,
    summary,
    steps,
    expectedOutcomes: expectedOutcome,
    expectedResult: expectedOutcome.join(" ") || undefined,
    context: rationale || summary,
    preconditions,
    rationale,
    surface,
    riskTypes,
    evidenceSources,
    files,
    symbols,
    relevantPaths,
    markdown: scenarioMarkdown({
      title,
      summary,
      risk,
      relevantPaths,
      preconditions,
      steps,
      expectedOutcome,
      rationale,
    }),
  };
}

function scenarioMarkdown(input: {
  title: string;
  summary?: string | undefined;
  risk: ScenarioRisk;
  relevantPaths: string[];
  preconditions: string[];
  steps: string[];
  expectedOutcome: string[];
  rationale?: string | undefined;
}): string {
  const paths = input.relevantPaths.length > 0 ? input.relevantPaths.join(", ") : "not specified";
  const lines = [`- [ ] [risk: ${input.risk}] ${input.title}${input.summary ? ` - ${input.summary}` : ""}. Relevant paths: ${paths}.`];
  if (input.preconditions.length > 0) {
    lines.push("  Preconditions:", ...input.preconditions.map((item) => `  - ${item}`));
  }
  lines.push("  Steps:", ...input.steps.map((step, index) => `  ${index + 1}. ${step}`));
  if (input.expectedOutcome.length > 0) {
    lines.push(`  Expected result: ${input.expectedOutcome.join(" ")}`);
  }
  if (input.rationale) {
    lines.push(`  Context: ${input.rationale}`);
  }
  return lines.join("\n");
}

function coerceRisk(value: string | undefined): ScenarioRisk {
  const risk = value?.toLowerCase();
  return risk === "high" || risk === "medium" || risk === "low" ? risk : "unknown";
}

function riskFromValue(value: unknown): ScenarioRisk {
  return coerceRisk(typeof value === "string" ? value : undefined);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function riskFromLine(line: string): ScenarioRisk {
  return coerceRisk((riskPattern.exec(line))?.[1]);
}

function titleFromLine(line: string, index: number): string {
  const text = line
    .replace(scenarioLinePattern, "$1")
    .replace(simulationStatusPattern, "")
    .replace(riskPattern, "")
    .replace(detailsLinkPattern, "")
    .replace(/\s+/g, " ")
    .trim();

  return text || `Scenario ${index}`;
}

function relevantPathsFromLine(line: string): string[] {
  const raw = (relevantPathsPattern.exec(line))?.[1];
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((path) => path.trim().replace(/\.$/, ""))
    .filter(Boolean);
}

function scenarioDetails(lines: string[]): {
  preconditions: string[];
  steps: string[];
  expectedResult?: string | undefined;
  context?: string | undefined;
} {
  const preconditions: string[] = [];
  const steps: string[] = [];
  let section: "preconditions" | "steps" | undefined;
  let expectedResult: string | undefined;
  let context: string | undefined;

  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const label = labelValue(trimmed);
    if (label?.label === "preconditions") {
      section = "preconditions";
      if (label.value) {
        preconditions.push(label.value);
      }
      continue;
    }

    if (label?.label === "steps") {
      section = "steps";
      if (label.value) {
        steps.push(label.value);
      }
      continue;
    }

    if (label?.label === "expected result") {
      section = undefined;
      expectedResult = appendText(expectedResult, label.value);
      continue;
    }

    if (label?.label === "context") {
      section = undefined;
      context = appendText(context, label.value);
      continue;
    }

    const numberedStep = (numberedStepPattern.exec(trimmed))?.[1];
    if (numberedStep && section) {
      if (section === "steps") steps.push(numberedStep.trim());
      else preconditions.push(numberedStep.trim());
      continue;
    }

    const bulletStep = (bulletStepPattern.exec(trimmed))?.[1];
    if (bulletStep && section) {
      if (section === "steps") steps.push(bulletStep.trim());
      else preconditions.push(bulletStep.trim());
    }
  }

  return {
    preconditions,
    steps,
    expectedResult,
    context,
  };
}

function labelValue(value: string): { label: string; value: string } | undefined {
  const match = /^([A-Za-z ]+):\s*(.*)$/.exec(value);
  if (!match) {
    return undefined;
  }

  return {
    label: (match[1] ?? "").trim().toLowerCase(),
    value: (match[2] ?? "").trim(),
  };
}

function appendText(current: string | undefined, next: string): string | undefined {
  if (!next) {
    return current;
  }

  return current ? `${current} ${next}` : next;
}
