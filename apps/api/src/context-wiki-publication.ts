import { createHash } from "node:crypto";
import {
  fingerprint,
  parseWikiFinalizationAttestationV1,
  stableId,
  wikiPublicationInputDigestV2,
  wikiReleaseIdV2,
  type ContextArtifactRef,
  type ContextArtifactStore,
  type WikiContentStorePort,
  type WikiReleaseArtifactV2,
  type WikiTriggerActivationCommitV2,
  type WikiTriggerExecutionFenceV1,
  type WikiTriggerPublicationCommitV2,
  type WikiTriggerPublicationStorePort
} from "@jina/context-engine";
import type { WikiTriggerRequestV1 } from "@jina/shared-kernel";
import {
  type ContextWikiActivatedOutput,
  type ContextWikiProjectedOutput,
  type ContextWikiPublicationRuntime,
  type FinalizedWikiOutput
} from "./context-wiki-execution.js";

interface ProjectedArtifactV1 {
  readonly version: 1;
  readonly releaseId: string;
  readonly generationId: string;
  readonly releaseArtifact: ContextArtifactRef;
  readonly contentBundleArtifact: FinalizedWikiOutput["contentBundleArtifact"];
  readonly publicSnapshotDigest: string;
  readonly publicationInputDigest: string;
  readonly projectionInputDigest: string;
  readonly checkpointId: string;
  readonly pages: FinalizedWikiOutput["pages"];
  readonly usage: FinalizedWikiOutput["usage"];
}

export class ApiOwnedContextWikiPublicationRuntime implements ContextWikiPublicationRuntime {
  constructor(
    private readonly artifacts: ContextArtifactStore,
    private readonly content: WikiContentStorePort,
    private readonly publications: WikiTriggerPublicationStorePort
  ) {}

  async project(input: {
    readonly request: WikiTriggerRequestV1;
    readonly requestDigest: string;
    readonly triggerParentRunId: string;
    readonly authorizedAt: string;
    readonly operationId: string;
    readonly finalized: FinalizedWikiOutput;
  }): Promise<ContextWikiProjectedOutput> {
    const preparedAt = input.authorizedAt;
    const checkpointId = input.finalized.checkpointId;
    const provisional = releaseEnvelope(input, checkpointId, preparedAt, "pending", input.finalized);
    const publicationInputDigest = wikiPublicationInputDigestV2(provisional);
    const releaseId = wikiReleaseIdV2(publicationInputDigest);
    const release: WikiReleaseArtifactV2 = {
      ...releaseEnvelope(input, checkpointId, preparedAt, releaseId, input.finalized),
      publicationInputDigest
    };

    const bundle = await this.content.get(input.finalized.contentBundleArtifact);
    if (bundle.publicSnapshotDigest !== input.finalized.publicSnapshotDigest) {
      throw new Error("wiki bundle no longer matches the finalized public snapshot");
    }
    const finalization = parseWikiFinalizationAttestationV1(
      JSON.parse(Buffer.from(await this.artifacts.get(input.finalized.finalizationArtifact)).toString("utf8"))
    );
    const prepared = await this.publications.prepareProjection({
      release,
      contentBundle: bundle,
      finalization,
      projectorVersion: "wiki-release-v2"
    });
    if (prepared.generationId !== releaseId) throw new Error("prepared wiki projection returned the wrong generation");

    const releaseArtifact = await this.artifacts.put({
      tenantId: input.request.tenantId,
      repository: input.request.repository,
      buildId: input.request.boardBuildId,
      kind: "context-release",
      name: "release-v2.json",
      contentType: "application/json",
      content: `${JSON.stringify(release)}\n`
    });
    const fence = publicationFence(input, input.operationId);
    const commit: WikiTriggerPublicationCommitV2 = {
      release,
      releaseArtifact,
      finalization,
      fence,
      idempotencyKey: `${input.request.requestKey}:prepare`,
      pipelineVersion: input.request.pipelineVersion,
      instructionDigest: input.finalized.instructionDigest,
      exclusionPolicyDigest: input.finalized.exclusionPolicyDigest,
      modelProviderFamily: process.env.OPENAI_API_KEY ? "openai" : "deterministic",
      modelId: process.env.JINA_WIKI_MODEL?.trim() || (process.env.OPENAI_API_KEY ? "gpt-5.4-mini" : "host-v1"),
      promptDigest: digestText("context-wiki-page-prompt-v1"),
      inferenceConfigDigest: digestText("context-wiki-inference-v1")
    };
    const publication = await this.publications.prepare(commit);
    if (publication.releaseId !== releaseId) throw new Error("wiki publication prepared the wrong release");

    const projectedArtifactValue: ProjectedArtifactV1 = {
      version: 1,
      releaseId,
      generationId: releaseId,
      releaseArtifact,
      contentBundleArtifact: input.finalized.contentBundleArtifact,
      publicSnapshotDigest: input.finalized.publicSnapshotDigest,
      publicationInputDigest,
      projectionInputDigest: input.finalized.projectionInputDigest,
      checkpointId,
      pages: input.finalized.pages,
      usage: input.finalized.usage
    };
    const projectedArtifact = await this.artifacts.put({
      tenantId: input.request.tenantId,
      repository: input.request.repository,
      buildId: input.request.boardBuildId,
      kind: "context-draft",
      name: "projected-release.json",
      contentType: "application/json",
      content: `${JSON.stringify(projectedArtifactValue)}\n`
    });
    return {
      releaseId,
      generationId: releaseId,
      releaseArtifactSha256: releaseArtifact.sha256,
      contentBundleArtifactSha256: input.finalized.contentBundleArtifact.bundleSha256,
      publicSnapshotDigest: input.finalized.publicSnapshotDigest,
      projectedArtifact
    };
  }

  async activate(input: {
    readonly request: WikiTriggerRequestV1;
    readonly requestDigest: string;
    readonly triggerParentRunId: string;
    readonly authorizedAt: string;
    readonly operationId: string;
    readonly projected: ContextWikiProjectedOutput;
  }): Promise<ContextWikiActivatedOutput> {
    const projected = await this.readProjected(input.projected.projectedArtifact);
    if (
      projected.releaseId !== input.projected.releaseId ||
      projected.releaseArtifact.sha256 !== input.projected.releaseArtifactSha256 ||
      projected.contentBundleArtifact.bundleSha256 !== input.projected.contentBundleArtifactSha256
    ) {
      throw new Error("projected wiki handoff identity is invalid");
    }
    const nodes = projected.pages.map((page, index) => ({
      id: stableId("hn", { releaseId: projected.releaseId, documentPath: page.documentPath }),
      documentPath: page.documentPath,
      title: page.title,
      ordinal: index,
      depth: page.documentPath.split("/").length - 1,
      summary: `Wiki page ${page.title}`
    }));
    const pageIndex = {
      version: 2,
      releaseId: projected.releaseId,
      generationId: projected.generationId,
      publicSnapshotDigest: projected.publicSnapshotDigest,
      selector: "pageindex-lexical-tree-v1",
      nodes,
      treeDigest: fingerprint(nodes)
    };
    const pageIndexArtifact = await this.artifacts.put({
      tenantId: input.request.tenantId,
      repository: input.request.repository,
      buildId: input.request.boardBuildId,
      kind: "pageindex-tree",
      name: "wiki-tree.json",
      contentType: "application/json",
      content: `${JSON.stringify(pageIndex)}\n`
    });
    const attachmentInputDigest = fingerprint({
      version: 2,
      releaseId: projected.releaseId,
      pageIndexArtifact: {
        key: pageIndexArtifact.key,
        sha256: pageIndexArtifact.sha256,
        bytes: pageIndexArtifact.bytes,
        objectGeneration: pageIndexArtifact.objectGeneration
      },
      treeDigest: pageIndex.treeDigest
    });
    const activation: WikiTriggerActivationCommitV2 = {
      releaseId: projected.releaseId,
      fence: publicationFence(input, input.operationId),
      idempotencyKey: `${input.request.requestKey}:pageindex`,
      attachmentInputDigest,
      pageIndexArtifact,
      pageIndexMetadata: {
        version: 2,
        selector: pageIndex.selector,
        nodeCount: nodes.length,
        treeDigest: pageIndex.treeDigest,
        usage: projected.usage
      }
    };
    const receipt = await this.publications.activate(activation);
    if (receipt.releaseId !== projected.releaseId || !receipt.publishedAt) {
      throw new Error("wiki release activation did not publish the prepared generation");
    }
    return {
      schemaVersion: 1,
      status: "completed",
      boardBuildId: input.request.boardBuildId,
      triggerParentRunId: input.triggerParentRunId,
      requestDigest: input.requestDigest,
      tenantId: input.request.tenantId,
      repository: input.request.repository,
      commitSha: input.request.source.commitSha,
      locale: input.request.requestedLocale,
      releaseFamilyId: input.request.releaseFamilyId,
      releaseId: projected.releaseId,
      generationId: projected.generationId,
      releaseArtifactSha256: projected.releaseArtifact.sha256,
      contentBundleArtifactSha256: projected.contentBundleArtifact.bundleSha256,
      publicSnapshotDigest: projected.publicSnapshotDigest,
      pageindexAttachmentId: stableId("pia", { releaseId: projected.releaseId, attachmentInputDigest }),
      activationOperationDigest: fingerprint({ operationId: input.operationId, attachmentInputDigest }),
      usage: projected.usage,
      completedAt: receipt.publishedAt
    };
  }

  private async readProjected(ref: ContextArtifactRef): Promise<ProjectedArtifactV1> {
    const value = JSON.parse(Buffer.from(await this.artifacts.get(ref)).toString("utf8")) as ProjectedArtifactV1;
    if (value.version !== 1 || value.releaseId !== value.generationId) {
      throw new Error("projected wiki artifact is invalid");
    }
    return value;
  }
}

function releaseEnvelope(
  input: {
    readonly request: WikiTriggerRequestV1;
    readonly requestDigest: string;
    readonly triggerParentRunId: string;
  },
  checkpointId: string,
  preparedAt: string,
  releaseId: string,
  finalized: FinalizedWikiOutput
): Omit<WikiReleaseArtifactV2, "publicationInputDigest"> {
  return {
    version: 2,
    kind: "generated-wiki",
    release: {
      releaseId,
      tenantId: input.request.tenantId,
      repository: input.request.repository,
      ref: input.request.source.ref,
      ...(input.request.source.refSequence === undefined ? {} : { refSequence: input.request.source.refSequence }),
      scopeKind: input.request.source.scopeKind,
      scopeKey: input.request.source.scopeKey,
      commitSha: input.request.source.commitSha,
      ...(input.request.source.baseCommitSha ? { baseCommitSha: input.request.source.baseCommitSha } : {}),
      checkpointId,
      generationId: releaseId,
      buildId: input.request.boardBuildId,
      triggerParentRunId: input.triggerParentRunId,
      requestDigest: input.requestDigest,
      releaseFamilyId: input.request.releaseFamilyId,
      ...(input.request.parentReleaseId ? { parentReleaseId: input.request.parentReleaseId } : {}),
      ...(input.request.sourceReleaseId ? { sourceReleaseId: input.request.sourceReleaseId } : {}),
      ...(input.request.sourceLocale ? { sourceLocale: input.request.sourceLocale } : {}),
      generationReason: input.request.generationReason,
      locale: input.request.requestedLocale,
      preparedAt
    },
    generationPlanArtifact: finalized.planArtifact,
    finalizationArtifact: finalized.finalizationArtifact,
    releaseManifestArtifact: finalized.releaseManifestArtifact,
    contentBundleArtifact: finalized.contentBundleArtifact,
    publicSnapshotDigest: finalized.publicSnapshotDigest,
    pages: finalized.pages.map((page) => ({
      documentPath: page.documentPath,
      title: page.title,
      bodySha256: page.bodySha256,
      revisionId: page.revisionId,
      citations: page.citations,
      metadataDigest: page.metadataDigest
    }))
  };
}

function publicationFence(
  input: {
    readonly request: WikiTriggerRequestV1;
    readonly requestDigest: string;
    readonly triggerParentRunId: string;
  },
  operationId: string
): WikiTriggerExecutionFenceV1 {
  return {
    boardBuildId: input.request.boardBuildId,
    triggerParentRunId: input.triggerParentRunId,
    requestDigest: input.requestDigest,
    tenantId: input.request.tenantId,
    repository: input.request.repository,
    commitSha: input.request.source.commitSha,
    scopeKind: input.request.source.scopeKind,
    ref: input.request.source.ref,
    ...(input.request.source.refSequence === undefined ? {} : { refSequence: input.request.source.refSequence }),
    locale: input.request.requestedLocale,
    operationId
  };
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
