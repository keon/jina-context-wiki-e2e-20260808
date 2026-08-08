import type { WikiContentArtifactRef, WikiContentBundleV1 } from "@jina/context-engine";
import { normalizeWikiRefIdentity } from "@jina/shared-kernel";

export type WikiSelector =
  | { readonly releaseId: string }
  | { readonly branch: string }
  | { readonly pullRequest: number }
  | { readonly commitSha: string };

export interface WikiReleaseIdentity {
  readonly releaseId: string;
  readonly releaseFamilyId: string;
  readonly generationId: string;
  readonly repository: string;
  readonly ref: string;
  readonly refSequence?: number;
  readonly commitSha: string;
  readonly publicSnapshotDigest: string;
  readonly locale: string;
  readonly scopeKind: "branch" | "pull_request" | "commit";
  readonly scopeKey: string;
  readonly publishedAt: string;
  readonly contentBundleArtifact: WikiContentArtifactRef;
}

export interface WikiAuditSummary {
  readonly quality: "not_audited" | "passed" | "needs_improvement" | "error";
  readonly auditId?: string;
  readonly auditPolicyVersion?: string;
  readonly auditedAt?: string;
  readonly summary?: Readonly<Record<string, unknown>>;
}

export interface ActivatedWikiBuildReceipt {
  readonly boardBuildId: string;
  readonly triggerParentRunId: string;
  readonly requestDigest: string;
  readonly releaseId: string;
  readonly releaseFamilyId: string;
  readonly commitSha: string;
  readonly locale: string;
  readonly publicSnapshotDigest: string;
  readonly releaseArtifactSha256: string;
  readonly contentBundleArtifactSha256: string;
  readonly pageindexAttachmentId: string;
  readonly activationOperationDigest: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly costMicros: number };
  readonly completedAt: string;
}

export interface WikiReleaseQueryStore {
  findActivatedWikiBuildReceipt?(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly boardBuildId: string;
    readonly requestDigest: string;
  }): Promise<ActivatedWikiBuildReceipt | undefined>;
  withCurrentPublishedWikiReleaseLock?<T>(
    input: { readonly tenantId: string; readonly repository: string; readonly ref: string; readonly locale: string },
    operation: (release: WikiReleaseIdentity | undefined) => Promise<T>
  ): Promise<T>;
  findPublishedWikiRelease(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly releaseId: string;
  }): Promise<WikiReleaseIdentity | undefined>;
  findCurrentPublishedWikiRelease(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly ref: string;
    readonly locale: string;
  }): Promise<WikiReleaseIdentity | undefined>;
  findNewestPublishedWikiReleaseForCommit(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly commitSha: string;
    readonly locale: string;
  }): Promise<WikiReleaseIdentity | undefined>;
  listPublishedWikiReleases(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly locale?: string;
    readonly ref?: string;
    readonly commitSha?: string;
    readonly releaseId?: string;
    readonly limit?: number;
  }): Promise<readonly WikiReleaseIdentity[]>;
  latestWikiAuditSummary(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly releaseId: string;
    readonly locale: string;
    readonly auditPolicyVersion: string;
  }): Promise<WikiAuditSummary | undefined>;
}

export interface WikiContentBundleReader {
  get(ref: WikiContentArtifactRef): Promise<WikiContentBundleV1>;
}

export class WikiSelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WikiSelectorError";
  }
}

export interface WikiQueryConfig {
  readonly defaultBranch: string;
  readonly defaultLocale: string;
  readonly auditPolicyVersion: string;
}

/**
 * Parses the five public selector fields as one strict union. `ref` is a
 * compatibility spelling only and is canonicalized into the same union.
 */
export function parseWikiSelector(
  value: Readonly<Record<string, unknown>>,
  options: { readonly allowOmitted: boolean }
): WikiSelector | undefined {
  const candidates: { readonly key: string; readonly value: unknown }[] = [
    { key: "releaseId", value: value.releaseId },
    { key: "branch", value: value.branch },
    { key: "pullRequest", value: value.pullRequest },
    { key: "commitSha", value: value.commitSha },
    { key: "ref", value: value.ref }
  ].filter((candidate) => candidate.value !== undefined);
  if (candidates.length === 0) {
    if (options.allowOmitted) return undefined;
    throw new WikiSelectorError("exactly one wiki selector is required");
  }
  if (candidates.length !== 1) throw new WikiSelectorError("wiki selector fields are mutually exclusive");
  const candidate = candidates[0]!;
  switch (candidate.key) {
    case "releaseId":
      return { releaseId: boundedText(candidate.value, "releaseId", 300) };
    case "branch":
      return { branch: canonicalBranch(boundedText(candidate.value, "branch", 255)) };
    case "pullRequest": {
      const pullRequest = positiveInteger(candidate.value, "pullRequest");
      normalizeWikiRefIdentity({ scopeKind: "pull_request", scopeKey: String(pullRequest) });
      return { pullRequest };
    }
    case "commitSha": {
      const commitSha = boundedText(candidate.value, "commitSha", 40).toLowerCase();
      normalizeWikiRefIdentity({ scopeKind: "commit", scopeKey: commitSha });
      return { commitSha };
    }
    case "ref":
      return selectorFromLegacyRef(boundedText(candidate.value, "ref", 300));
    default:
      throw new WikiSelectorError("wiki selector is invalid");
  }
}

export function parseWikiSelectorObject(
  value: unknown,
  options: { readonly allowOmitted: boolean }
): WikiSelector | undefined {
  if (value === undefined && options.allowOmitted) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WikiSelectorError("selector must be an object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["releaseId", "branch", "pullRequest", "commitSha", "ref"]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new WikiSelectorError("selector contains unknown fields");
  return parseWikiSelector(input, options);
}

export function canonicalWikiLocale(value: unknown, fallback: string): string {
  const locale = (value === undefined || value === null || value === "" ? fallback : boundedText(value, "locale", 80))
    .trim()
    .toLowerCase();
  if (!/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/.test(locale)) throw new WikiSelectorError("locale is invalid");
  return locale;
}

export function selectorFieldsFromUrl(searchParams: URLSearchParams): Readonly<Record<string, unknown>> {
  for (const field of ["releaseId", "branch", "pullRequest", "commitSha", "ref"] as const) {
    if (searchParams.getAll(field).length > 1) throw new WikiSelectorError(`selector field ${field} must appear once`);
  }
  return {
    ...(searchParams.has("releaseId") ? { releaseId: searchParams.get("releaseId") } : {}),
    ...(searchParams.has("branch") ? { branch: searchParams.get("branch") } : {}),
    ...(searchParams.has("pullRequest") ? { pullRequest: searchParams.get("pullRequest") } : {}),
    ...(searchParams.has("commitSha") ? { commitSha: searchParams.get("commitSha") } : {}),
    ...(searchParams.has("ref") ? { ref: searchParams.get("ref") } : {})
  };
}

export class ContextWikiQueryService {
  constructor(
    private readonly store: WikiReleaseQueryStore,
    private readonly config: WikiQueryConfig,
    private readonly bundles?: WikiContentBundleReader
  ) {}

  async resolve(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly selector?: WikiSelector;
    readonly locale?: string;
  }): Promise<{ readonly release: WikiReleaseIdentity; readonly audit: WikiAuditSummary }> {
    const selector = input.selector ?? { branch: this.config.defaultBranch };
    const requestedLocale =
      input.locale === undefined ? undefined : canonicalWikiLocale(input.locale, this.config.defaultLocale);
    let release: WikiReleaseIdentity | undefined;
    if ("releaseId" in selector) {
      release = await this.store.findPublishedWikiRelease({
        tenantId: input.tenantId,
        repository: input.repository,
        releaseId: selector.releaseId
      });
      if (release && requestedLocale !== undefined && release.locale !== requestedLocale) {
        throw new WikiSelectorError("locale does not match the immutable release");
      }
    } else {
      const locale = requestedLocale ?? canonicalWikiLocale(undefined, this.config.defaultLocale);
      if ("commitSha" in selector) {
        release = await this.store.findNewestPublishedWikiReleaseForCommit({
          tenantId: input.tenantId,
          repository: input.repository,
          commitSha: selector.commitSha,
          locale
        });
      } else {
        const identity =
          "pullRequest" in selector
            ? normalizeWikiRefIdentity({ scopeKind: "pull_request", scopeKey: String(selector.pullRequest) })
            : normalizeWikiRefIdentity({ scopeKind: "branch", scopeKey: selector.branch });
        release = await this.store.findCurrentPublishedWikiRelease({
          tenantId: input.tenantId,
          repository: input.repository,
          ref: identity.ref,
          locale
        });
      }
    }
    if (!release) throw new WikiSelectorError("published wiki release not found");
    return { release, audit: await this.audit(input.tenantId, input.repository, release) };
  }

  async list(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly selector?: WikiSelector;
    readonly locale?: string;
    readonly limit?: number;
  }): Promise<readonly { readonly release: WikiReleaseIdentity; readonly audit: WikiAuditSummary }[]> {
    const locale =
      input.locale === undefined
        ? canonicalWikiLocale(undefined, this.config.defaultLocale)
        : canonicalWikiLocale(input.locale, this.config.defaultLocale);
    const filters: { locale?: string; ref?: string; commitSha?: string; releaseId?: string } = { locale };
    if (input.selector) {
      if ("releaseId" in input.selector) {
        delete filters.locale;
        filters.releaseId = input.selector.releaseId;
      } else if ("commitSha" in input.selector) {
        filters.commitSha = input.selector.commitSha;
      } else {
        const ref =
          "pullRequest" in input.selector
            ? normalizeWikiRefIdentity({ scopeKind: "pull_request", scopeKey: String(input.selector.pullRequest) }).ref
            : normalizeWikiRefIdentity({ scopeKind: "branch", scopeKey: input.selector.branch }).ref;
        filters.ref = ref;
      }
    }
    const releases = await this.store.listPublishedWikiReleases({
      tenantId: input.tenantId,
      repository: input.repository,
      ...filters,
      ...(input.limit === undefined ? {} : { limit: input.limit })
    });
    if (
      input.locale !== undefined &&
      "releaseId" in (input.selector ?? {}) &&
      releases.length > 0 &&
      releases[0]?.locale !== locale
    ) {
      throw new WikiSelectorError("locale does not match the immutable release");
    }
    return Promise.all(
      releases.map(async (release) => ({
        release,
        audit: await this.audit(input.tenantId, input.repository, release)
      }))
    );
  }

  async export(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly selector?: WikiSelector;
    readonly locale?: string;
  }): Promise<{
    readonly release: WikiReleaseIdentity;
    readonly audit: WikiAuditSummary;
    readonly bundle: WikiContentBundleV1;
  }> {
    if (!this.bundles) throw new Error("wiki export storage is not configured");
    const resolved = await this.resolve(input);
    return {
      ...resolved,
      bundle: await this.bundles.get(resolved.release.contentBundleArtifact)
    };
  }

  private async audit(tenantId: string, repository: string, release: WikiReleaseIdentity): Promise<WikiAuditSummary> {
    return (
      (await this.store.latestWikiAuditSummary({
        tenantId,
        repository,
        releaseId: release.releaseId,
        locale: release.locale,
        auditPolicyVersion: this.config.auditPolicyVersion
      })) ?? { quality: "not_audited" }
    );
  }
}

function selectorFromLegacyRef(ref: string): WikiSelector {
  const branch = /^refs\/heads\/(.+)$/.exec(ref);
  if (branch) return { branch: canonicalBranch(branch[1]!) };
  const pull = /^refs\/pull\/([1-9][0-9]*)\/head$/.exec(ref);
  if (pull) return { pullRequest: positiveInteger(pull[1], "ref") };
  const commit = /^refs\/commits\/([0-9a-fA-F]{40})$/.exec(ref);
  if (commit) return { commitSha: commit[1]!.toLowerCase() };
  if (ref.startsWith("refs/")) throw new WikiSelectorError("legacy ref is not a supported wiki ref");
  return { branch: canonicalBranch(ref) };
}

function canonicalBranch(value: string): string {
  try {
    return normalizeWikiRefIdentity({ scopeKind: "branch", scopeKey: value.replace(/^refs\/heads\//, "") }).scopeKey;
  } catch (error) {
    throw new WikiSelectorError(error instanceof Error ? error.message : "branch is invalid");
  }
}

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new WikiSelectorError(`${label} is invalid`);
  }
  return value.trim();
}

function positiveInteger(value: unknown, label: string): number {
  const normalized = typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  if (typeof normalized !== "number" || !Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new WikiSelectorError(`${label} must be a positive integer`);
  }
  return normalized;
}
