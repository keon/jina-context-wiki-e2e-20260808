import { canonicalJson } from "@jina/context-engine";
import {
  citationAuditReferenceGroups,
  type CitationAuditReference,
  type CitationAuditStageResult
} from "@jina/daytona";

export async function retryCitationAuditValidation<T>(input: {
  readonly attempts: number;
  readonly run: (attempt: number, priorDiagnostic?: string) => Promise<unknown>;
  readonly parse: (value: unknown) => T;
}): Promise<T> {
  if (!Number.isInteger(input.attempts) || input.attempts < 1) {
    throw new Error("citation audit validation attempts must be a positive integer");
  }

  let diagnostic: string | undefined;
  for (let attempt = 1; attempt <= input.attempts; attempt += 1) {
    const value = await input.run(attempt, diagnostic);
    try {
      return input.parse(value);
    } catch (error) {
      if (attempt === input.attempts) throw error;
      diagnostic = validationDiagnostic(error);
    }
  }
  throw new Error("citation audit validation exhausted without a result");
}

export function citationAuditDelta(input: {
  readonly references: readonly CitationAuditReference[];
  readonly priorReferences?: readonly CitationAuditReference[];
  readonly priorAudit?: CitationAuditStageResult;
  readonly priorResults?: CitationAuditStageResult["results"];
  /**
   * Reuse unsupported verdicts only when the host retained the exact prior
   * public page after rejecting a no-progress/regressive repair.
   */
  readonly reuseAllExactVerdicts?: boolean;
}): {
  readonly pendingReferences: readonly CitationAuditReference[];
  readonly reusedResults: CitationAuditStageResult["results"];
} {
  const priorResults = input.priorResults ?? input.priorAudit?.results;
  if (!input.priorReferences || !priorResults) {
    return { pendingReferences: input.references, reusedResults: [] };
  }
  const priorReferences = new Map(input.priorReferences.map((reference) => [reference.citationId, reference]));
  const reusableResults = new Map(
    priorResults
      .filter((result) => input.reuseAllExactVerdicts === true || result.verdict === "supported")
      .map((result) => [result.citationId, result])
  );
  const pendingReferences: CitationAuditReference[] = [];
  const reusedResults: CitationAuditStageResult["results"][number][] = [];
  for (const group of citationAuditReferenceGroups(input.references)) {
    const reusable = group.map((reference) => {
      const priorReference = priorReferences.get(reference.citationId);
      const priorResult = reusableResults.get(reference.citationId);
      return priorReference && priorResult && canonicalJson(priorReference) === canonicalJson(reference)
        ? priorResult
        : undefined;
    });
    if (reusable.every((result) => result !== undefined)) {
      reusedResults.push(...reusable);
    } else {
      pendingReferences.push(...group);
    }
  }
  return { pendingReferences, reusedResults };
}

function validationDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}
