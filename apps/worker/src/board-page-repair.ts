import { posix } from "node:path";
import { contextPublicSnapshot, normalizeMarkdownEvidenceTargets, type ContextPublicPage } from "@jina/context-engine";
import {
  renderedMarkdownCitationContract,
  type CitationAuditReference,
  type DocumentationPagePlan
} from "@jina/daytona";

export interface PageRepairCheckpointDiagnostics {
  readonly version: 1;
  readonly consecutiveNoProgressPasses: number;
  readonly attemptedBodyDigest: string;
  readonly regressionProblems: readonly string[];
}

export interface PageRepairPromptState {
  /**
   * Omitted when the page has only a structural audit. An empty array means a
   * semantic audit ran but did not prove any of the current bindings.
   */
  readonly supportedCitationIds?: readonly string[];
  readonly priorCheckpoint?: PageRepairCheckpointDiagnostics;
  readonly operatorRemediationPass?: number;
}

/**
 * Canonicalizes the only public source-link form before a checkpoint page is
 * audited, retained, compared, or rendered into a release snapshot.
 */
export function canonicalPublicPageMarkdown(bodyMarkdown: string): string {
  return normalizeMarkdownEvidenceTargets(bodyMarkdown);
}

export function contextBoardPublicSnapshot(pages: readonly ContextPublicPage[]): string {
  const canonicalPages = pages.map((page) => ({
    ...page,
    bodyMarkdown: canonicalPublicPageMarkdown(page.bodyMarkdown)
  }));
  for (const page of canonicalPages) {
    const aliasProblems = publicPageCheckoutAliasProblems(page.bodyMarkdown);
    if (aliasProblems.length > 0) {
      throw new Error(`${page.documentPath} cannot enter public Context: ${aliasProblems.join("; ")}`);
    }
  }
  return contextPublicSnapshot(canonicalPages);
}

export function pageRepairCoveragePrompt(
  page: DocumentationPagePlan,
  allPages: readonly DocumentationPagePlan[],
  state: PageRepairPromptState = {}
): string {
  const plannedPaths = allPages.map((candidate) => candidate.path);
  const dependencyPaths = page.dependencies.map((dependencyId) => {
    const dependency = allPages.find((candidate) => candidate.id === dependencyId);
    if (!dependency) throw new Error(`page repair cannot resolve planned dependency ${dependencyId}`);
    return dependency.path;
  });
  const supportedCitationIds = state.supportedCitationIds ?? [];
  const fullPageRewrite = (state.priorCheckpoint?.consecutiveNoProgressPasses ?? 0) > 0;
  return [
    "The publication plan remains a binding quality contract during repair. Do not satisfy citation validation by deleting planned maintenance coverage, required mechanics, useful diagrams, or context navigation.",
    state.operatorRemediationPass
      ? [
          `OPERATOR REMEDIATION PASS ${state.operatorRemediationPass}: the ordinary bounded repair loop is closed.`,
          "Resolve only the exact remaining host findings. Preserve every unrelated supported binding verbatim. For each rejected core claim, choose one decisive outcome: narrow its linked words to what the excerpt entails, replace it with a stronger exact source range, combine precise citations when one range cannot establish the full clause, or remove the unsupported factual clause while preserving the planned subject as grounded prose or an explicit maintenance question.",
          "Do not repeat a prior edit or perform a broad stylistic rewrite."
        ].join("\n\n")
      : "",
    fullPageRewrite
      ? [
          "CONVERGENCE ESCALATION: the preceding repair made no acceptable progress and the host retained the last good checkpoint.",
          "Rewrite the complete page as structurally clean engineering documentation instead of repeating another local find-and-replace edit. Recompose its core mechanics and high-impact assertions around precise evidence while preserving useful connective explanation, planned headings, navigation, diagram, and supported content. The bounded host limit still applies.",
          `Prior no-progress diagnostics:\n${JSON.stringify(state.priorCheckpoint, null, 2)}`
        ].join("\n\n")
      : "Use a focused repair for this pass. If the rejected structure cannot be corrected locally without weakening the page, rewrite the affected section coherently.",
    state.supportedCitationIds === undefined
      ? "This checkpoint has structural findings only; no semantic citation audit exists. Do not assume that every unaudited prior binding is proven-supported. You may replace or remove an unaudited binding when doing so reduces the exact structural findings without introducing a new invalid binding."
      : supportedCitationIds.length > 0
        ? [
            "The independent semantic auditor already proved the following citation IDs. Preserve the Markdown evidence link behind every listed ID verbatim—including its visible linked words, target, and occurrence—unless the host finding explicitly rejects that same binding.",
            "Do not recreate or reword a proven link: citation IDs are host-derived, so copying the complete existing Markdown link verbatim is the reliable way to preserve the proven-supported ID.",
            `Proven-supported citation IDs:\n${JSON.stringify(supportedCitationIds, null, 2)}`
          ].join("\n\n")
        : "A semantic audit ran, but it did not prove any current citation binding. Do not describe an unaudited or unsupported binding as proven.",
    `Repaired page specification:\n${JSON.stringify(page, null, 2)}`,
    "Keep every requiredTopics and maintenanceQuestions concept recognizable in the repaired prose. The host compares inflection-normalized plan vocabulary already present in the checkpoint and rejects a repair that drops most of a topic or question signal.",
    "The host also rejects material hollowing: never return fewer than 400 characters; if 40 or more substantive words would be removed, retain at least 60% of the checkpoint's substantive words; and when a checkpoint has four or more H2-H6 sections, retain at least half of those sections. Reorganizing, renaming, and evidence-driven rewriting remain allowed within those scope floors.",
    dependencyPaths.length > 0
      ? `Preserve ordinary Markdown navigation to these planned dependencies: ${dependencyPaths.join(", ")}.`
      : "This page has no declared dependency links.",
    page.path === "architecture.md"
      ? `architecture.md is the public navigation root. Keep a pure-navigation section with ordinary relative Markdown links that makes every planned page reachable. Planned paths: ${plannedPaths.join(", ")}.`
      : "Keep relevant cross-page links as pure navigation statements or list items so they are not mistaken for unsupported implementation claims.",
    page.diagram === "none"
      ? "No diagram is required by this page specification."
      : `The planned ${page.diagram} Mermaid diagram is required when it still clarifies the specified relationship; ground its factual meaning in nearby cited prose.`,
    renderedMarkdownCitationContract(),
    "Migrate conventional trailing source markers into assertion links. For example, rewrite `The worker fences completion. [source](src/worker.ts#L40-L55)` as `[The worker fences completion](src/worker.ts#L40-L55).` when that excerpt supports the whole assertion, or link only the exact supported clause. Renaming or moving a trailing `source` marker does not cite the preceding sentence.",
    "Use tables only when they clarify a real relationship. Cite consequential row facts when their truth affects a maintenance decision, but leave purely descriptive headers and row labels readable instead of attaching decorative evidence to every cell.",
    "Do not invent future features, proposed checklists, or generic recommendations merely to fill space. Keep maintenance guidance only when it is useful for this repository and its factual premises are grounded by nearby rendered evidence links.",
    "When the binding plan requests a future checklist, unresolved ownership, or another maintenance concern that the checkpoint cannot establish as fact, preserve the maintenance intent as an explicit question rather than an uncited recommendation. Questions are allowed; assertions about what an owner must do, what a future API must guarantee, or what remains unresolved still require evidence.",
    "Split factual premises from pure maintenance questions. Write `[The retry budget is read from this setting](src/config.ts#L10-L18). What should change when a new retry class is added?` rather than leaving the factual premise uncited inside a question or turning the question itself into a source claim. A question may remain uncited only when every factual premise before it is independently cited.",
    "Remove uncited meta narration such as a sentence announcing that a following diagram restates earlier prose. The cited prose and diagram can stand on their own.",
    "Before finishing, reread every exact structural problem in the audit input. Each named ungrounded summary or section must gain a precise link inside a consequential assertion, become purely navigational/interrogative, or be removed when no supported material remains.",
    "For each rejected factual assertion, prefer rewriting the factual clause so the exact supported words are inside a precise source link. Remove a claim only when the checkpoint repository cannot support it, and replace it with supported coverage when the publication specification still requires that subject."
  ].join("\n\n");
}

/**
 * Deterministically rejects a page repair that makes its checkpoint worse.
 *
 * Structural diagnostics and plan coverage are compared independently so a
 * repair cannot trade a missing diagram or valid source binding for a lower
 * count elsewhere. References already accepted by the independent auditor are
 * protected by their immutable source binding, not by claim text or citation
 * identity, which allows a supported assertion to be reworded without allowing
 * its evidence to disappear.
 */
export function pageRepairRegressionProblems(input: {
  readonly priorReferences: readonly CitationAuditReference[];
  readonly priorStructuralProblems: readonly string[];
  readonly priorPlanStructuralProblems: readonly string[];
  readonly priorSupportedCitationIds?: readonly string[];
  readonly candidateReferences: readonly CitationAuditReference[];
  readonly candidateStructuralProblems: readonly string[];
  readonly candidatePlanStructuralProblems: readonly string[];
}): readonly string[] {
  const problems: string[] = [];
  if (input.candidateStructuralProblems.length > input.priorStructuralProblems.length) {
    problems.push(
      `structural audit problems increased from ${input.priorStructuralProblems.length} to ${input.candidateStructuralProblems.length}`
    );
  }

  const priorSourceBindingProblems = new Set(input.priorStructuralProblems.filter(isSourceBindingProblem));
  for (const problem of input.candidateStructuralProblems.filter(isSourceBindingProblem)) {
    if (!priorSourceBindingProblems.has(problem)) {
      problems.push(`repair introduced an invalid or unavailable source binding: ${problem}`);
    }
  }

  const priorPlanProblems = new Set(input.priorPlanStructuralProblems);
  for (const problem of input.candidatePlanStructuralProblems) {
    if (!priorPlanProblems.has(problem)) {
      problems.push(`repair dropped required publication-plan coverage: ${problem}`);
    }
  }

  const protectedIds =
    input.priorSupportedCitationIds === undefined ? new Set<string>() : new Set(input.priorSupportedCitationIds);
  const protectedReferences = input.priorReferences.filter((reference) => protectedIds.has(reference.citationId));
  const remainingCandidateBindings = referenceBindingCounts(input.candidateReferences);
  let lostReferences = 0;
  for (const reference of protectedReferences) {
    const binding = referenceBinding(reference);
    const remaining = remainingCandidateBindings.get(binding) ?? 0;
    if (remaining === 0) {
      lostReferences += 1;
      continue;
    }
    remainingCandidateBindings.set(binding, remaining - 1);
  }
  if (lostReferences > 0) {
    problems.push(`repair lost ${lostReferences} previously valid source-bound citation reference(s)`);
  }
  return problems;
}

/**
 * Prevents an evidence repair from succeeding by quietly deleting the page it
 * was asked to repair.
 *
 * The publication plan is semantic input, so this guard deliberately compares
 * plan vocabulary already present in the accepted checkpoint instead of
 * requiring writers to copy plan strings verbatim. Inflection-normalized
 * vocabulary permits ordinary rewriting while making loss of a planned topic
 * or maintenance question deterministic and auditable. Broader semantic
 * adequacy remains the responsibility of the independent context critic.
 */
export function pageRepairScopeRegressionProblems(input: {
  readonly page: DocumentationPagePlan;
  readonly priorBodyMarkdown: string;
  readonly candidateBodyMarkdown: string;
}): readonly string[] {
  const problems: string[] = [];
  const priorBodyTerms = scopeTermSet(input.priorBodyMarkdown);
  const candidateBodyTerms = scopeTermSet(input.candidateBodyMarkdown);

  for (const [kind, values] of [
    ["required topic", input.page.requiredTopics],
    ["maintenance question", input.page.maintenanceQuestions]
  ] as const) {
    for (const value of values) {
      const planTerms = scopeTerms(value);
      const priorMatches = planTerms.filter((term) => priorBodyTerms.has(term));
      if (priorMatches.length === 0) continue;
      const candidateMatchCount = priorMatches.filter((term) => candidateBodyTerms.has(term)).length;
      const minimumMatchCount = Math.max(1, Math.ceil(priorMatches.length * 0.6));
      if (candidateMatchCount < minimumMatchCount) {
        const missingTerms = priorMatches.filter((term) => !candidateBodyTerms.has(term));
        problems.push(
          `repair dropped planned ${kind} coverage for ${JSON.stringify(value)}: retained ${candidateMatchCount}/${priorMatches.length} checkpoint term(s); missing ${missingTerms.join(", ")}`
        );
      }
    }
  }

  const priorSubstantiveWords = substantiveWordCount(input.priorBodyMarkdown);
  const candidateSubstantiveWords = substantiveWordCount(input.candidateBodyMarkdown);
  const minimumSubstantiveWords = Math.ceil(priorSubstantiveWords * 0.6);
  if (priorSubstantiveWords - candidateSubstantiveWords >= 40 && candidateSubstantiveWords < minimumSubstantiveWords) {
    problems.push(
      `repair materially hollowed the page from ${priorSubstantiveWords} to ${candidateSubstantiveWords} substantive word(s); at least ${minimumSubstantiveWords} are required`
    );
  }

  const priorSectionCount = markdownSectionCount(input.priorBodyMarkdown);
  const candidateSectionCount = markdownSectionCount(input.candidateBodyMarkdown);
  if (priorSectionCount >= 4 && candidateSectionCount < Math.ceil(priorSectionCount / 2)) {
    problems.push(
      `repair collapsed the page from ${priorSectionCount} to ${candidateSectionCount} substantive section(s)`
    );
  }

  if (input.candidateBodyMarkdown.trim().length < 400) {
    problems.push(`repair returned a shallow page shorter than 400 characters`);
  }
  return problems;
}

/**
 * Identifies a repair attempt that cannot advance a structural-only checkpoint.
 *
 * Semantic repairs may legitimately leave the deterministic structural set
 * unchanged while correcting entailment, so only byte identity is universal.
 * Without a semantic audit, an unchanged structural problem multiset is also a
 * deterministic no-progress result and should retain the prior checkpoint.
 */
export function pageRepairNoProgressProblems(input: {
  readonly priorBodyMarkdown: string;
  readonly candidateBodyMarkdown: string;
  readonly priorStructuralProblems: readonly string[];
  readonly candidateStructuralProblems: readonly string[];
  readonly semanticAuditPresent: boolean;
}): readonly string[] {
  if (input.candidateBodyMarkdown === input.priorBodyMarkdown) {
    return ["repair produced a byte-identical page"];
  }
  if (input.candidateBodyMarkdown.trimEnd() === input.priorBodyMarkdown.trimEnd()) {
    return ["repair changed only trailing whitespace"];
  }
  if (
    !input.semanticAuditPresent &&
    sameStringMultiset(input.candidateStructuralProblems, input.priorStructuralProblems)
  ) {
    return ["structural-only repair left the complete structural problem set unchanged"];
  }
  return [];
}

export function nextPageRepairCheckpointDiagnostics(input: {
  readonly priorCheckpoint?: PageRepairCheckpointDiagnostics;
  readonly attemptedBodyDigest: string;
  readonly regressionProblems: readonly string[];
}): PageRepairCheckpointDiagnostics {
  if (input.regressionProblems.length === 0) {
    throw new Error("page repair checkpoint diagnostics require a no-progress or regression problem");
  }
  return {
    version: 1,
    consecutiveNoProgressPasses: (input.priorCheckpoint?.consecutiveNoProgressPasses ?? 0) + 1,
    attemptedBodyDigest: input.attemptedBodyDigest,
    regressionProblems: input.regressionProblems.slice(0, 32).map((problem) => problem.slice(0, 500))
  };
}

export function retainedPageRepairCheckpoint<T>(input: {
  readonly regressionProblems: readonly string[];
  readonly retainedArtifact: T;
  readonly priorPublicSnapshotDigest: string;
}):
  | {
      readonly version: 1;
      readonly outputArtifact: T;
      readonly publicSnapshotDigest: string;
    }
  | undefined {
  if (input.regressionProblems.length === 0) return undefined;
  return {
    version: 1,
    outputArtifact: input.retainedArtifact,
    publicSnapshotDigest: input.priorPublicSnapshotDigest
  };
}

export function pagePlanStructuralProblems(
  page: DocumentationPagePlan,
  allPages: readonly DocumentationPagePlan[],
  bodyMarkdown: string
): readonly string[] {
  const problems: string[] = [];
  const targets = markdownLinkTargets(bodyMarkdown);
  const plannedPaths = new Set(allPages.map((candidate) => candidate.path));
  if (page.diagram !== "none" && !/^```mermaid[ \t]*$/m.test(bodyMarkdown)) {
    problems.push(`${page.path} is missing its planned ${page.diagram} Mermaid diagram`);
  }

  const requiredPaths =
    page.path === "architecture.md"
      ? allPages.filter((candidate) => candidate.path !== page.path).map((candidate) => candidate.path)
      : page.dependencies.map((dependencyId) => {
          const dependency = allPages.find((candidate) => candidate.id === dependencyId);
          if (!dependency) throw new Error(`page audit cannot resolve planned dependency ${dependencyId}`);
          return dependency.path;
        });
  for (const requiredPath of requiredPaths) {
    const relativeTarget = posix.relative(posix.dirname(page.path), requiredPath);
    if (!targets.has(relativeTarget) && !targets.has(`./${relativeTarget}`)) {
      problems.push(`${page.path} is missing planned context navigation to ${requiredPath}`);
    }
  }
  const brokenTargets = new Set<string>();
  for (const target of markdownLinkDestinations(bodyMarkdown)) {
    const [path, anchor = ""] = target.split("#", 2);
    if (
      !path ||
      !/\.md$/i.test(path) ||
      /^L\d+(?:-L\d+)?$/i.test(anchor) ||
      /^[a-z][a-z0-9+.-]*:/i.test(path) ||
      path.startsWith("/")
    ) {
      continue;
    }
    const resolved = posix.normalize(posix.join(posix.dirname(page.path), path));
    if (resolved === ".." || resolved.startsWith("../") || !plannedPaths.has(resolved)) {
      brokenTargets.add(target);
    }
  }
  for (const target of brokenTargets) {
    problems.push(`${page.path} has broken context navigation to ${target}`);
  }
  return problems;
}

export function publicPageCheckoutAliasProblems(bodyMarkdown: string): readonly string[] {
  const problems = new Set<string>();
  for (const match of bodyMarkdown.matchAll(
    /(?:^|[^A-Za-z0-9_-])((?:(?:\.\.\/)+)?(?:repository\/)?additional\/\d+\/|(?:\.\.\/)*repository\/work\/)/g
  )) {
    problems.add(`public Context contains a private checkout alias: ${match[1]}`);
  }
  return [...problems];
}

function isSourceBindingProblem(problem: string): boolean {
  return /^(?:repository citation (?:has no complete path and range|path is unavailable|range is invalid|range exceeds)|provider citation does not bind|citation identity collision)/.test(
    problem
  );
}

function referenceBindingCounts(references: readonly CitationAuditReference[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const reference of references) {
    const binding = referenceBinding(reference);
    counts.set(binding, (counts.get(binding) ?? 0) + 1);
  }
  return counts;
}

function referenceBinding(reference: CitationAuditReference): string {
  return JSON.stringify([
    reference.sourceType,
    reference.sourceId,
    reference.contentDigest,
    reference.target,
    reference.pathOrUrl ?? null,
    reference.startLine ?? null,
    reference.endLine ?? null,
    reference.jsonPointer ?? null
  ]);
}

function sameStringMultiset(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const counts = new Map<string, number>();
  for (const value of left) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const value of right) {
    const remaining = counts.get(value) ?? 0;
    if (remaining === 0) return false;
    if (remaining === 1) counts.delete(value);
    else counts.set(value, remaining - 1);
  }
  return counts.size === 0;
}

const SCOPE_STOP_WORDS = new Set([
  "a",
  "about",
  "across",
  "after",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "before",
  "being",
  "between",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "in",
  "into",
  "is",
  "it",
  "its",
  "may",
  "must",
  "of",
  "on",
  "or",
  "should",
  "that",
  "the",
  "their",
  "these",
  "this",
  "those",
  "through",
  "to",
  "under",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "without",
  "would"
]);

function scopeTermSet(value: string): ReadonlySet<string> {
  return new Set(scopeTerms(renderedMarkdownText(value)));
}

function scopeTerms(value: string): readonly string[] {
  const terms = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [
    ...new Set(
      terms
        .filter((term) => !SCOPE_STOP_WORDS.has(term) && (term.length >= 3 || /\d/.test(term)))
        .map(scopeTermKey)
        .filter(Boolean)
    )
  ];
}

function scopeTermKey(term: string): string {
  let stem = term;
  if (stem.length > 5 && stem.endsWith("ies")) stem = `${stem.slice(0, -3)}y`;
  else if (stem.length > 6 && stem.endsWith("ing")) stem = stem.slice(0, -3);
  else if (stem.length > 5 && stem.endsWith("ed")) stem = stem.slice(0, -2);
  else if (stem.length > 5 && stem.endsWith("es")) stem = stem.slice(0, -2);
  else if (stem.length > 4 && stem.endsWith("s")) stem = stem.slice(0, -1);
  return stem.length >= 6 ? stem.slice(0, 5) : stem;
}

function renderedMarkdownText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)]\(\s*(?:<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/g, "$1")
    .replace(/\[([^\]]+)]\(\s*(?:<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/g, "$1")
    .replace(/https?:\/\/[^\s)>]+/g, " ")
    .replace(/<[^>\n]+>/g, " ");
}

function substantiveWordCount(markdown: string): number {
  return renderedMarkdownText(markdown).match(/[A-Za-z0-9][A-Za-z0-9_-]*/g)?.length ?? 0;
}

function markdownSectionCount(markdown: string): number {
  let inFence = false;
  let sections = 0;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^#{2,6}\s+\S/.test(line)) sections += 1;
  }
  return sections;
}

function markdownLinkTargets(markdown: string): ReadonlySet<string> {
  const targets = new Set<string>();
  for (const raw of markdownLinkDestinations(markdown)) {
    const target = raw.split("#", 1)[0]!.replaceAll("\\", "/");
    if (target) targets.add(target);
  }
  return targets;
}

function markdownLinkDestinations(markdown: string): readonly string[] {
  return [...markdown.matchAll(/(?<!!)\[[^\]]*]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g)].map(
    (match) => (match[1] ?? match[2] ?? "").replaceAll("\\", "/")
  );
}
