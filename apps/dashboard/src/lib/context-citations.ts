import type { ContextCatalogDocument, ContextSourceCitation } from "./types.ts";

function encodeGitHubPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function lineFragment(start?: number, end?: number): string {
  return start ? `#L${start}${end && end !== start ? `-L${end}` : ""}` : "";
}

function sourcePath(pathOrUrl: string, repository: string): string | undefined {
  if (!/^https?:\/\//i.test(pathOrUrl)) return normalizeRepositoryPath(pathOrUrl);
  try {
    const url = new URL(pathOrUrl);
    const prefix = `/${repository}/blob/`;
    if (url.hostname.toLowerCase() !== "github.com" || !url.pathname.toLowerCase().startsWith(prefix.toLowerCase())) {
      return undefined;
    }
    const afterRef = url.pathname.slice(prefix.length).split("/").slice(1).join("/");
    return normalizeRepositoryPath(afterRef);
  } catch {
    return undefined;
  }
}

function normalizeRepositoryPath(path: string): string | undefined {
  if (!path || path.startsWith("/") || path.startsWith("//")) return undefined;
  const segments: string[] = [];
  for (const rawSegment of path.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return undefined;
    }
    if (!segment || segment === ".") continue;
    if (segment === "..") return undefined;
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : undefined;
}

function immutableGitHubSourceHref(
  repository: string,
  commitSha: string,
  path: string,
  startLine?: number,
  endLine?: number
): string {
  return `https://github.com/${repository}/blob/${commitSha}/${encodeGitHubPath(path)}${lineFragment(startLine, endLine)}`;
}

export function contextCitationHref(citation: ContextSourceCitation): string | undefined {
  const { anchor } = citation;
  if (anchor.sourceType !== "blob") {
    return anchor.pathOrUrl && /^https?:\/\//i.test(anchor.pathOrUrl) ? anchor.pathOrUrl : undefined;
  }
  if (!anchor.pathOrUrl || !anchor.commitSha) return undefined;
  const path = sourcePath(anchor.pathOrUrl, anchor.repository);
  if (!path) return undefined;
  return immutableGitHubSourceHref(anchor.repository, anchor.commitSha, path, anchor.startLine, anchor.endLine);
}

export interface ContextRelevantSourceFile {
  readonly path: string;
  readonly href: string;
  readonly citationCount: number;
}

export function contextRelevantSourceFiles(
  citations: readonly ContextSourceCitation[]
): readonly ContextRelevantSourceFile[] {
  const files = new Map<string, ContextRelevantSourceFile>();
  for (const citation of citations) {
    const { anchor } = citation;
    if (anchor.sourceType !== "blob" || !anchor.pathOrUrl || !anchor.commitSha) continue;
    const path = sourcePath(anchor.pathOrUrl, anchor.repository);
    const href = contextCitationHref(citation);
    if (!path || !href) continue;
    const key = `${anchor.repository.toLowerCase()}\0${anchor.commitSha.toLowerCase()}\0${path}`;
    const existing = files.get(key);
    files.set(key, {
      path,
      href: existing?.href ?? href,
      citationCount: (existing?.citationCount ?? 0) + 1
    });
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function contextCitationLabel(citation: ContextSourceCitation): string {
  const { anchor } = citation;
  const target = anchor.pathOrUrl ?? `${anchor.sourceType}:${anchor.sourceId}`;
  if (!anchor.startLine) return target;
  return `${target}:${anchor.startLine}${anchor.endLine && anchor.endLine !== anchor.startLine ? `-${anchor.endLine}` : ""}`;
}

const KIND_DIRECTORY: Readonly<Record<string, string>> = {
  component: "components",
  feature: "features",
  decision: "decisions",
  change_summary: "changes",
  incident: "incidents",
  issue_explanation: "issues",
  ownership: "ownership",
  runbook: "runbooks",
  glossary: "glossary",
  flow: "flows",
  pattern: "patterns"
};

function logicalSubject(document: ContextCatalogDocument, repository: string): string | undefined {
  if (document.kind === "architecture") return "architecture";
  const prefix = document.logicalId.indexOf(":");
  if (prefix < 0) return undefined;
  const repositoryPrefix = `${repository.toLowerCase()}:`;
  const remainder = document.logicalId.slice(prefix + 1);
  if (!remainder.toLowerCase().startsWith(repositoryPrefix)) return undefined;
  return remainder.slice(repositoryPrefix.length);
}

export function contextDocumentPath(document: ContextCatalogDocument, repository: string): string | undefined {
  const subject = logicalSubject(document, repository);
  if (!subject) return undefined;
  const directory = document.kind ? KIND_DIRECTORY[document.kind] : undefined;
  return directory ? `${directory}/${subject}` : subject;
}

function resolveDocumentPath(fromPath: string, target: string): string | undefined {
  const targetPath = target.split(/[?#]/, 1)[0] ?? "";
  const segments = fromPath.split("/").slice(0, -1);
  for (const rawSegment of targetPath.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return undefined;
    }
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  const path = segments.join("/").replace(/\.md$/i, "");
  return path || undefined;
}

export type ContextMarkdownLink =
  | { readonly kind: "anchor"; readonly href: string }
  | { readonly kind: "document"; readonly documentId: string }
  | { readonly kind: "external"; readonly href: string }
  | { readonly kind: "source"; readonly href: string }
  | { readonly kind: "unsafe" };

export function resolveContextMarkdownLink(
  href: string,
  input: {
    readonly release: { readonly repository: string; readonly commitSha: string };
    readonly document: ContextCatalogDocument;
    readonly documents: readonly ContextCatalogDocument[];
  }
): ContextMarkdownLink {
  const target = href.trim();
  if (!target || target.startsWith("//")) return { kind: "unsafe" };
  if (target.startsWith("#")) return { kind: "anchor", href: target };
  if (/^https?:\/\//i.test(target)) return { kind: "external", href: target };
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return { kind: "unsafe" };

  const lineRange = /#L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(target);
  if (lineRange) {
    const path = normalizeRepositoryPath(target.slice(0, lineRange.index));
    const startLine = Number(lineRange[1]);
    const endLine = lineRange[2] ? Number(lineRange[2]) : startLine;
    if (!path || endLine < startLine) return { kind: "unsafe" };
    return {
      kind: "source",
      href: immutableGitHubSourceHref(input.release.repository, input.release.commitSha, path, startLine, endLine)
    };
  }

  const withoutFragment = target.split(/[?#]/, 1)[0] ?? "";
  if (/\.md$/i.test(withoutFragment)) {
    const currentPath = contextDocumentPath(input.document, input.release.repository);
    const resolved = currentPath ? resolveDocumentPath(currentPath, target) : undefined;
    const linkedDocument = resolved
      ? input.documents.find(
          (candidate) =>
            contextDocumentPath(candidate, input.release.repository)?.toLowerCase() === resolved.toLowerCase()
        )
      : undefined;
    return linkedDocument ? { kind: "document", documentId: linkedDocument.id } : { kind: "unsafe" };
  }

  const path = normalizeRepositoryPath(withoutFragment);
  return path
    ? {
        kind: "source",
        href: immutableGitHubSourceHref(input.release.repository, input.release.commitSha, path)
      }
    : { kind: "unsafe" };
}
