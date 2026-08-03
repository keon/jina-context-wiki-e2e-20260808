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

/**
 * Model critics may append a finding for a citation that was not in their
 * assigned batch. Such a finding has no host-bound evidence and must not fail
 * an otherwise complete audit. Keep only assigned IDs; the strict parser still
 * rejects omissions, duplicates, and malformed results for those IDs.
 */
export function retainAssignedCitationAuditResults(value: unknown, citationIds: readonly string[]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.results)) return value;
  const assigned = new Set(citationIds);
  return {
    ...record,
    results: record.results.filter(
      (result) =>
        result !== null &&
        typeof result === "object" &&
        !Array.isArray(result) &&
        typeof (result as Record<string, unknown>).citationId === "string" &&
        assigned.has((result as Record<string, unknown>).citationId as string)
    )
  };
}

/**
 * Bind immutable workflow identity at the trust boundary instead of asking the
 * model to reproduce it. The model still supplies the audit judgments and
 * summaries; the strict result parser validates those after this normalization.
 */
export function bindCitationAuditHostIdentity(
  value: unknown,
  expected: {
    readonly workerId: string;
    readonly inputDigest: string;
    readonly publicSnapshotDigest: string;
  }
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!record.worker || typeof record.worker !== "object" || Array.isArray(record.worker)) return value;
  return {
    ...record,
    version: 1,
    inputDigest: expected.inputDigest,
    publicSnapshotDigest: expected.publicSnapshotDigest,
    worker: {
      ...(record.worker as Record<string, unknown>),
      id: expected.workerId
    }
  };
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
