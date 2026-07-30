import type { RefManifestEntry } from "../domain/evidence.js";

export const CONTEXT_ORCHESTRATION_VERSION = 4;
export const CONTEXT_ORCHESTRATION_RELATIVE_PATH = "plan.json";
export const CONTEXT_ORCHESTRATION_STATE_PATH = `/home/daytona/context-engine/derive-state/${CONTEXT_ORCHESTRATION_RELATIVE_PATH}`;

export type ContextOrchestrationPhase = "planning" | "researching" | "reviewing" | "complete" | "partial";
export type ContextPlanItemStatus = "planned" | "in_progress" | "complete" | "unsupported" | "deferred";
export type ContextAreaStatus = "covered" | "unsupported" | "not_applicable";
export type ContextWorkerStatus = "planned" | "working" | "complete" | "failed";
export type ContextMaintenanceQuestionStatus = "open" | "answered" | "unsupported" | "deferred";
export type ContextSubjectKind =
  | "feature"
  | "flow"
  | "component"
  | "interface"
  | "state"
  | "security"
  | "operations"
  | "decision"
  | "history"
  | "pattern";
export type ContextSubjectStatus = "candidate" | "researching" | "covered" | "unsupported" | "deferred";
export type ContextSubjectSignalSource =
  "code" | "tests" | "configuration" | "documentation" | "commit" | "pull_request" | "issue" | "observation";

export interface ContextSubjectSignal {
  readonly source: ContextSubjectSignalSource;
  readonly reference: string;
  readonly description?: string;
}

/**
 * A repository-specific question the generated context must make answerable.
 *
 * The agent discovers these rather than receiving a fixed documentation
 * template. The host checks only that the agent's declared answer and review
 * references are internally truthful.
 */
export interface ContextMaintenanceQuestion {
  readonly id: string;
  readonly question: string;
  readonly priority: "required" | "supporting";
  readonly status: ContextMaintenanceQuestionStatus;
  readonly pageIds: readonly string[];
  readonly reason?: string;
}

/**
 * An evidence-backed behavior or responsibility worth maintaining.
 *
 * Subjects are internal coverage units, not public pages or a prescribed
 * taxonomy. Several related subjects may map to one context document.
 */
export interface ContextSubject {
  readonly id: string;
  readonly kind: ContextSubjectKind;
  readonly statement: string;
  readonly priority: "required" | "supporting";
  readonly status: ContextSubjectStatus;
  readonly signals: readonly ContextSubjectSignal[];
  readonly questions: readonly ContextMaintenanceQuestion[];
  readonly pageIds: readonly string[];
  readonly reason?: string;
}

export interface ContextPlanItem {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly purpose: string;
  readonly priority: "required" | "supporting";
  readonly status: ContextPlanItemStatus;
  readonly scope: {
    readonly paths: readonly string[];
    readonly symbols: readonly string[];
  };
  readonly questions: readonly string[];
  readonly requiredEvidence: readonly ("code" | "tests" | "configuration" | "documentation" | "history" | "provider")[];
  readonly dependencies: readonly string[];
  readonly assignedWorker?: string;
  readonly resolution?: string;
}

export interface ContextCoverageArea {
  readonly id: string;
  readonly status: ContextAreaStatus;
  readonly pageIds: readonly string[];
  readonly reason?: string;
}

export interface ContextWorkerState {
  readonly id: string;
  readonly role: "research" | "critic";
  readonly status: ContextWorkerStatus;
  readonly pageIds: readonly string[];
  readonly summary?: string;
}

/**
 * The lead's durable record of a fresh-perspective review.
 *
 * `context_only` means the reviewer first attempted the maintenance questions
 * from the public context rather than reconstructing answers from source. Any
 * material miss is represented by a gap and returned to the lead's repair loop.
 */
export interface ContextCriticReview {
  readonly id: string;
  readonly kind: "context_only";
  readonly status: ContextWorkerStatus;
  readonly reviewer: "lead" | "subagent";
  readonly workerId?: string;
  readonly results: readonly ContextCriticResult[];
  readonly summary?: string;
}

/**
 * One concrete maintenance task attempted from public context alone.
 *
 * The verdict and pages used make a critic review auditable. A review can no
 * longer mark a question "tested" merely by copying its ID into an array.
 */
export interface ContextCriticResult {
  readonly questionId: string;
  readonly verdict: "pass" | "partial" | "fail";
  readonly pageIds: readonly string[];
  readonly gapIds: readonly string[];
  readonly summary: string;
}

export interface ContextCoverageGap {
  readonly id: string;
  readonly severity: "blocking" | "advisory";
  readonly description: string;
  readonly status: "open" | "resolved" | "unsupported";
  readonly pageId?: string;
  readonly resolution?: string;
}

/**
 * Durable state owned by the Codex lead agent.
 *
 * The host deliberately does not prescribe a wiki taxonomy. It does prescribe
 * identities, terminal states, and repository-area accounting so "covered" is
 * observable rather than a sentence in a prompt.
 */
export interface ContextOrchestrationState {
  readonly version: typeof CONTEXT_ORCHESTRATION_VERSION;
  readonly repository: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly mode: "initial" | "incremental";
  readonly phase: ContextOrchestrationPhase;
  readonly subjects: readonly ContextSubject[];
  readonly items: readonly ContextPlanItem[];
  readonly areas: readonly ContextCoverageArea[];
  readonly workers: readonly ContextWorkerState[];
  readonly reviews: readonly ContextCriticReview[];
  readonly gaps: readonly ContextCoverageGap[];
  readonly completionReason?: string;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new Error(`${path} has unsupported fields: ${extra.join(", ")}`);
}

function string(value: unknown, path: string, maximum = 2_000): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new Error(`${path} exceeds ${maximum} characters`);
  return normalized;
}

function optionalString(value: unknown, path: string, maximum = 2_000): string | undefined {
  return value === undefined || value === null ? undefined : string(value, path, maximum);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  const normalized = string(value, path, 100);
  if (!allowed.includes(normalized as T)) {
    throw new Error(`${path} is unsupported; expected one of: ${allowed.join(", ")}`);
  }
  return normalized as T;
}

function stringArray(value: unknown, path: string, maximum = 200): string[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error(`${path} must be an array of at most ${maximum}`);
  return value.map((entry, index) => string(entry, `${path}[${index}]`, 500));
}

function relativeMarkdownPath(value: unknown, path: string): string {
  const candidate = string(value, path, 500).replaceAll("\\", "/");
  if (
    candidate.startsWith("/") ||
    candidate.startsWith(".") ||
    candidate.includes("/../") ||
    candidate.startsWith("../") ||
    candidate.includes("\0") ||
    !candidate.endsWith(".md")
  ) {
    throw new Error(`${path} must be a safe relative Markdown path`);
  }
  return candidate.replace(/\/+/g, "/");
}

function parseItem(value: unknown, path: string): ContextPlanItem {
  const input = record(value, path);
  onlyKeys(
    input,
    [
      "id",
      "path",
      "title",
      "purpose",
      "priority",
      "status",
      "scope",
      "questions",
      "requiredEvidence",
      "dependencies",
      "assignedWorker",
      "resolution"
    ],
    path
  );
  const scope = record(input.scope, `${path}.scope`);
  onlyKeys(scope, ["paths", "symbols"], `${path}.scope`);
  const requiredEvidence = stringArray(input.requiredEvidence, `${path}.requiredEvidence`, 6).map((entry, index) =>
    enumValue(
      entry,
      ["code", "tests", "configuration", "documentation", "history", "provider"] as const,
      `${path}.requiredEvidence[${index}]`
    )
  );
  return {
    id: string(input.id, `${path}.id`, 200),
    path: relativeMarkdownPath(input.path, `${path}.path`),
    title: string(input.title, `${path}.title`, 300),
    purpose: string(input.purpose, `${path}.purpose`),
    priority: enumValue(input.priority, ["required", "supporting"] as const, `${path}.priority`),
    status: enumValue(
      input.status,
      ["planned", "in_progress", "complete", "unsupported", "deferred"] as const,
      `${path}.status`
    ),
    scope: {
      paths: stringArray(scope.paths, `${path}.scope.paths`),
      symbols: stringArray(scope.symbols, `${path}.scope.symbols`)
    },
    questions: stringArray(input.questions, `${path}.questions`, 50),
    requiredEvidence,
    dependencies: stringArray(input.dependencies, `${path}.dependencies`, 50),
    ...(optionalString(input.assignedWorker, `${path}.assignedWorker`, 200)
      ? { assignedWorker: optionalString(input.assignedWorker, `${path}.assignedWorker`, 200)! }
      : {}),
    ...(optionalString(input.resolution, `${path}.resolution`)
      ? { resolution: optionalString(input.resolution, `${path}.resolution`)! }
      : {})
  };
}

function parseSubjectSignal(value: unknown, path: string): ContextSubjectSignal {
  const input = record(value, path);
  onlyKeys(input, ["source", "reference", "description"], path);
  return {
    source: enumValue(
      input.source,
      ["code", "tests", "configuration", "documentation", "commit", "pull_request", "issue", "observation"] as const,
      `${path}.source`
    ),
    reference: string(input.reference, `${path}.reference`, 1_000),
    ...(optionalString(input.description, `${path}.description`, 1_000)
      ? { description: optionalString(input.description, `${path}.description`, 1_000)! }
      : {})
  };
}

function parseMaintenanceQuestion(value: unknown, path: string): ContextMaintenanceQuestion {
  const input = record(value, path);
  onlyKeys(input, ["id", "question", "priority", "status", "pageIds", "reason"], path);
  return {
    id: string(input.id, `${path}.id`, 200),
    question: string(input.question, `${path}.question`),
    priority: enumValue(input.priority, ["required", "supporting"] as const, `${path}.priority`),
    status: enumValue(input.status, ["open", "answered", "unsupported", "deferred"] as const, `${path}.status`),
    pageIds: stringArray(input.pageIds, `${path}.pageIds`, 100),
    ...(optionalString(input.reason, `${path}.reason`)
      ? { reason: optionalString(input.reason, `${path}.reason`)! }
      : {})
  };
}

function parseSubject(value: unknown, path: string): ContextSubject {
  const input = record(value, path);
  onlyKeys(input, ["id", "kind", "statement", "priority", "status", "signals", "questions", "pageIds", "reason"], path);
  const signals = list(input.signals, `${path}.signals`, 50, parseSubjectSignal);
  const questions = list(input.questions, `${path}.questions`, 50, parseMaintenanceQuestion);
  if (signals.length === 0) throw new Error(`${path}.signals must not be empty`);
  if (questions.length === 0) throw new Error(`${path}.questions must not be empty`);
  return {
    id: string(input.id, `${path}.id`, 200),
    kind: enumValue(
      input.kind,
      [
        "feature",
        "flow",
        "component",
        "interface",
        "state",
        "security",
        "operations",
        "decision",
        "history",
        "pattern"
      ] as const,
      `${path}.kind`
    ),
    statement: string(input.statement, `${path}.statement`),
    priority: enumValue(input.priority, ["required", "supporting"] as const, `${path}.priority`),
    status: enumValue(
      input.status,
      ["candidate", "researching", "covered", "unsupported", "deferred"] as const,
      `${path}.status`
    ),
    signals,
    questions,
    pageIds: stringArray(input.pageIds, `${path}.pageIds`, 100),
    ...(optionalString(input.reason, `${path}.reason`)
      ? { reason: optionalString(input.reason, `${path}.reason`)! }
      : {})
  };
}

function parseArea(value: unknown, path: string): ContextCoverageArea {
  const input = record(value, path);
  onlyKeys(input, ["id", "status", "pageIds", "reason"], path);
  return {
    id: string(input.id, `${path}.id`, 300),
    status: enumValue(input.status, ["covered", "unsupported", "not_applicable"] as const, `${path}.status`),
    pageIds: stringArray(input.pageIds, `${path}.pageIds`, 100),
    ...(optionalString(input.reason, `${path}.reason`)
      ? { reason: optionalString(input.reason, `${path}.reason`)! }
      : {})
  };
}

function parseWorker(value: unknown, path: string): ContextWorkerState {
  const input = record(value, path);
  onlyKeys(input, ["id", "role", "status", "pageIds", "summary"], path);
  return {
    id: string(input.id, `${path}.id`, 200),
    role: enumValue(input.role, ["research", "critic"] as const, `${path}.role`),
    status: enumValue(input.status, ["planned", "working", "complete", "failed"] as const, `${path}.status`),
    pageIds: stringArray(input.pageIds, `${path}.pageIds`, 100),
    ...(optionalString(input.summary, `${path}.summary`)
      ? { summary: optionalString(input.summary, `${path}.summary`)! }
      : {})
  };
}

function parseReview(value: unknown, path: string): ContextCriticReview {
  const input = record(value, path);
  onlyKeys(input, ["id", "kind", "status", "reviewer", "workerId", "results", "summary"], path);
  return {
    id: string(input.id, `${path}.id`, 200),
    kind: enumValue(input.kind, ["context_only"] as const, `${path}.kind`),
    status: enumValue(input.status, ["planned", "working", "complete", "failed"] as const, `${path}.status`),
    reviewer: enumValue(input.reviewer, ["lead", "subagent"] as const, `${path}.reviewer`),
    ...(optionalString(input.workerId, `${path}.workerId`, 200)
      ? { workerId: optionalString(input.workerId, `${path}.workerId`, 200)! }
      : {}),
    results: list(input.results, `${path}.results`, 500, parseReviewResult),
    ...(optionalString(input.summary, `${path}.summary`)
      ? { summary: optionalString(input.summary, `${path}.summary`)! }
      : {})
  };
}

function parseReviewResult(value: unknown, path: string): ContextCriticResult {
  const input = record(value, path);
  onlyKeys(input, ["questionId", "verdict", "pageIds", "gapIds", "summary"], path);
  return {
    questionId: string(input.questionId, `${path}.questionId`, 200),
    verdict: enumValue(input.verdict, ["pass", "partial", "fail"] as const, `${path}.verdict`),
    pageIds: stringArray(input.pageIds, `${path}.pageIds`, 100),
    gapIds: stringArray(input.gapIds, `${path}.gapIds`, 100),
    summary: string(input.summary, `${path}.summary`)
  };
}

function parseGap(value: unknown, path: string): ContextCoverageGap {
  const input = record(value, path);
  onlyKeys(input, ["id", "severity", "description", "status", "pageId", "resolution"], path);
  return {
    id: string(input.id, `${path}.id`, 200),
    severity: enumValue(input.severity, ["blocking", "advisory"] as const, `${path}.severity`),
    description: string(input.description, `${path}.description`),
    status: enumValue(input.status, ["open", "resolved", "unsupported"] as const, `${path}.status`),
    ...(optionalString(input.pageId, `${path}.pageId`, 200)
      ? { pageId: optionalString(input.pageId, `${path}.pageId`, 200)! }
      : {}),
    ...(optionalString(input.resolution, `${path}.resolution`)
      ? { resolution: optionalString(input.resolution, `${path}.resolution`)! }
      : {})
  };
}

function list<T>(value: unknown, path: string, maximum: number, parse: (entry: unknown, path: string) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${path} must contain at most ${maximum} items`);
  return value.map((entry, index) => parse(entry, `${path}[${index}]`));
}

export function parseContextOrchestrationState(
  value: unknown,
  expected?: { readonly repository: string; readonly ref: string; readonly commitSha: string }
): ContextOrchestrationState {
  const input = record(value, "orchestration");
  onlyKeys(
    input,
    [
      "version",
      "repository",
      "ref",
      "commitSha",
      "mode",
      "phase",
      "subjects",
      "items",
      "areas",
      "workers",
      "reviews",
      "gaps",
      "completionReason"
    ],
    "orchestration"
  );
  if (input.version !== CONTEXT_ORCHESTRATION_VERSION) {
    throw new Error(`orchestration.version must be ${CONTEXT_ORCHESTRATION_VERSION}`);
  }
  const state: ContextOrchestrationState = {
    version: CONTEXT_ORCHESTRATION_VERSION,
    repository: string(input.repository, "orchestration.repository", 300).toLowerCase(),
    ref: string(input.ref, "orchestration.ref", 500),
    commitSha: string(input.commitSha, "orchestration.commitSha", 64).toLowerCase(),
    mode: enumValue(input.mode, ["initial", "incremental"] as const, "orchestration.mode"),
    phase: enumValue(
      input.phase,
      ["planning", "researching", "reviewing", "complete", "partial"] as const,
      "orchestration.phase"
    ),
    subjects: list(input.subjects, "orchestration.subjects", 300, parseSubject),
    items: list(input.items, "orchestration.items", 100, parseItem),
    areas: list(input.areas, "orchestration.areas", 200, parseArea),
    workers: list(input.workers, "orchestration.workers", 20, parseWorker),
    reviews: list(input.reviews, "orchestration.reviews", 20, parseReview),
    gaps: list(input.gaps, "orchestration.gaps", 100, parseGap),
    ...(optionalString(input.completionReason, "orchestration.completionReason")
      ? { completionReason: optionalString(input.completionReason, "orchestration.completionReason")! }
      : {})
  };
  if (
    expected &&
    (state.repository !== expected.repository.toLowerCase() ||
      state.ref !== expected.ref ||
      state.commitSha !== expected.commitSha.toLowerCase())
  ) {
    throw new Error("orchestration identity does not match the evidence checkpoint");
  }
  return state;
}

const ignoredAreaSegments = new Set(["node_modules", "dist", "coverage", "vendor", "build", "target"]);
const workspaceRoots = new Set(["apps", "packages", "services"]);

/**
 * Deterministic areas the plan must account for.
 *
 * A page may cover several areas, but an agent cannot silently forget an entire
 * application, package, service, or top-level repository area and still call
 * the build complete.
 */
export function repositoryContextAreas(manifest: readonly Pick<RefManifestEntry, "path">[]): string[] {
  const areas = new Set<string>();
  let hasRootFiles = false;
  for (const entry of manifest) {
    const segments = entry.path.split("/").filter(Boolean);
    if (segments.length === 0 || segments.some((segment) => ignoredAreaSegments.has(segment))) continue;
    if (segments.length === 1) {
      hasRootFiles = true;
      continue;
    }
    if (segments[0]!.startsWith(".")) continue;
    areas.add(segments[0]!);
    if (workspaceRoots.has(segments[0]!) && segments.length >= 3 && !segments[1]!.startsWith(".")) {
      areas.add(`${segments[0]}/${segments[1]}`);
    }
  }
  if (hasRootFiles) areas.add("root");
  return [...areas].sort();
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

const currentSubjectSignalSources = new Set<ContextSubjectSignalSource>([
  "code",
  "tests",
  "configuration",
  "documentation"
]);

function normalizedSubjectReference(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, "");
}

export function contextOrchestrationDiagnostics(input: {
  readonly state: ContextOrchestrationState;
  readonly documentPaths: readonly string[];
  readonly manifest: readonly Pick<RefManifestEntry, "path">[];
  readonly evidenceByDocumentPath?: Readonly<Record<string, readonly ContextPlanItem["requiredEvidence"][number][]>>;
  readonly sourcePathsByDocumentPath?: Readonly<Record<string, readonly string[]>>;
  readonly availableEvidence?: readonly ContextPlanItem["requiredEvidence"][number][];
  readonly availableSubjectSignals?: readonly Pick<ContextSubjectSignal, "source" | "reference">[];
}): string[] {
  const { state } = input;
  const diagnostics: string[] = [];
  const itemIds = state.items.map((item) => item.id);
  const itemPaths = state.items.map((item) => item.path);
  const subjectIds = state.subjects.map((subject) => subject.id);
  const questionIds = state.subjects.flatMap((subject) => subject.questions.map((question) => question.id));
  const areaIds = state.areas.map((area) => area.id);
  const workerIds = state.workers.map((worker) => worker.id);
  const reviewIds = state.reviews.map((review) => review.id);
  const gapIds = state.gaps.map((gap) => gap.id);
  for (const [label, duplicates] of [
    ["item ids", duplicateValues(itemIds)],
    ["item paths", duplicateValues(itemPaths)],
    ["subject ids", duplicateValues(subjectIds)],
    ["maintenance question ids", duplicateValues(questionIds)],
    ["area ids", duplicateValues(areaIds)],
    ["worker ids", duplicateValues(workerIds)],
    ["critic review ids", duplicateValues(reviewIds)],
    ["gap ids", duplicateValues(gapIds)]
  ] as const) {
    if (duplicates.length > 0) diagnostics.push(`orchestration has duplicate ${label}: ${duplicates.join(", ")}`);
  }

  const itemById = new Map(state.items.map((item) => [item.id, item]));
  const manifestPaths = new Set(input.manifest.map((entry) => entry.path));
  const availableSubjectSignals = new Set(
    (input.availableSubjectSignals ?? []).map(
      (signal) => `${signal.source}\0${normalizedSubjectReference(signal.reference)}`
    )
  );
  const coveredPageIds = new Set<string>();
  for (const subject of state.subjects) {
    if (subject.status === "covered") {
      if (subject.pageIds.length === 0) diagnostics.push(`covered subject ${subject.id} names no context pages`);
      for (const pageId of subject.pageIds) {
        coveredPageIds.add(pageId);
        const item = itemById.get(pageId);
        if (!item) diagnostics.push(`covered subject ${subject.id} names unknown page ${pageId}`);
        else if (state.phase === "complete" && item.status !== "complete") {
          diagnostics.push(`covered subject ${subject.id} depends on unfinished page ${pageId}`);
        }
      }
    } else if ((subject.status === "unsupported" || subject.status === "deferred") && !subject.reason) {
      diagnostics.push(`${subject.status} subject ${subject.id} has no reason`);
    }
    for (const signal of subject.signals) {
      if (currentSubjectSignalSources.has(signal.source)) {
        if (!manifestPaths.has(signal.reference)) {
          diagnostics.push(`subject ${subject.id} names unknown ${signal.source} signal ${signal.reference}`);
        }
      } else if (
        input.availableSubjectSignals &&
        !availableSubjectSignals.has(`${signal.source}\0${normalizedSubjectReference(signal.reference)}`)
      ) {
        diagnostics.push(`subject ${subject.id} names unavailable ${signal.source} signal ${signal.reference}`);
      }
    }
    for (const question of subject.questions) {
      if (question.status === "answered") {
        if (question.pageIds.length === 0) {
          diagnostics.push(`answered maintenance question ${question.id} names no context pages`);
        }
        for (const pageId of question.pageIds) {
          const item = itemById.get(pageId);
          if (!item) diagnostics.push(`maintenance question ${question.id} names unknown page ${pageId}`);
          else if (!subject.pageIds.includes(pageId)) {
            diagnostics.push(`maintenance question ${question.id} names page ${pageId} outside subject ${subject.id}`);
          } else if (!item.questions.includes(question.id)) {
            diagnostics.push(`maintenance question ${question.id} is not mapped back from page ${pageId}`);
          } else if (state.phase === "complete" && item.status !== "complete") {
            diagnostics.push(`answered maintenance question ${question.id} depends on unfinished page ${pageId}`);
          }
        }
      } else if ((question.status === "unsupported" || question.status === "deferred") && !question.reason) {
        diagnostics.push(`${question.status} maintenance question ${question.id} has no reason`);
      }
      if (state.phase === "complete" && question.priority === "required" && question.status !== "answered") {
        diagnostics.push(`required maintenance question ${question.id} is ${question.status}`);
      }
    }
  }
  if (state.phase === "complete" && input.availableSubjectSignals) {
    const capturedHistory = input.availableSubjectSignals.filter(
      (signal) => !currentSubjectSignalSources.has(signal.source)
    );
    const accountedHistory = state.subjects.some((subject) =>
      subject.signals.some(
        (signal) =>
          !currentSubjectSignalSources.has(signal.source) &&
          availableSubjectSignals.has(`${signal.source}\0${normalizedSubjectReference(signal.reference)}`)
      )
    );
    if (capturedHistory.length > 0 && !accountedHistory) {
      diagnostics.push(
        "complete orchestration does not account for captured Git/provider history with a valid subject signal"
      );
    }
  }
  const workerById = new Map(state.workers.map((worker) => [worker.id, worker]));
  const questionById = new Map(
    state.subjects.flatMap((subject) => subject.questions.map((question) => [question.id, question] as const))
  );
  const gapById = new Map(state.gaps.map((gap) => [gap.id, gap]));
  const documentPaths = new Set(input.documentPaths);
  for (const item of state.items) {
    for (const questionId of item.questions) {
      const question = questionById.get(questionId);
      if (!question) {
        diagnostics.push(`orchestration item ${item.id} names unknown maintenance question ${questionId}`);
      } else if (!question.pageIds.includes(item.id)) {
        diagnostics.push(`orchestration item ${item.id} question ${questionId} does not map back to the page`);
      }
    }
    for (const dependency of item.dependencies) {
      if (!itemById.has(dependency))
        diagnostics.push(`orchestration item ${item.id} has unknown dependency ${dependency}`);
    }
    if (item.status === "complete" && !documentPaths.has(item.path)) {
      diagnostics.push(`orchestration item ${item.id} is complete but ${item.path} was not published`);
    }
    if ((item.status === "unsupported" || item.status === "deferred") && !item.resolution) {
      diagnostics.push(`orchestration item ${item.id} is ${item.status} without a resolution`);
    }
    if (item.assignedWorker && !workerById.has(item.assignedWorker)) {
      diagnostics.push(`orchestration item ${item.id} names unknown worker ${item.assignedWorker}`);
    }
    if (state.phase === "complete" && item.status === "complete" && !coveredPageIds.has(item.id)) {
      diagnostics.push(`complete orchestration item ${item.id} is not mapped from a covered subject`);
    }
    if (state.phase === "complete" && item.status === "complete" && input.evidenceByDocumentPath) {
      const used = new Set(input.evidenceByDocumentPath[item.path] ?? []);
      const available = new Set(input.availableEvidence ?? []);
      for (const requirement of item.requiredEvidence) {
        if (available.has(requirement) && !used.has(requirement)) {
          diagnostics.push(`orchestration item ${item.id} is missing required ${requirement} evidence`);
        }
      }
    }
  }

  for (const worker of state.workers) {
    for (const pageId of worker.pageIds) {
      const item = itemById.get(pageId);
      if (!item) diagnostics.push(`orchestration worker ${worker.id} names unknown page ${pageId}`);
      else if (item.assignedWorker && item.assignedWorker !== worker.id) {
        diagnostics.push(`orchestration worker ${worker.id} claims page ${pageId} assigned to ${item.assignedWorker}`);
      }
    }
  }

  const completedReviews = state.reviews.filter((review) => review.status === "complete");
  const latestCompletedResultByQuestion = new Map<string, ContextCriticResult>();
  for (const review of completedReviews) {
    for (const result of review.results) latestCompletedResultByQuestion.set(result.questionId, result);
  }
  for (const review of state.reviews) {
    if (review.reviewer === "subagent") {
      if (!review.workerId) {
        diagnostics.push(`subagent critic review ${review.id} names no worker`);
      } else {
        const worker = workerById.get(review.workerId);
        if (!worker) diagnostics.push(`critic review ${review.id} names unknown worker ${review.workerId}`);
        else if (worker.role !== "critic") {
          diagnostics.push(`critic review ${review.id} names non-critic worker ${review.workerId}`);
        } else if (review.status === "complete" && worker.status !== "complete") {
          diagnostics.push(`complete critic review ${review.id} depends on ${worker.status} worker ${review.workerId}`);
        }
      }
    } else if (review.workerId) {
      diagnostics.push(`lead critic review ${review.id} must not name a worker`);
    }
    const reviewQuestionIds = review.results.map((result) => result.questionId);
    const duplicateReviewQuestions = duplicateValues(reviewQuestionIds);
    if (duplicateReviewQuestions.length > 0) {
      diagnostics.push(
        `critic review ${review.id} has duplicate maintenance question results: ${duplicateReviewQuestions.join(", ")}`
      );
    }
    for (const result of review.results) {
      const question = questionById.get(result.questionId);
      if (!question) {
        diagnostics.push(`critic review ${review.id} names unknown maintenance question ${result.questionId}`);
      }
      if (result.pageIds.length === 0) {
        diagnostics.push(`critic review ${review.id} result ${result.questionId} used no context pages`);
      }
      for (const pageId of result.pageIds) {
        if (!itemById.has(pageId)) {
          diagnostics.push(`critic review ${review.id} result ${result.questionId} names unknown page ${pageId}`);
        } else if (question && !question.pageIds.includes(pageId)) {
          diagnostics.push(
            `critic review ${review.id} result ${result.questionId} used page ${pageId} outside the question answer`
          );
        }
      }
      for (const gapId of result.gapIds) {
        if (!gapById.has(gapId)) {
          diagnostics.push(`critic review ${review.id} result ${result.questionId} names unknown gap ${gapId}`);
        }
      }
      if (result.verdict !== "pass" && result.gapIds.length === 0) {
        diagnostics.push(
          `critic review ${review.id} ${result.verdict} result ${result.questionId} names no coverage gap`
        );
      }
    }
    if (review.status === "complete") {
      if (review.results.length === 0) {
        diagnostics.push(`complete critic review ${review.id} tested no maintenance questions`);
      }
      if (!review.summary) diagnostics.push(`complete critic review ${review.id} has no summary`);
    }
  }

  const expectedAreas = repositoryContextAreas(input.manifest);
  const areas = new Map(state.areas.map((area) => [area.id, area]));
  const maintainedSourceExtension =
    /\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|kt|kts|mjs|cjs|php|py|rb|rs|scala|sh|swift|ts|tsx)$/i;
  const pathBelongsToArea = (path: string, areaId: string): boolean =>
    areaId === "root" ? !path.includes("/") : path === areaId || path.startsWith(`${areaId}/`);
  const sourceBearingAreas = new Set(
    expectedAreas.filter((areaId) =>
      input.manifest.some(
        (entry) => pathBelongsToArea(entry.path, areaId) && maintainedSourceExtension.test(entry.path)
      )
    )
  );
  for (const expected of expectedAreas) {
    if (!areas.has(expected)) diagnostics.push(`orchestration does not account for repository area ${expected}`);
  }
  for (const area of state.areas) {
    if (area.status === "covered") {
      if (area.pageIds.length === 0) diagnostics.push(`covered area ${area.id} names no context pages`);
      for (const pageId of area.pageIds) {
        const item = itemById.get(pageId);
        if (!item) diagnostics.push(`covered area ${area.id} names unknown page ${pageId}`);
        else if (state.phase === "complete" && item.status !== "complete") {
          diagnostics.push(`covered area ${area.id} depends on unfinished page ${pageId}`);
        }
      }
      if (input.sourcePathsByDocumentPath) {
        const citedPaths = area.pageIds.flatMap((pageId) => {
          const item = itemById.get(pageId);
          return item ? (input.sourcePathsByDocumentPath?.[item.path] ?? []) : [];
        });
        if (!citedPaths.some((path) => pathBelongsToArea(path, area.id))) {
          diagnostics.push(`covered repository area ${area.id} has no citation from that area`);
        }
      }
    } else if (!area.reason) {
      diagnostics.push(`${area.status} area ${area.id} has no reason`);
    }
    if (state.phase === "complete" && sourceBearingAreas.has(area.id) && area.status !== "covered") {
      diagnostics.push(`source-bearing repository area ${area.id} is not covered`);
    }
  }

  if (state.mode === "initial") {
    const architecture = state.items.find((item) => item.path === "architecture.md");
    if (!architecture || architecture.priority !== "required") {
      diagnostics.push("initial orchestration requires a required architecture.md plan item");
    }
    for (const documentPath of documentPaths) {
      if (!itemPaths.includes(documentPath))
        diagnostics.push(`initial context document ${documentPath} is absent from the plan`);
    }
  }

  if (state.phase === "complete") {
    const nonTrivialRepository =
      sourceBearingAreas.size > 1 || state.items.filter((item) => item.status === "complete").length > 1;
    if (state.subjects.length === 0) diagnostics.push("complete orchestration has no subjects");
    if (completedReviews.length === 0)
      diagnostics.push("complete orchestration has no completed context-only critic review");
    if (
      nonTrivialRepository &&
      !state.workers.some((worker) => worker.role === "research" && worker.status === "complete")
    ) {
      diagnostics.push("complete non-trivial orchestration has no completed independent research worker");
    }
    if (nonTrivialRepository && !completedReviews.some((review) => review.reviewer === "subagent" && review.workerId)) {
      diagnostics.push("complete non-trivial orchestration has no completed independent subagent critic review");
    }
    for (const subject of state.subjects) {
      if (subject.status === "candidate" || subject.status === "researching") {
        diagnostics.push(`orchestration subject ${subject.id} is still ${subject.status}`);
      }
      if (subject.priority === "required" && subject.status !== "covered") {
        diagnostics.push(`required orchestration subject ${subject.id} is ${subject.status}`);
      }
      for (const question of subject.questions) {
        const result = latestCompletedResultByQuestion.get(question.id);
        if (question.priority === "required" && question.status === "answered" && !result) {
          diagnostics.push(`required maintenance question ${question.id} was not tested by a completed critic review`);
        } else if (question.priority === "required" && question.status === "answered" && result?.verdict !== "pass") {
          diagnostics.push(
            `required maintenance question ${question.id} last critic verdict is ${result?.verdict ?? "missing"}`
          );
        }
      }
    }
    for (const item of state.items) {
      if (item.priority === "required" && item.status !== "complete") {
        diagnostics.push(`required orchestration item ${item.id} is ${item.status}`);
      }
      if (
        item.status === "complete" &&
        ![...latestCompletedResultByQuestion.values()].some(
          (result) => result.verdict === "pass" && result.pageIds.includes(item.id)
        )
      ) {
        diagnostics.push(`complete orchestration item ${item.id} was not used by a passing context-only critic task`);
      }
    }
    for (const worker of state.workers) {
      if (worker.status === "planned" || worker.status === "working") {
        diagnostics.push(`orchestration worker ${worker.id} is still ${worker.status}`);
      }
    }
    for (const gap of state.gaps) {
      if (gap.severity === "blocking" && gap.status === "open") {
        diagnostics.push(`orchestration has open blocking gap ${gap.id}`);
      }
    }
    if (!state.completionReason) diagnostics.push("complete orchestration has no completion reason");
  }
  return diagnostics;
}
