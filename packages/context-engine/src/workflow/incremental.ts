import { createHash } from "node:crypto";
import { mapMarkdownCatalog } from "../derive/markdown-catalog.js";
import { documentPathFromFile, parseMarkdownDocument } from "../derive/markdown-document.js";
import type { CertifiedContextReleaseArtifactV1, ContextPublicPage } from "../publication/board-publication.js";

export const contextPageChanges = ["add", "retain", "revise"] as const;
export type ContextPageChange = (typeof contextPageChanges)[number];

export interface ContextPriorPage {
  readonly logicalId: string;
  readonly documentPath: string;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly bodySha256: string;
  readonly revisionId: string;
}

export interface ContextPlannedPageAccounting {
  readonly path: string;
  readonly change?: ContextPageChange;
}

export interface ContextRetiredPageAccounting {
  readonly path: string;
  readonly reason: string;
}

export interface ContextOmittedPageAccounting {
  readonly path: string;
  readonly reasonCode: string;
}

export interface ContextIncrementalAccounting {
  readonly priorPages: readonly ContextPriorPage[];
  readonly active: readonly {
    readonly path: string;
    readonly change: ContextPageChange;
    readonly prior?: ContextPriorPage;
  }[];
  readonly retired: readonly {
    readonly path: string;
    readonly reason: string;
    readonly prior: ContextPriorPage;
  }[];
}

/** Derives the same stable logical IDs that publication derives from paths. */
export function contextPriorReleaseCatalog(release: CertifiedContextReleaseArtifactV1): readonly ContextPriorPage[] {
  const parsed = release.pages.map((page) =>
    parseMarkdownDocument(documentPathFromFile(page.documentPath), page.bodyMarkdown)
  );
  const mapped = mapMarkdownCatalog(parsed, release.release.repository);
  if (mapped.problems.length > 0 || mapped.entries.length !== release.pages.length) {
    throw new Error("prior Context release cannot be mapped to a complete logical catalog");
  }
  const entryByPath = new Map(mapped.entries.map((entry) => [`${entry.documentPath}.md`, entry]));
  return release.pages.map((page) => {
    const entry = entryByPath.get(page.documentPath);
    if (!entry) throw new Error(`prior Context release has no logical identity for ${page.documentPath}`);
    return {
      logicalId: entry.logicalId,
      documentPath: page.documentPath,
      title: page.title,
      bodyMarkdown: page.bodyMarkdown,
      bodySha256: page.bodySha256,
      revisionId: page.revisionId
    };
  });
}

/**
 * Deterministic complete-set accounting. In an incremental build absence is
 * never interpreted as retirement: every prior path must be named exactly once.
 */
export function validateContextIncrementalAccounting(input: {
  readonly priorRelease?: CertifiedContextReleaseArtifactV1;
  readonly priorPages?: readonly ContextPriorPage[];
  readonly pages: readonly ContextPlannedPageAccounting[];
  readonly retiredPages?: readonly ContextRetiredPageAccounting[];
}): ContextIncrementalAccounting {
  if (input.priorRelease && input.priorPages) {
    throw new Error("incremental Context accounting received two prior catalogs");
  }
  const priorPages = input.priorRelease
    ? contextPriorReleaseCatalog(input.priorRelease)
    : [...(input.priorPages ?? [])];
  const priorByPath = new Map(priorPages.map((page) => [page.documentPath, page]));
  const activePaths = new Set<string>();
  const active = input.pages.map((page) => {
    if (activePaths.has(page.path)) throw new Error(`incremental Context plan duplicates active page ${page.path}`);
    activePaths.add(page.path);
    const prior = priorByPath.get(page.path);
    const change = page.change ?? (priorPages.length === 0 ? "add" : undefined);
    if (!change || !contextPageChanges.includes(change)) {
      throw new Error(`incremental Context page ${page.path} must declare add, retain, or revise`);
    }
    if (prior && change === "add") {
      throw new Error(`existing Context page ${page.path} cannot be declared add`);
    }
    if (!prior && change !== "add") {
      throw new Error(`new Context page ${page.path} must be declared add`);
    }
    return { path: page.path, change, ...(prior ? { prior } : {}) };
  });

  const retiredPaths = new Set<string>();
  const retired = (input.retiredPages ?? []).map((entry) => {
    if (!entry.reason.trim()) throw new Error(`retired Context page ${entry.path} requires a reason`);
    if (retiredPaths.has(entry.path)) throw new Error(`incremental Context plan retires ${entry.path} more than once`);
    retiredPaths.add(entry.path);
    if (activePaths.has(entry.path)) {
      throw new Error(`incremental Context page ${entry.path} cannot be active and retired`);
    }
    const prior = priorByPath.get(entry.path);
    if (!prior) throw new Error(`incremental Context plan retires unknown prior page ${entry.path}`);
    return { path: entry.path, reason: entry.reason, prior };
  });

  if (priorPages.length === 0 && retired.length > 0) {
    throw new Error("a cold Context plan cannot retire prior pages");
  }
  const silentlyDropped = priorPages
    .filter((page) => !activePaths.has(page.documentPath) && !retiredPaths.has(page.documentPath))
    .map((page) => page.documentPath);
  if (silentlyDropped.length > 0) {
    throw new Error(`incremental Context plan silently drops prior pages: ${silentlyDropped.join(", ")}`);
  }
  return { priorPages, active, retired };
}

/**
 * Publication-side enforcement: active pages must match the plan, retained
 * bytes must be exact, and the path-derived logical identity must remain stable.
 */
export function validatePublishedContextIncrement(input: {
  readonly priorRelease?: CertifiedContextReleaseArtifactV1;
  readonly plannedPages: readonly ContextPlannedPageAccounting[];
  readonly retiredPages?: readonly ContextRetiredPageAccounting[];
  readonly omittedPages?: readonly ContextOmittedPageAccounting[];
  readonly publishedPages: readonly ContextPublicPage[];
}): ContextIncrementalAccounting {
  const accounting = validateContextIncrementalAccounting({
    ...(input.priorRelease ? { priorRelease: input.priorRelease } : {}),
    pages: input.plannedPages,
    ...(input.retiredPages ? { retiredPages: input.retiredPages } : {})
  });
  const omittedPaths = new Set<string>();
  for (const omitted of input.omittedPages ?? []) {
    if (!omitted.reasonCode.trim()) throw new Error(`omitted Context page ${omitted.path} requires a reason code`);
    if (omittedPaths.has(omitted.path)) throw new Error(`Context publication omits ${omitted.path} more than once`);
    omittedPaths.add(omitted.path);
    const planned = accounting.active.find((entry) => entry.path === omitted.path);
    if (!planned) throw new Error(`Context publication omits unplanned page ${omitted.path}`);
    if (planned.change !== "add" || planned.prior) {
      throw new Error(`Context publication may omit only a new add page: ${omitted.path}`);
    }
  }
  const publishedByPath = new Map(input.publishedPages.map((page) => [page.documentPath, page]));
  const plannedPaths = new Set(
    accounting.active.filter((entry) => !omittedPaths.has(entry.path)).map((entry) => entry.path)
  );
  if (
    publishedByPath.size !== input.publishedPages.length ||
    publishedByPath.size !== plannedPaths.size ||
    [...plannedPaths].some((path) => !publishedByPath.has(path))
  ) {
    throw new Error("published Context pages do not exactly match the incrementally accounted active pages");
  }
  if (!input.priorRelease) return accounting;

  const publishedCatalog = contextPriorReleaseCatalog({
    ...input.priorRelease,
    pages: input.publishedPages.map((page) => ({
      ...page,
      bodySha256: createHash("sha256").update(page.bodyMarkdown).digest("hex"),
      revisionId: "pending",
      citations: []
    }))
  });
  const publishedByLogicalPath = new Map(publishedCatalog.map((page) => [page.documentPath, page]));
  for (const entry of accounting.active) {
    if (!entry.prior) continue;
    const published = publishedByPath.get(entry.path)!;
    const publishedIdentity = publishedByLogicalPath.get(entry.path);
    if (!publishedIdentity || publishedIdentity.logicalId !== entry.prior.logicalId) {
      throw new Error(`incremental Context page ${entry.path} changed its stable logical identity`);
    }
    if (
      entry.change === "retain" &&
      (createHash("sha256").update(published.bodyMarkdown).digest("hex") !== entry.prior.bodySha256 ||
        published.title !== entry.prior.title)
    ) {
      throw new Error(`retained Context page ${entry.path} changed published content`);
    }
  }
  return accounting;
}
