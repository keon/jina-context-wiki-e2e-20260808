type ScenarioRisk = "high" | "medium" | "low" | "unknown";

export type ParsedScenario = {
  id: string;
  index: number;
  risk: ScenarioRisk;
  title: string;
  steps: string[];
  expectedResult?: string;
  context?: string;
  relevantPaths: string[];
  markdown: string;
};

const scenarioLinePattern = /^\s*-\s\[(?:\s?|x|X)\]\s*(.+)$/;
const riskPattern = /\[risk:\s*(high|medium|low)\]/i;
const simulationStatusPattern = /\[(?:pass|fail|warn)\]\s*/i;
const detailsLinkPattern = /\s*\[details\]\([^)]+\)\s*$/i;
const relevantPathsPattern = /Relevant paths:\s*([^.\n]+(?:\.[^.\n]+)*)(?:\.|$)/i;
const numberedStepPattern = /^\s*\d+\.\s+(.+)$/;
const bulletStepPattern = /^\s*[-*]\s+(.+)$/;

export function parseScenarios(markdown: string | undefined): ParsedScenario[] {
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

export function parseScenarioJson(value: unknown): ParsedScenario[] {
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

export function scenarioStepType(step: string): "setup" | "action" | "assertion" | "observation" {
  const value = step.toLowerCase();
  if (/(seed|setup|precondition|prepare|provision|create test|fixture)/.test(value)) return "setup";
  if (/(assert|expect|verify|confirm|should|must|prove)/.test(value)) return "assertion";
  if (/(observe|inspect|check|record|measure|capture)/.test(value)) return "observation";
  return "action";
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
    steps: details.steps,
    expectedResult: details.expectedResult,
    context: details.context,
    relevantPaths: relevantPathsFromLine(firstLine),
    markdown,
  });
}

function scenarioFromJson(value: unknown, index: number): ParsedScenario | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const title = stringField(raw.title) || `Scenario ${index + 1}`;
  const summary = stringField(raw.summary);
  const risk = riskFromValue(raw.riskLevel ?? raw.risk);
  const files = stringList(raw.files);
  const surface = stringList(raw.surface);
  const steps = stringList(raw.steps);
  const expectedOutcome = stringList(raw.expectedOutcome);
  const rationale = stringField(raw.rationale);
  const preconditions = stringList(raw.preconditions);
  const relevantPaths = files.length > 0 ? files : surface;

  return {
    id: `scenario-${index + 1}`,
    index: index + 1,
    risk,
    title,
    steps,
    expectedResult: expectedOutcome.join(" ") || undefined,
    context: rationale || summary,
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
  summary?: string;
  risk: ScenarioRisk;
  relevantPaths: string[];
  preconditions: string[];
  steps: string[];
  expectedOutcome: string[];
  rationale?: string;
}): string {
  const paths = input.relevantPaths.length > 0 ? input.relevantPaths.join(", ") : "not specified";
  const lines = [`- [ ] [risk: ${input.risk}] ${input.title}${input.summary ? ` - ${input.summary}` : ""}. Relevant paths: ${paths}.`];
  if (input.preconditions.length > 0) {
    lines.push("  Preconditions:", ...input.preconditions.map((item) => `  - ${item}`));
  }
  lines.push("  Steps:", ...input.steps.map((step, stepIndex) => `  ${stepIndex + 1}. ${step}`));
  if (input.expectedOutcome.length > 0) {
    lines.push(`  Expected result: ${input.expectedOutcome.join(" ")}`);
  }
  if (input.rationale) {
    lines.push(`  Context: ${input.rationale}`);
  }
  return lines.join("\n");
}

function riskFromValue(value: unknown): ScenarioRisk {
  const risk = typeof value === "string" ? value.toLowerCase() : "";
  if (risk === "high" || risk === "medium" || risk === "low") {
    return risk;
  }
  return "unknown";
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
  const risk = line.match(riskPattern)?.[1]?.toLowerCase();
  if (risk === "high" || risk === "medium" || risk === "low") {
    return risk;
  }
  return "unknown";
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
  const raw = line.match(relevantPathsPattern)?.[1];
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((path) => path.trim().replace(/\.$/, ""))
    .filter(Boolean);
}

function scenarioDetails(lines: string[]): { steps: string[]; expectedResult?: string; context?: string } {
  const steps: string[] = [];
  let section: "steps" | undefined;
  let expectedResult: string | undefined;
  let context: string | undefined;

  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const label = labelValue(trimmed);
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

    const numberedStep = trimmed.match(numberedStepPattern)?.[1];
    if (numberedStep && section === "steps") {
      steps.push(numberedStep.trim());
      continue;
    }
    const bulletStep = trimmed.match(bulletStepPattern)?.[1];
    if (bulletStep && section === "steps") {
      steps.push(bulletStep.trim());
    }
  }

  return { steps, expectedResult, context };
}

function labelValue(value: string): { label: string; value: string } | undefined {
  const match = value.match(/^([A-Za-z ]+):\s*(.*)$/);
  if (!match) {
    return undefined;
  }
  return { label: (match[1] ?? "").trim().toLowerCase(), value: (match[2] ?? "").trim() };
}

function appendText(current: string | undefined, next: string): string | undefined {
  if (!next) {
    return current;
  }
  return current ? `${current} ${next}` : next;
}
