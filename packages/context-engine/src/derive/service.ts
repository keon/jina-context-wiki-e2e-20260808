import type { DerivationProgressPage } from "./progress.js";
import type { DerivationDetail } from "./verbosity.js";
import { fingerprint, normalizeIsoTime, stableId } from "../domain/fingerprint.js";
import type { RefManifestEntry } from "../domain/evidence.js";
import type {
  DerivationRun,
  KnowledgeDocumentRevision,
  KnowledgeEvidenceCitation,
  KnowledgeGenerationOutput
} from "../domain/knowledge.js";
import type { KnowledgeStore } from "../ports/knowledge-store.js";
import {
  buildKnowledgeFilePrompt,
  buildKnowledgePrompt,
  buildKnowledgeRepairPrompt,
  KNOWLEDGE_PROMPT_VERSION
} from "./prompt.js";
import { type FocusBundle, EvidenceFocusSelector, selectPriorKnowledge } from "./selector.js";
import { KNOWLEDGE_OUTPUT_SCHEMA_VERSION, parseKnowledgeGenerationOutput } from "./schema.js";
import { KnowledgeOutputValidator, KnowledgeValidationError } from "./validator.js";
import type { ContextWriteFence } from "../workflow/coordinator.js";

export interface PriorKnowledgeRevision {
  revision: KnowledgeDocumentRevision;
  citations: KnowledgeEvidenceCitation[];
  reviewStatus: "generated" | "reviewed";
}

export interface KnowledgeAgentWorkspace {
  repositoryDirectory: string;
  manifest: RefManifestEntry[];
  priorKnowledge: PriorKnowledgeRevision[];
}

export interface KnowledgeDocumentGenerationInput {
  prompt: string;
  bundle: FocusBundle;
  repairErrors: string[];
  workspace?: KnowledgeAgentWorkspace;
  /** Chosen when the build was requested, not read from the environment here. */
  detail?: DerivationDetail;
  /**
   * Wall clock this single run may use, in seconds.
   *
   * The caller passes what is left of the stage's budget rather than a fixed
   * per-run value, because a run can be followed by a repair run and a
   * per-run limit would let the stage take a multiple of the budget it was
   * given. Absent, the executor falls back to its deployment default.
   */
  budgetSeconds?: number;
  /**
   * Called with the pages finished so far, while the run is still going.
   *
   * A sandbox dies with its worker, so pages collected only at the end are lost
   * whenever a run is stopped rather than finished. Reporting them as they
   * appear is what makes a stopped build keep its work, and is the same signal
   * somebody watching the build wants to see.
   */
  onProgress?: (pages: readonly DerivationProgressPage[]) => Promise<void>;
}

export interface KnowledgeDocumentGenerator {
  readonly name: string;
  readonly version: string;
  readonly model: string;
  generate(input: KnowledgeDocumentGenerationInput): Promise<unknown>;
}

export class DeriveKnowledgeService {
  readonly #validator: KnowledgeOutputValidator;

  constructor(
    private readonly selector: EvidenceFocusSelector,
    private readonly generator: KnowledgeDocumentGenerator,
    private readonly knowledgeStore: KnowledgeStore,
    validator: KnowledgeOutputValidator
  ) {
    this.#validator = validator;
  }

  async derive(
    checkpointId: string,
    createdAt: string,
    fence?: ContextWriteFence,
    maximumAttempts = 2,
    repairPresentationFields = false
  ): Promise<DerivationRun> {
    if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 2) {
      throw new Error("Knowledge derivation supports one generation attempt and at most one repair");
    }
    const normalizedCreatedAt = normalizeIsoTime(createdAt);
    const bundle = await this.selector.select(checkpointId);
    const cacheKey = fingerprint({
      commitSha: bundle.checkpoint.commitSha,
      selectorVersion: bundle.selectorVersion,
      focusFingerprint: bundle.fingerprint,
      evidenceFingerprint: bundle.checkpoint.evidenceFingerprint,
      generatorName: this.generator.name,
      generatorVersion: this.generator.version,
      model: this.generator.model,
      promptVersion: KNOWLEDGE_PROMPT_VERSION,
      schemaVersion: KNOWLEDGE_OUTPUT_SCHEMA_VERSION
    });
    const cached = await this.knowledgeStore.findSuccessfulRun(cacheKey);
    if (cached !== undefined) return cached;
    const rawOutputs: unknown[] = [];
    let diagnostics: string[] = [];
    let validated: Awaited<ReturnType<KnowledgeOutputValidator["validate"]>> | undefined;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const raw = await this.generator.generate({
        prompt: attempt === 0 ? derivePrompt(bundle) : buildKnowledgeRepairPrompt(derivePrompt(bundle), diagnostics),
        bundle,
        repairErrors: diagnostics
      });
      rawOutputs.push(raw);
      try {
        const output: KnowledgeGenerationOutput = parseKnowledgeGenerationOutput(raw);
        const priorKnowledge = await selectPriorKnowledge(this.knowledgeStore, bundle.checkpoint);
        validateIncrementalCatalog(output, priorKnowledge, process.env.CONTEXT_DERIVE_DOCUMENT_FILES === "true");
        validated = await this.#validator.validate({
          output,
          checkpointId,
          generatorName: this.generator.name,
          generatorVersion: this.generator.version,
          model: this.generator.model,
          promptVersion: KNOWLEDGE_PROMPT_VERSION,
          createdAt: normalizedCreatedAt,
          // A Markdown document cites inline, so the trailing marker rule does
          // not apply; every other check still runs.
          inlineCitations: process.env.CONTEXT_DERIVE_DOCUMENT_FILES === "true",
          repairPresentationFields: repairPresentationFields || attempt > 0
        });
        diagnostics = [];
        break;
      } catch (error) {
        diagnostics =
          error instanceof KnowledgeValidationError
            ? error.diagnostics
            : [error instanceof Error ? error.message : String(error)];
      }
    }
    const runId = stableId("dr", { cacheKey, createdAt: normalizedCreatedAt, rawOutputs });
    if (validated === undefined) {
      const failed: DerivationRun = {
        id: runId,
        tenantId: bundle.checkpoint.tenantId,
        repository: bundle.checkpoint.repository,
        checkpointId,
        cacheKey,
        focusFingerprint: bundle.fingerprint,
        generatorName: this.generator.name,
        generatorVersion: this.generator.version,
        model: this.generator.model,
        promptVersion: KNOWLEDGE_PROMPT_VERSION,
        schemaVersion: KNOWLEDGE_OUTPUT_SCHEMA_VERSION,
        rawOutputs,
        status: "failed",
        diagnostics,
        revisionIds: [],
        createdAt: normalizedCreatedAt
      };
      await this.knowledgeStore.recordFailedRun(failed, fence);
      return failed;
    }
    const succeeded: DerivationRun = {
      id: runId,
      tenantId: bundle.checkpoint.tenantId,
      repository: bundle.checkpoint.repository,
      checkpointId,
      cacheKey,
      focusFingerprint: bundle.fingerprint,
      generatorName: this.generator.name,
      generatorVersion: this.generator.version,
      model: this.generator.model,
      promptVersion: KNOWLEDGE_PROMPT_VERSION,
      schemaVersion: KNOWLEDGE_OUTPUT_SCHEMA_VERSION,
      rawOutputs,
      status: "succeeded",
      diagnostics: [],
      revisionIds: validated.revisions.map((revision) => revision.id),
      createdAt: normalizedCreatedAt
    };
    return this.knowledgeStore.commitKnowledge(
      {
        run: succeeded,
        revisions: validated.revisions,
        citations: validated.citations
      },
      fence
    );
  }
}

function validateIncrementalCatalog(
  output: KnowledgeGenerationOutput,
  priorKnowledge: readonly PriorKnowledgeRevision[],
  documentFileContract: boolean
): void {
  const priorIds = new Set(priorKnowledge.map((entry) => entry.revision.logicalId));
  const documentIds = new Set(output.documents.map((document) => document.logicalId));
  const retired = output.retiredDocuments ?? [];
  const retiredIds = new Set(retired.map((entry) => entry.logicalId));
  const diagnostics: string[] = [];
  if (retiredIds.size !== retired.length) diagnostics.push("retiredDocuments contains duplicate logical IDs");
  for (const logicalId of retiredIds) {
    if (!priorIds.has(logicalId)) diagnostics.push(`retiredDocuments contains unknown prior logical ID ${logicalId}`);
    if (documentIds.has(logicalId)) diagnostics.push(`logical ID ${logicalId} is both emitted and retired`);
  }
  // Under the catalog contract a prior document that is neither re-emitted nor
  // retired has been dropped silently, and the build must fail. Under the file
  // contract the prior catalog is seeded into the output directory, so a
  // document the agent never opened is still on disk and carried forward — its
  // absence from the returned set would mean the file was deleted, which the
  // retired directory records explicitly. Requiring re-emission there would make
  // every incremental build cost the whole catalog again, which is the thing the
  // contract exists to avoid.
  if (!documentFileContract) {
    for (const logicalId of priorIds) {
      if (!documentIds.has(logicalId) && !retiredIds.has(logicalId)) {
        diagnostics.push(`prior logical ID ${logicalId} was silently dropped; re-emit or retire it`);
      }
    }
  }
  if (diagnostics.length > 0) throw new KnowledgeValidationError(diagnostics);
}

/** The file contract when it is enabled, the catalog contract otherwise. */
function derivePrompt(bundle: Parameters<typeof buildKnowledgePrompt>[0]): string {
  return process.env.CONTEXT_DERIVE_DOCUMENT_FILES === "true"
    ? buildKnowledgeFilePrompt(bundle)
    : buildKnowledgePrompt(bundle);
}
