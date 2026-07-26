import { fingerprint, normalizeIsoTime, stableId } from "../domain/fingerprint.js";
import type { DerivationRun, KnowledgeGenerationOutput } from "../domain/knowledge.js";
import type { KnowledgeStore } from "../ports/knowledge-store.js";
import { buildKnowledgePrompt, KNOWLEDGE_PROMPT_VERSION } from "./prompt.js";
import { type FocusBundle, EvidenceFocusSelector } from "./selector.js";
import { KNOWLEDGE_OUTPUT_SCHEMA_VERSION, parseKnowledgeGenerationOutput } from "./schema.js";
import { KnowledgeOutputValidator, KnowledgeValidationError } from "./validator.js";
import type { ContextWriteFence } from "../workflow/coordinator.js";

export interface KnowledgeDocumentGenerator {
  readonly name: string;
  readonly version: string;
  readonly model: string;
  generate(input: { prompt: string; bundle: FocusBundle; repairErrors: string[] }): Promise<unknown>;
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
    maximumAttempts = 2
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
        prompt: buildKnowledgePrompt(bundle, diagnostics),
        bundle,
        repairErrors: diagnostics
      });
      rawOutputs.push(raw);
      try {
        const output: KnowledgeGenerationOutput = parseKnowledgeGenerationOutput(raw);
        validated = await this.#validator.validate({
          output,
          checkpointId,
          generatorName: this.generator.name,
          generatorVersion: this.generator.version,
          model: this.generator.model,
          promptVersion: KNOWLEDGE_PROMPT_VERSION,
          createdAt: normalizedCreatedAt
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
