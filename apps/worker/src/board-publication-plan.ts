import {
  boardPageAuditInventory,
  parseDocumentationStagePlan,
  type DocumentationStagePlan,
  type ResearchAssignment
} from "@jina/daytona";
import type { CertifiedContextReleasePage, IngestEvidenceInput, KnowledgeEvidenceCitation } from "@jina/context-engine";
import { pagePlanContentProblems, pagePlanStructuralProblems } from "./board-page-repair.js";
import { parsePlanWithSingleRepair, type BoundedPlanRepairRequest } from "./board-plan-repair.js";

export type PublicationPlanRepairRequest = BoundedPlanRepairRequest;

interface PublicationPlanValidation {
  readonly options: Parameters<typeof parseDocumentationStagePlan>[1];
  readonly validate?: (plan: DocumentationStagePlan) => void;
  readonly normalize?: (candidate: unknown) => unknown;
}

export function parseBoardPublicationPlan(
  candidate: unknown,
  input: PublicationPlanValidation
): DocumentationStagePlan {
  const withQuestions = completeMaintenanceQuestionCoverage(candidate, input.options.researchAssignments);
  const completed = completeRepositoryAreaCoverage(withQuestions, input.options);
  const plan = parseDocumentationStagePlan(input.normalize?.(completed) ?? completed, input.options);
  input.validate?.(plan);
  return plan;
}

/**
 * Gives a schema-valid but semantically rejected publication plan one bounded
 * correction pass. The host remains authoritative: both candidates go through
 * the same deterministic parser, and a second invalid candidate is terminal.
 */
export async function parsePublicationPlanWithRepair(input: {
  readonly candidate: unknown;
  readonly options: PublicationPlanValidation["options"];
  readonly validate?: PublicationPlanValidation["validate"];
  readonly normalize?: PublicationPlanValidation["normalize"];
  readonly repair: (request: PublicationPlanRepairRequest) => Promise<unknown>;
}): Promise<DocumentationStagePlan> {
  return parsePlanWithSingleRepair({
    candidate: input.candidate,
    parse: (candidate) =>
      parseBoardPublicationPlan(candidate, {
        options: input.options,
        ...(input.validate ? { validate: input.validate } : {}),
        ...(input.normalize ? { normalize: input.normalize } : {})
      }),
    repair: input.repair
  });
}

/**
 * Repository-area ownership is already implied by the planner's selected
 * research assignments. Materializing that implication host-side prevents a
 * validation waterfall where a model fixes one hierarchy defect only to expose
 * a missing bookkeeping label on its sole bounded repair pass.
 */
function completeRepositoryAreaCoverage(
  candidate: unknown,
  options: Parameters<typeof parseDocumentationStagePlan>[1]
): unknown {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
  const plan = candidate as Record<string, unknown>;
  if (!Array.isArray(plan.pages)) return candidate;

  const expectedAreas = [...options.repositoryAreas].sort((left, right) => {
    const depthDifference = left.split("/").length - right.split("/").length;
    if (depthDifference !== 0) return depthDifference;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const assignmentById = new Map(options.researchAssignments.map((assignment) => [assignment.id, assignment]));
  const excludedAreas = new Set(
    Array.isArray(plan.excludedAreas)
      ? plan.excludedAreas.flatMap((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
          const area = (entry as Record<string, unknown>).area;
          return typeof area === "string" ? [area] : [];
        })
      : []
  );
  let changed = false;
  const pages = plan.pages.map((entry): unknown => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const page = entry as Record<string, unknown>;
    if (!Array.isArray(page.sourceAssignmentIds) || !Array.isArray(page.coverageAreas)) return entry;
    const sourceAssignmentIds = page.sourceAssignmentIds.filter(
      (assignmentId): assignmentId is string => typeof assignmentId === "string"
    );
    const coverageAreas = page.coverageAreas.filter((area): area is string => typeof area === "string");
    if (
      sourceAssignmentIds.length !== page.sourceAssignmentIds.length ||
      coverageAreas.length !== page.coverageAreas.length
    ) {
      return entry;
    }
    const inferredAreas = sourceAssignmentIds.flatMap((assignmentId) => {
      const assignment = assignmentById.get(assignmentId);
      if (!assignment) return [];
      return assignment.focusPaths.flatMap((focusPath) => {
        const normalized = focusPath.replace(/\/+$/, "");
        return expectedAreas.filter(
          (area) => !excludedAreas.has(area) && (normalized === area || normalized.startsWith(`${area}/`))
        );
      });
    });
    const additions = [...new Set(inferredAreas)].filter((area) => !coverageAreas.includes(area));
    if (additions.length === 0) return entry;
    changed = true;
    return { ...page, coverageAreas: [...coverageAreas, ...additions] };
  });
  return changed ? { ...plan, pages } : candidate;
}

/**
 * Maintenance questions originate in the validated research plan, so copying
 * one verbatim onto a page that already owns its assignment is deterministic
 * bookkeeping rather than a documentation judgment. Keeping that bookkeeping
 * host-side avoids spending a model repair call—or withholding an otherwise
 * valid publication—because a planner paraphrased or omitted one exact string.
 *
 * This intentionally does not manufacture pages, assignments, writers, or
 * dependencies. If the planner failed to represent an assignment, the
 * authoritative parser still rejects the candidate and invokes the one bounded
 * repair.
 */
function completeMaintenanceQuestionCoverage(candidate: unknown, assignments: readonly ResearchAssignment[]): unknown {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
  const plan = candidate as Record<string, unknown>;
  if (!Array.isArray(plan.pages)) return candidate;

  let changed = false;
  const candidatePages: unknown[] = plan.pages;
  const pages = candidatePages.map((entry): unknown => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const page = entry as Record<string, unknown>;
    return { ...page };
  });
  for (const assignment of assignments) {
    const ownerIndex = pages.findIndex((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const sourceAssignmentIds = (entry as Record<string, unknown>).sourceAssignmentIds;
      return Array.isArray(sourceAssignmentIds) && sourceAssignmentIds.includes(assignment.id);
    });
    if (ownerIndex < 0) continue;
    const owner = pages[ownerIndex] as Record<string, unknown>;
    if (!Array.isArray(owner.maintenanceQuestions)) continue;
    const currentQuestions: unknown[] = owner.maintenanceQuestions;
    const questions = currentQuestions.filter((question): question is string => typeof question === "string");
    const missing = assignment.questions.filter((question) => !questions.includes(question));
    if (missing.length === 0) continue;
    pages[ownerIndex] = { ...owner, maintenanceQuestions: [...currentQuestions, ...missing] };
    changed = true;
  }
  return changed ? { ...plan, pages } : candidate;
}

/**
 * Retain is an exact-byte optimization, not an agent assertion. A prior page
 * is safe to retain only when its complete public evidence still resolves to
 * the same immutable source/provider identities and its existing bytes satisfy
 * the new plan's deterministic navigation contract.
 *
 * Letting the page enter the ordinary citation-repair loop would be unwinnable:
 * repairing it changes the bytes that publication correctly requires a retain
 * to preserve.
 */
export function retainedPublicationPlanProblems(input: {
  readonly plan: DocumentationStagePlan;
  readonly priorPages: readonly CertifiedContextReleasePage[];
  readonly snapshot: IngestEvidenceInput;
}): readonly string[] {
  const priorByPath = new Map(input.priorPages.map((page) => [page.documentPath, page]));
  const problems: string[] = [];
  for (const page of input.plan.pages) {
    if (page.change !== "retain") continue;
    const prior = priorByPath.get(page.path);
    if (!prior) {
      problems.push(`${page.path} is marked retain but is absent from the prior certified release`);
      continue;
    }
    if (page.title !== prior.title) {
      problems.push(`${page.path} changes its planned title and must be revise rather than retain`);
    }
    const inventory = boardPageAuditInventory({
      documentPath: prior.documentPath,
      bodyMarkdown: prior.bodyMarkdown,
      snapshot: input.snapshot
    });
    problems.push(...inventory.structuralProblems.map((problem) => `${page.path}: ${problem}`));
    problems.push(
      ...pagePlanStructuralProblems(page, input.plan.pages, prior.bodyMarkdown).map(
        (problem) => `${page.path}: ${problem}`
      )
    );
    problems.push(...pagePlanContentProblems(page, prior.bodyMarkdown));

    const priorByCitationId = new Map(
      prior.citations.flatMap((citation) => (citation.citationId ? [[citation.citationId, citation] as const] : []))
    );
    if (priorByCitationId.size !== prior.citations.length) {
      problems.push(`${page.path} has prior citations without public citation identities and must be revised`);
      continue;
    }
    if (inventory.references.length !== prior.citations.length) {
      problems.push(`${page.path} no longer resolves the complete prior citation set and must be revised`);
      continue;
    }
    for (const reference of inventory.references) {
      const citation = priorByCitationId.get(reference.citationId);
      if (!citation || !sameRetainedEvidenceBinding(citation, reference)) {
        problems.push(`${page.path} citation ${reference.citationId} changed source binding and must be revised`);
      }
    }
  }
  return [...new Set(problems)];
}

export function promoteUnsafeRetainedPages(input: {
  readonly candidate: unknown;
  readonly options: Parameters<typeof parseDocumentationStagePlan>[1];
  readonly priorPages: readonly CertifiedContextReleasePage[];
  readonly snapshot: IngestEvidenceInput;
}): unknown {
  let plan: DocumentationStagePlan;
  try {
    plan = parseDocumentationStagePlan(input.candidate, input.options);
  } catch {
    return input.candidate;
  }
  const problems = retainedPublicationPlanProblems({
    plan,
    priorPages: input.priorPages,
    snapshot: input.snapshot
  });
  const unsafePaths = new Set(
    plan.pages
      .filter(
        (page) =>
          page.change === "retain" &&
          problems.some((problem) => problem.startsWith(`${page.path}:`) || problem.startsWith(`${page.path} `))
      )
      .map((page) => page.path)
  );
  return unsafePaths.size === 0
    ? input.candidate
    : {
        ...plan,
        pages: plan.pages.map((page) => (unsafePaths.has(page.path) ? { ...page, change: "revise" as const } : page))
      };
}

function sameRetainedEvidenceBinding(
  citation: KnowledgeEvidenceCitation,
  reference: ReturnType<typeof boardPageAuditInventory>["references"][number]
): boolean {
  const anchor = citation.anchor;
  return (
    citation.citationId === reference.citationId &&
    citation.claim === reference.label &&
    citation.claimSpan === reference.claimSpan &&
    anchor.sourceType === reference.sourceType &&
    anchor.sourceId === reference.sourceId &&
    anchor.contentDigest === reference.contentDigest &&
    anchor.pathOrUrl === reference.pathOrUrl &&
    anchor.startLine === reference.startLine &&
    anchor.endLine === reference.endLine
  );
}
