import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  contextPublicSnapshotDigest,
  fingerprint,
  wikiContentBundleSha256,
  type ContextArtifactRef,
  type ContextArtifactStore,
  type WikiContentBundleV1,
  type WikiContentStorePort,
  type WikiTriggerProjectionPreparationV2,
  type WikiTriggerPublicationCommitV2,
  type WikiTriggerPublicationStorePort
} from "@jina/context-engine";
import type { WikiTriggerRequestV1 } from "@jina/shared-kernel";
import {
  contextWikiDefaultOpenAiModel,
  contextWikiGeneratorInferenceConfigDigest,
  contextWikiGeneratorPromptDigest,
  type FinalizedWikiOutput
} from "./context-wiki-execution.js";
import { ApiOwnedContextWikiPublicationRuntime } from "./context-wiki-publication.js";

test("publication persists the exact generator-v3 model, prompt, and inference provenance", async () => {
  const tenantId = "tenant-publication";
  const repository = "acme/widgets";
  const buildId = "task_wiki_publication";
  const commitSha = "a".repeat(40);
  const artifacts = new MemoryArtifacts(tenantId, repository, buildId);
  const bodyMarkdown = "# Overview\n\nThe entry point is defined by `src/index.ts`.\n";
  const bodySha256 = sha(bodyMarkdown);
  const publicSnapshotDigest = contextPublicSnapshotDigest([
    { documentPath: "index.md", title: "Overview", bodyMarkdown }
  ]);
  const bundle: WikiContentBundleV1 = {
    version: 1,
    publicSnapshotDigest,
    pages: [{ documentPath: "index.md", bodyMarkdown, bodySha256 }]
  };
  const bundleSha256 = wikiContentBundleSha256(bundle);
  const contentBundleArtifact = {
    version: 1 as const,
    tenantId,
    repository,
    publicSnapshotDigest,
    bundleSha256,
    uri: `memory://wiki-content/${bundleSha256}`,
    key: `context/tenants/${tenantId}/repositories/acme/widgets/wiki-content/${bundleSha256}.json`,
    contentType: "application/json" as const,
    bytes: Buffer.byteLength(JSON.stringify(bundle)),
    sha256: bundleSha256,
    objectGeneration: "1"
  };
  const artifact = async (kind: Parameters<ContextArtifactStore["put"]>[0]["kind"], name: string, value: unknown) =>
    artifacts.put({
      tenantId,
      repository,
      buildId,
      kind,
      name,
      contentType: "application/json",
      content: `${JSON.stringify(value)}\n`
    });
  const finalization = {
    version: 1 as const,
    sourceSnapshotDigest: "1".repeat(64),
    publicSnapshotDigest,
    contentBundleArtifactSha256: bundleSha256,
    manifestDigest: "2".repeat(64),
    projectionInputDigest: "3".repeat(64),
    checks: {
      minimumUsableBundle: "passed" as const,
      pathSafety: "passed" as const,
      logicalIdentity: "passed" as const,
      incrementalAccounting: "passed" as const,
      linkDiagnostics: 0,
      validDiagramCount: 0,
      degradedDiagramCount: 0
    },
    generatorPolicyVersion: "wiki-generator-v3",
    finalizerVersion: "context-wiki-finalizer-v1",
    okfPolicyVersion: "openwiki-compatible-okf-v1",
    mermaidVersion: "11.16.1",
    mermaidConfigDigest: "4".repeat(64),
    diagramPolicyVersion: "context-mermaid-grounded-v1"
  };
  const finalizationArtifact = await artifact("certification", "finalization.json", finalization);
  const planArtifact = await artifact("research-plan", "generation-plan.json", { version: 1 });
  const releaseManifestArtifact = await artifact("context-draft", "release-manifest.json", { version: 1 });
  const revisionId = "revision-index";
  const citation = {
    id: "citation-index",
    revisionId,
    ordinal: 0,
    claim: "The page is grounded in src/index.ts.",
    citationId: "cite_index",
    claimSpan: "src/index.ts",
    anchor: {
      tenantId,
      repository,
      sourceType: "blob" as const,
      sourceId: "blob-index",
      contentDigest: "5".repeat(64),
      commitSha,
      pathOrUrl: "src/index.ts"
    }
  };
  const finalized: FinalizedWikiOutput = {
    checkpointId: "checkpoint-publication",
    sourceDigest: "1".repeat(64),
    planArtifact,
    finalizationArtifact,
    releaseManifestArtifact,
    contentBundleArtifact,
    publicSnapshotDigest,
    projectionInputDigest: "3".repeat(64),
    instructionDigest: "6".repeat(64),
    exclusionPolicyDigest: "7".repeat(64),
    pathAccounting: {
      retainedPaths: [],
      regeneratedPaths: [],
      addedPaths: ["index.md"],
      retiredPaths: []
    },
    pages: [
      {
        documentPath: "index.md",
        title: "Overview",
        bodySha256,
        revisionId,
        metadataDigest: fingerprint({ sourcePaths: ["src/index.ts"] }),
        sourcePaths: ["src/index.ts"],
        citations: [citation]
      }
    ],
    diagnostics: [],
    usage: { inputTokens: 100, outputTokens: 50, costMicros: 0 }
  };
  const request: WikiTriggerRequestV1 = {
    schemaVersion: 1,
    taskIdentifier: "generate-wiki",
    boardBuildId: buildId,
    tenantId,
    repository,
    source: {
      commitSha,
      ref: "refs/heads/main",
      scopeKind: "branch",
      scopeKey: "main",
      refSequence: 1,
      githubInstallationId: 42
    },
    requestKey: "wiki:publication",
    generationReason: "initial",
    releaseFamilyId: "family-publication",
    requestedLocale: "en",
    pipelineVersion: "context_wiki.trigger.v1",
    generatorPolicyVersion: "wiki-generator-v3",
    options: {
      idempotencyKey: "wiki:publication",
      concurrencyKey: "wiki:tenant-publication:acme/widgets:refs/heads/main:en",
      queue: "context-wiki",
      tags: ["kind:context-wiki-build"]
    }
  };
  let preparedCommit: WikiTriggerPublicationCommitV2 | undefined;
  const publications = {
    async prepareProjection(input: WikiTriggerProjectionPreparationV2) {
      return {
        releaseId: input.release.release.releaseId,
        generationId: input.release.release.generationId,
        projectionInputDigest: finalization.projectionInputDigest,
        created: true
      };
    },
    async prepare(input: WikiTriggerPublicationCommitV2) {
      preparedCommit = input;
      return {
        releaseId: input.release.release.releaseId,
        generationId: input.release.release.generationId,
        publicationInputDigest: input.release.publicationInputDigest,
        publicSnapshotDigest: input.release.publicSnapshotDigest,
        releaseArtifact: input.releaseArtifact,
        preparedAt: input.release.release.preparedAt
      };
    }
  } as unknown as WikiTriggerPublicationStorePort;
  const content = {
    async get() {
      return bundle;
    }
  } as unknown as WikiContentStorePort;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.JINA_WIKI_MODEL;
  process.env.OPENAI_API_KEY = "configured";
  process.env.JINA_WIKI_MODEL = contextWikiDefaultOpenAiModel;
  try {
    const runtime = new ApiOwnedContextWikiPublicationRuntime(artifacts, content, publications);
    await runtime.project({
      request,
      requestDigest: "8".repeat(64),
      triggerParentRunId: "run_publication",
      authorizedAt: "2026-08-09T00:00:00.000Z",
      operationId: "project-publication",
      finalized
    });
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.JINA_WIKI_MODEL;
    else process.env.JINA_WIKI_MODEL = previousModel;
  }
  assert.ok(preparedCommit);
  assert.equal(preparedCommit.modelProviderFamily, "openai");
  assert.equal(preparedCommit.modelId, contextWikiDefaultOpenAiModel);
  assert.equal(preparedCommit.promptDigest, contextWikiGeneratorPromptDigest);
  assert.equal(
    preparedCommit.inferenceConfigDigest,
    contextWikiGeneratorInferenceConfigDigest("openai", contextWikiDefaultOpenAiModel)
  );
});

class MemoryArtifacts implements ContextArtifactStore {
  readonly #values = new Map<string, Uint8Array>();
  #generation = 0;

  constructor(
    private readonly tenantId: string,
    private readonly repository: string,
    private readonly buildId: string
  ) {}

  async put(input: Parameters<ContextArtifactStore["put"]>[0]): Promise<ContextArtifactRef> {
    assert.equal(input.tenantId, this.tenantId);
    assert.equal(input.repository, this.repository);
    assert.equal(input.buildId, this.buildId);
    const bytes = typeof input.content === "string" ? Buffer.from(input.content, "utf8") : Buffer.from(input.content);
    const key = `context/tenants/${this.tenantId}/repositories/acme/widgets/builds/${this.buildId}/${input.kind}/${input.name}`;
    const ref = {
      uri: `memory://${key}`,
      key,
      contentType: input.contentType,
      bytes: bytes.byteLength,
      sha256: sha(bytes),
      objectGeneration: String(++this.#generation)
    };
    this.#values.set(ref.uri, bytes);
    return ref;
  }

  async get(ref: ContextArtifactRef): Promise<Uint8Array> {
    const bytes = this.#values.get(ref.uri);
    if (!bytes) throw new Error("missing test artifact");
    return bytes;
  }
}

function sha(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
