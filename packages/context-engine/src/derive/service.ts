import { fingerprint, normalizeIsoTime, stableId } from "../domain/fingerprint.js";
import type { RefManifestEntry } from "../domain/evidence.js";
import type {
  DerivationRun,
  KnowledgeDocumentRevision,
  KnowledgeEvidenceCitation,
  KnowledgeGenerationOutput
} from "../domain/knowledge.js";
import type { KnowledgeStore } from "../ports/knowledge-store.js";
import { buildKnowledgePrompt, buildKnowledgeRepairPrompt, KNOWLEDGE_PROMPT_VERSION } from "./prompt.js";
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
        prompt:
          attempt === 0
            ? buildKnowledgePrompt(bundle)
            : buildKnowledgeRepairPrompt(buildKnowledgePrompt(bundle), diagnostics),
        bundle,
        repairErrors: diagnostics
      });
      rawOutputs.push(raw);
      try {
        const output: KnowledgeGenerationOutput = parseKnowledgeGenerationOutput(raw);
        const priorKnowledge = await selectPriorKnowledge(this.knowledgeStore, bundle.checkpoint);
        validateIncrementalCatalog(output, priorKnowledge);
        validated = await this.#validator.validate({
          output,
          checkpointId,
          generatorName: this.generator.name,
          generatorVersion: this.generator.version,
          model: this.generator.model,
          promptVersion: KNOWLEDGE_PROMPT_VERSION,
          createdAt: normalizedCreatedAt,
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
  priorKnowledge: readonly PriorKnowledgeRevision[]
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
  for (const logicalId of priorIds) {
    if (!documentIds.has(logicalId) && !retiredIds.has(logicalId)) {
      diagnostics.push(`prior logical ID ${logicalId} was silently dropped; re-emit or retire it`);
    }
  }
  if (diagnostics.length > 0) throw new KnowledgeValidationError(diagnostics);
}
