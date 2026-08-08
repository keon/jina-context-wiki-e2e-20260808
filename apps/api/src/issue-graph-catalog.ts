import {
  isContextArtifactKeyInRepositoryScope,
  parseIssueGraphArtifact,
  type ContextArtifactStore,
  type ContextEngineStore,
  type IssueGraphArtifactV1,
  type IssueGraphRelease
} from "@jina/context-engine";

const DEFAULT_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CACHE_ENTRIES = 32;

export interface CurrentIssueGraph {
  readonly release: IssueGraphRelease;
  readonly graph: IssueGraphArtifactV1;
}

/**
 * Resolves the highest-sequence release row and keeps graph reads off Postgres.
 * Artifacts are immutable, so a digest-keyed process cache needs no invalidation:
 * publishing a release naturally selects a new key.
 */
export class IssueGraphCatalogService {
  readonly #store: ContextEngineStore;
  readonly #artifacts: ContextArtifactStore;
  readonly #maxArtifactBytes: number;
  readonly #maxCacheEntries: number;
  readonly #cache = new Map<string, IssueGraphArtifactV1>();

  constructor(
    store: ContextEngineStore,
    artifacts: ContextArtifactStore,
    options: { readonly maxArtifactBytes?: number; readonly maxCacheEntries?: number } = {}
  ) {
    this.#store = store;
    this.#artifacts = artifacts;
    this.#maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    this.#maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    if (!Number.isSafeInteger(this.#maxArtifactBytes) || this.#maxArtifactBytes < 1) {
      throw new Error("issue graph artifact byte limit must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#maxCacheEntries) || this.#maxCacheEntries < 1) {
      throw new Error("issue graph cache entry limit must be a positive safe integer");
    }
  }

  async current(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly ref: string;
    readonly principalId: string;
    readonly tenantAdmin: boolean;
  }): Promise<CurrentIssueGraph | undefined> {
    const release = input.tenantAdmin
      ? await this.#store.currentIssueGraphRelease(input.tenantId, input.repository, input.ref)
      : await this.#store.currentAuthorizedIssueGraphRelease(
          input.tenantId,
          input.repository,
          input.ref,
          input.principalId
        );
    if (!release) return undefined;
    if (
      release.tenantId !== input.tenantId ||
      release.repository !== input.repository ||
      release.ref !== input.ref ||
      release.artifact.bytes < 1 ||
      release.artifact.bytes > this.#maxArtifactBytes ||
      release.artifact.contentType !== "application/json" ||
      !isContextArtifactKeyInRepositoryScope(release.artifact.key, input)
    ) {
      throw new Error("current issue graph release metadata is invalid");
    }

    const cacheKey = `${release.artifact.sha256}:${release.artifact.objectGeneration ?? ""}`;
    let graph = this.#cache.get(cacheKey);
    if (graph) {
      this.#cache.delete(cacheKey);
      this.#cache.set(cacheKey, graph);
    } else {
      const bytes = await this.#artifacts.get(release.artifact);
      if (bytes.byteLength < 1 || bytes.byteLength > this.#maxArtifactBytes) {
        throw new Error("issue graph artifact exceeds its configured byte limit");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
      } catch {
        throw new Error("issue graph artifact is not valid JSON");
      }
      graph = parseIssueGraphArtifact(parsed);
      this.#cache.set(cacheKey, graph);
      while (this.#cache.size > this.#maxCacheEntries) {
        const oldest = this.#cache.keys().next().value;
        if (!oldest) break;
        this.#cache.delete(oldest);
      }
    }
    assertReleaseMatchesGraph(release, graph);
    return { release, graph };
  }
}

function assertReleaseMatchesGraph(release: IssueGraphRelease, graph: IssueGraphArtifactV1): void {
  if (
    graph.id !== release.id ||
    graph.tenantId !== release.tenantId ||
    graph.repository !== release.repository ||
    graph.ref !== release.ref ||
    graph.refSequence !== release.refSequence ||
    graph.commitSha !== release.commitSha ||
    graph.contentDigest !== release.contentDigest ||
    graph.issues.length !== release.issueCount ||
    graph.causalities.length !== release.causalityCount ||
    graph.coverage.complete !== release.historyComplete
  ) {
    throw new Error("issue graph artifact does not match its release metadata");
  }
}
