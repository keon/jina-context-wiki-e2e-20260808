/**
 * Knowledge as a folder of Markdown, in the shape a wiki has.
 *
 * A document is a Markdown file. Its path is its identity — `runbooks/stalled-
 * publication.md` is the stalled-publication runbook — so the folder structure
 * is the catalog structure rather than something reconstructed from identifiers.
 *
 * Both kinds of reference are ordinary Markdown links, which is what keeps the
 * file readable on its own:
 *
 *   evidence   [lease expiry releases the row](packages/db/src/outbox.ts#L120-L128)
 *   document   [Diagnose a stalled publication](../runbooks/stalled-publication.md)
 *
 * The evidence form is what makes a claim checkable. The link text is the claim;
 * the target names a path in the checkpoint and an exact line range. The host
 * resolves the path through the checkpoint manifest and requires the link text to
 * occur in those lines, so a reference either holds against the commit or is
 * reported. Nothing about that verification depends on the file being JSON —
 * only on the reference being machine-readable, which a link is.
 */

/** A reference from one document to another, by relative path. */
export interface MarkdownDocumentLink {
  readonly text: string;
  /** As written, before resolution against the catalog. */
  readonly target: string;
}

/** A reference to an exact range of an exact file in the checkpoint. */
export interface MarkdownEvidenceLink {
  /** The link text, which is the claim the range must support. */
  readonly claim: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** A statement in a diagnostic section, with any evidence it links. */
export interface MarkdownStatement {
  readonly text: string;
  readonly evidence: readonly MarkdownEvidenceLink[];
}

/**
 * The four diagnostic groups, written as ordinary sections.
 *
 * `taskKind: "diagnose"` retrieves symptoms, causes, checks and fixes as a set
 * rather than as prose, so they have to be separable. In a Markdown catalog that
 * is a heading and a list, which is how somebody would write a runbook anyway —
 * the convention costs the author nothing and keeps the capability.
 */
export interface MarkdownDiagnostics {
  readonly symptoms: readonly MarkdownStatement[];
  readonly causes: readonly MarkdownStatement[];
  readonly checks: readonly MarkdownStatement[];
  readonly fixes: readonly MarkdownStatement[];
}

export interface ParsedMarkdownDocument {
  /** Path-derived identity, relative to the catalog root, without the extension. */
  readonly documentPath: string;
  /** The first level-one heading, or the file name when the document has none. */
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly documentLinks: readonly MarkdownDocumentLink[];
  readonly evidenceLinks: readonly MarkdownEvidenceLink[];
  readonly diagnostics: MarkdownDiagnostics;
}

/** Heading text to diagnostic group, tolerant of the words people actually use. */
const DIAGNOSTIC_HEADINGS: readonly (readonly [RegExp, keyof MarkdownDiagnostics])[] = [
  [/^symptoms?$/i, "symptoms"],
  [/^(likely )?causes?$/i, "causes"],
  [/^(checks?|diagnos(is|tics)|how to check)$/i, "checks"],
  [/^(fix(es)?|remediation|recovery|how to fix)$/i, "fixes"]
];

/**
 * Matches an inline Markdown link. Deliberately not a full Markdown parse: a
 * reference has to survive being read by a person as well as a parser, so the
 * grammar it uses is the one people already write.
 */
const LINK_PATTERN = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** `#L120-L128` or `#L120`, the anchor GitHub uses, so a link is clickable there too. */
const LINE_RANGE_PATTERN = /^#L(\d+)(?:-L(\d+))?$/;

function isDocumentTarget(target: string): boolean {
  return target.endsWith(".md") || target.includes(".md#");
}

export function parseMarkdownDocument(documentPath: string, source: string): ParsedMarkdownDocument {
  const documentLinks: MarkdownDocumentLink[] = [];
  const evidenceLinks: MarkdownEvidenceLink[] = [];

  for (const match of source.matchAll(LINK_PATTERN)) {
    const text = match[1]!.trim();
    const target = match[2]!;
    if (isDocumentTarget(target)) {
      documentLinks.push({ text, target });
      continue;
    }
    const hash = target.indexOf("#");
    if (hash < 0) continue;
    const range = LINE_RANGE_PATTERN.exec(target.slice(hash));
    if (!range) continue;
    const startLine = Number(range[1]);
    const endLine = range[2] === undefined ? startLine : Number(range[2]);
    // A backwards or zero range is not a reference to anything; dropping it here
    // keeps the verifier's diagnostics about evidence rather than about syntax.
    if (startLine < 1 || endLine < startLine) continue;
    evidenceLinks.push({ claim: text, path: target.slice(0, hash), startLine, endLine });
  }

  const diagnostics = parseDiagnostics(source);
  const heading = /^#\s+(.+)$/m.exec(source);
  const fallback = documentPath.split("/").at(-1) ?? documentPath;
  return {
    documentPath,
    title: heading ? heading[1]!.trim() : fallback,
    bodyMarkdown: source,
    documentLinks,
    evidenceLinks,
    diagnostics
  };
}

function evidenceIn(line: string): readonly MarkdownEvidenceLink[] {
  return parseMarkdownDocument("", line).evidenceLinks;
}

/** Strips link syntax so a statement reads as the sentence somebody wrote. */
function statementText(line: string): string {
  return line
    .replace(LINK_PATTERN, "$1")
    .replace(/^[-*+]\s+/, "")
    .trim();
}

function parseDiagnostics(source: string): MarkdownDiagnostics {
  const groups: { [K in keyof MarkdownDiagnostics]: MarkdownStatement[] } = {
    symptoms: [],
    causes: [],
    checks: [],
    fixes: []
  };
  let active: keyof MarkdownDiagnostics | undefined;
  for (const line of source.split(/\r?\n/)) {
    const heading = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const title = heading[2]!.trim();
      active = DIAGNOSTIC_HEADINGS.find(([pattern]) => pattern.test(title))?.[1];
      continue;
    }
    if (!active) continue;
    // Only list items are statements. Prose under the heading is context for a
    // reader and would make a poor retrieval unit.
    if (!/^\s*[-*+]\s+/.test(line)) continue;
    const text = statementText(line);
    if (text) groups[active].push({ text, evidence: evidenceIn(line) });
  }
  return groups;
}

/** The identity a Markdown file carries: its path, without the extension. */
export function documentPathFromFile(relativePath: string): string {
  return relativePath.replace(/\.md$/i, "");
}

/**
 * Resolves a relative link against the linking document, so `../runbooks/x.md`
 * from `components/api.md` is `runbooks/x`. Returns undefined for a link that
 * climbs out of the catalog, which cannot name a document in it.
 */
export function resolveDocumentLink(fromDocumentPath: string, target: string): string | undefined {
  const withoutAnchor = target.split("#")[0] ?? target;
  const segments = fromDocumentPath.split("/").slice(0, -1);
  for (const segment of withoutAnchor.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const resolved = documentPathFromFile(segments.join("/"));
  return resolved === "" ? undefined : resolved;
}
