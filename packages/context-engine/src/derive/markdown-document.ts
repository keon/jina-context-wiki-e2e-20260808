/**
 * Repository context as a folder of ordinary Markdown documents.
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
 * The evidence form is what makes a claim checkable. The target names a path in
 * the checkpoint and an exact line range. The host resolves that immutable
 * location deterministically; a source-aware audit separately checks whether
 * the nearby clause, sentence, list item, or table cell is supported by its exact
 * excerpt. Link labels can therefore remain natural navigation text.
 */

import { createHash } from "node:crypto";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/** A reference from one document to another, by relative path. */
export interface MarkdownDocumentLink {
  readonly text: string;
  /** As written, before resolution against the catalog. */
  readonly target: string;
}

/** A reference to an exact range of an exact file in the checkpoint. */
export interface MarkdownEvidenceLink {
  /** Stable within a document for the same target, claim span, and occurrence. */
  readonly citationId: string;
  /** Natural visible link text. It is navigation text, not a source quotation. */
  readonly claim: string;
  /** Smallest useful clause, sentence, list item, or table cell this link supports. */
  readonly claimSpan: string;
  readonly path?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  /** Natural provider URL; the host resolves the claim to an exact JSON pointer. */
  readonly providerUrl?: string;
}

/** A statement in a diagnostic section, with any evidence it links. */
export interface MarkdownStatement {
  readonly text: string;
  readonly evidence: readonly MarkdownEvidenceLink[];
}

export interface MarkdownMaterialClaim {
  /** Stable within this exact public document and claim occurrence. */
  readonly claimId: string;
  readonly text: string;
  readonly kind: "sentence" | "list_item" | "table_cell";
  /**
   * Conservative deterministic classification. Anything not provably a
   * question or pure document navigation remains material and must be cited.
   */
  readonly classification: "material" | "non_factual" | "navigation";
  /** Public citation identities located inside this exact assertion span. */
  readonly citationIds: readonly string[];
  /** Whether this assertion contributes to the lead paragraph used as summary. */
  readonly summary: boolean;
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
  readonly materialClaims: readonly MarkdownMaterialClaim[];
  readonly diagnostics: MarkdownDiagnostics;
}

export interface MarkdownEvidenceSection {
  readonly heading: string;
  readonly level: number;
  readonly line: number;
  readonly substantiveClaimCount: number;
  readonly citationIds: readonly string[];
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
const LINK_PATTERN = /\[((?:\\[^\n]|`[^`\n]*`|[^\]\\\n])*)\]\(([^)\s]+)\)/g;

/** `#L120-L128` or `#L120`, the anchor GitHub uses, so a link is clickable there too. */
const LINE_RANGE_PATTERN = /^#L(\d+)(?:-L(\d+))?$/;
/** A common agent/research notation that is normalized to the public `#L` form. */
const TRAILING_LINE_RANGE_PATTERN = /:(\d+)(?:-(\d+))?$/;

/**
 * Evidence must be a rendered public link. Markdown-looking text in a fenced
 * example, inline code, an HTML comment, an image, or an escaped literal cannot
 * ground the page a reader sees.
 */
function isRenderedMarkdownLink(source: string, linkStart: number): boolean {
  if (source[linkStart - 1] === "!") return false;
  let escapes = 0;
  for (let index = linkStart - 1; index >= 0 && source[index] === "\\"; index -= 1) escapes += 1;
  if (escapes % 2 === 1) return false;

  const openComment = source.lastIndexOf("<!--", linkStart);
  const closeComment = source.lastIndexOf("-->", linkStart);
  if (openComment > closeComment) return false;

  const lineStart = source.lastIndexOf("\n", Math.max(0, linkStart - 1)) + 1;
  const currentLineEnd = source.indexOf("\n", linkStart);
  const lineEnd = currentLineEnd < 0 ? source.length : currentLineEnd;
  const currentLine = source.slice(lineStart, lineEnd);
  const positionInLine = linkStart - lineStart;

  let fence: { character: "`" | "~"; length: number } | undefined;
  for (const line of source.slice(0, lineStart).split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!marker) continue;
    const character = marker[0] as "`" | "~";
    if (!fence) {
      fence = { character, length: marker.length };
    } else if (
      character === fence.character &&
      marker.length >= fence.length &&
      /^\s{0,3}(?:`{3,}|~{3,})\s*$/.test(line)
    ) {
      fence = undefined;
    }
  }
  if (fence || /^\s{0,3}(?:`{3,}|~{3,})/.test(currentLine)) return false;

  for (let index = 0; index < currentLine.length;) {
    if (currentLine[index] !== "`") {
      index += 1;
      continue;
    }
    let endOfOpening = index + 1;
    while (currentLine[endOfOpening] === "`") endOfOpening += 1;
    const marker = currentLine.slice(index, endOfOpening);
    const close = currentLine.indexOf(marker, endOfOpening);
    if (close < 0) break;
    if (positionInLine > index && positionInLine < close + marker.length) return false;
    index = close + marker.length;
  }
  return true;
}

function plainMarkdown(value: string): string {
  return value
    .replace(LINK_PATTERN, "$1")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function citationMarkerLabel(value: string): string {
  return value
    .trim()
    .replace(/^`+|`+$/g, "")
    .replace(/\\([\\`*_[\]{}()#+.!<>-])/g, "$1");
}

function plainMarkdownPosition(value: string, rawPosition: number): { plain: string; position: number } {
  const marker = "\u{e000}\u{e001}";
  const marked = `${value.slice(0, rawPosition)}${marker}${value.slice(rawPosition)}`;
  const plainMarked = plainMarkdown(marked);
  const position = plainMarked.indexOf(marker);
  if (position < 0) return { plain: plainMarkdown(value), position: 0 };
  return {
    plain: plainMarked.replace(marker, ""),
    position
  };
}

function localAssertionSpan(value: string, linkPosition: number): string {
  const boundaries: { start: number; end: number }[] = [];
  for (const match of value.matchAll(
    /;\s+|(?:\s+[—–]\s+)|,\s+(?:(?:but|while|whereas|although|though|yet|and|or)\s+)/gi
  )) {
    const index = match.index ?? 0;
    boundaries.push({ start: index, end: index + match[0].length });
  }
  let start = 0;
  let end = value.length;
  for (const boundary of boundaries) {
    if (boundary.end <= linkPosition) start = boundary.end;
    if (boundary.start >= linkPosition) {
      end = boundary.start;
      break;
    }
  }
  const selected = value
    .slice(start, end)
    .replace(/^(?:but|while|whereas|although|though|yet|and|or)\s+/i, "")
    .trim();
  return selected || value.trim();
}

function containingClaimSpan(source: string, linkStart: number, linkEnd: number): string {
  const lineStart = source.lastIndexOf("\n", Math.max(0, linkStart - 1)) + 1;
  const nextNewline = source.indexOf("\n", linkEnd);
  const lineEnd = nextNewline < 0 ? source.length : nextNewline;
  const line = source.slice(lineStart, lineEnd);
  if (/^\s*\|/.test(line)) {
    const lineLinkStart = linkStart - lineStart;
    let rawCellStart = line.lastIndexOf("|", lineLinkStart) + 1;
    const rawCellEndCandidate = line.indexOf("|", Math.max(lineLinkStart, linkEnd - lineStart));
    const rawCellEnd = rawCellEndCandidate < 0 ? line.length : rawCellEndCandidate;
    if (rawCellStart < 0) rawCellStart = 0;
    const cell = line.slice(rawCellStart, rawCellEnd);
    const { plain, position: linkPosition } = plainMarkdownPosition(cell, lineLinkStart - rawCellStart);
    return localAssertionSpan(plain, linkPosition);
  }
  if (/^\s*[-*+]\s+/.test(line)) {
    const prefixLength = /^\s*[-*+]\s+/.exec(line)?.[0].length ?? 0;
    const item = line.slice(prefixLength);
    const { plain, position: linkPosition } = plainMarkdownPosition(item, linkStart - lineStart - prefixLength);
    return localAssertionSpan(plain, linkPosition);
  }
  if (/^\s*#{1,6}\s+/.test(line)) {
    return plainMarkdown(line);
  }

  const before = source.slice(0, linkStart);
  const paragraphStarts = [...before.matchAll(/\n\s*\n/g)];
  const lastParagraphStart = paragraphStarts.at(-1);
  const paragraphStart = lastParagraphStart ? (lastParagraphStart.index ?? 0) + lastParagraphStart[0].length : 0;
  const after = source.slice(linkEnd);
  const paragraphEndMatch = /\n\s*\n/.exec(after);
  const paragraphEnd = paragraphEndMatch ? linkEnd + paragraphEndMatch.index : source.length;
  const paragraph = source.slice(paragraphStart, paragraphEnd);
  const { plain, position: linkPosition } = plainMarkdownPosition(paragraph, linkStart - paragraphStart);
  let offset = 0;
  for (const sentence of plain.matchAll(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)) {
    const value = sentence[0];
    const start = sentence.index ?? offset;
    const end = start + value.length;
    offset = end;
    if (linkPosition >= start && linkPosition < end) {
      const selected = value.trim();
      if (selected) return localAssertionSpan(selected, Math.max(0, linkPosition - start));
    }
  }
  return plainMarkdown(line) || plain;
}

function citationIdentity(documentPath: string, target: string, claimSpan: string, occurrence: number): string {
  return `cite_${createHash("sha256")
    .update(`${documentPath}\u0000${target}\u0000${claimSpan}\u0000${occurrence}`)
    .digest("hex")
    .slice(0, 20)}`;
}

interface MarkdownAstNode {
  readonly type: string;
  readonly depth?: number;
  readonly value?: string;
  readonly alt?: string;
  readonly label?: string;
  readonly url?: string;
  readonly children?: readonly MarkdownAstNode[];
  readonly position?: {
    readonly start: { readonly offset?: number; readonly line?: number };
    readonly end: { readonly offset?: number; readonly line?: number };
  };
}

interface RenderedUnit {
  readonly value: string;
  readonly linkStart?: number;
  readonly documentLink: boolean;
  readonly documentTarget?: string;
  /** Inline-code contents are rendered text but not prose punctuation/grammar. */
  readonly literal?: boolean;
}

interface ClaimCandidate {
  readonly text: string;
  readonly kind: MarkdownMaterialClaim["kind"];
  readonly classification: MarkdownMaterialClaim["classification"];
  readonly linkStarts: readonly number[];
  readonly summary: boolean;
}

function renderedClaimUnits(node: MarkdownAstNode): RenderedUnit[] {
  const rendered: RenderedUnit[] = [];
  const append = (value: string, linkStart?: number, documentTarget?: string, literal = false): void => {
    for (const character of value) {
      rendered.push({
        value: character,
        ...(linkStart === undefined ? {} : { linkStart }),
        documentLink: documentTarget !== undefined,
        ...(documentTarget === undefined ? {} : { documentTarget }),
        ...(literal ? { literal: true } : {})
      });
    }
  };
  const visit = (current: MarkdownAstNode, activeLink?: { start: number; documentTarget?: string }): void => {
    if (current.type === "text") {
      append(current.value ?? "", activeLink?.start, activeLink?.documentTarget);
      return;
    }
    if (current.type === "inlineCode") {
      append(current.value ?? "", activeLink?.start, activeLink?.documentTarget, true);
      return;
    }
    if (current.type === "break") {
      append(" ", activeLink?.start, activeLink?.documentTarget);
      return;
    }
    if (current.type === "image") {
      append(current.alt ?? "", activeLink?.start, activeLink?.documentTarget);
      return;
    }
    if (current.type === "html") {
      const html = current.value ?? "";
      if (!html.trimStart().startsWith("<!--")) {
        append(html.replace(/<[^>]*>/g, " "), activeLink?.start, activeLink?.documentTarget);
      }
      return;
    }
    if (current.type === "footnoteReference") {
      append(current.label ?? "", activeLink?.start, activeLink?.documentTarget);
      return;
    }
    if (current.type === "link") {
      const offset = current.position?.start.offset;
      const documentTarget =
        current.url !== undefined && isDocumentTarget(current.url) && !/#L\d+(?:-L\d+)?$/.test(current.url)
          ? current.url
          : undefined;
      const next =
        offset === undefined
          ? activeLink
          : {
              start: offset,
              ...(documentTarget === undefined ? {} : { documentTarget })
            };
      for (const child of current.children ?? []) visit(child, next);
      return;
    }
    for (const child of current.children ?? []) visit(child, activeLink);
  };
  visit(node);

  const normalized: RenderedUnit[] = [];
  for (const unit of rendered) {
    if (/\s/u.test(unit.value)) {
      const prior = normalized.at(-1);
      if (prior?.value === " ") continue;
      normalized.push({ ...unit, value: " " });
    } else {
      normalized.push(unit);
    }
  }
  while (normalized[0]?.value === " ") normalized.shift();
  while (normalized.at(-1)?.value === " ") normalized.pop();
  return normalized;
}

interface AssertionRange {
  readonly start: number;
  readonly end: number;
  /**
   * Only a grammatically interrogative span is citation-exempt. Declarative
   * premises before a final question, and rhetorical declaratives that merely
   * end in a question mark, remain material.
   */
  readonly question: boolean;
}

const INTERROGATIVE_PREFIX =
  /^(?:(?:maintenance\s+)?question:\s*)?(?:(?:for|with|if)\b[^?;]{0,240},\s*)?(?:what|when|where|which|who|whom|whose|why|how|should|can|could|would|will|do|does|did|is|are|was|were|has|have|had|may|might|must)\b/iu;

function assertionGrammarText(units: readonly RenderedUnit[]): string {
  return units.map((unit) => (unit.literal ? (/\s/u.test(unit.value) ? " " : "x") : unit.value)).join("");
}

function assertionRanges(value: string, grammarValue = value): AssertionRange[] {
  if (grammarValue.length !== value.length) throw new Error("assertion grammar mask must preserve text offsets");
  const result: AssertionRange[] = [];
  let sentenceOffset = 0;
  for (const sentence of grammarValue.matchAll(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)) {
    const sentenceStart = sentence.index ?? sentenceOffset;
    const sentenceEnd = sentenceStart + sentence[0].length;
    const sentenceValue = value.slice(sentenceStart, sentenceEnd);
    const sentenceGrammar = grammarValue.slice(sentenceStart, sentenceEnd);
    const sentenceQuestion = /\?\s*$/u.test(sentenceGrammar);
    const sentenceBeginsInterrogative = INTERROGATIVE_PREFIX.test(sentenceGrammar.trimStart());
    sentenceOffset = sentenceEnd;
    const boundaries = [
      ...sentenceGrammar.matchAll(
        /;\s+|(?:\s+[—–]\s+)|,\s+(?=(?:(?:maintenance\s+)?question:\s*)?(?:what|when|where|which|who|whom|whose|why|how|should|can|could|would|will|do|does|did|is|are|was|were|has|have|had|may|might|must)\b)|,\s+(?:(?:but|while|whereas|although|though|yet|and|or)\s+)/gi
      )
    ].map((match) => ({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length
    }));
    let localStart = 0;
    let questionContinuation = sentenceBeginsInterrogative;
    for (const boundary of [...boundaries, { start: sentenceValue.length, end: sentenceValue.length }]) {
      let start = localStart;
      let end = boundary.start;
      while (start < end && /\s/u.test(sentenceValue[start]!)) start += 1;
      while (end > start && /\s/u.test(sentenceValue[end - 1]!)) end -= 1;
      const conjunction = /^(?:but|while|whereas|although|though|yet|and|or)\s+/i.exec(sentenceValue.slice(start, end));
      if (conjunction) start += conjunction[0].length;
      const clause = sentenceGrammar.slice(start, end).trimStart();
      const clauseBeginsInterrogative = INTERROGATIVE_PREFIX.test(clause);
      const question = sentenceQuestion && (questionContinuation || clauseBeginsInterrogative);
      if (clauseBeginsInterrogative) questionContinuation = true;
      if (start < end) result.push({ start: sentenceStart + start, end: sentenceStart + end, question });
      localStart = boundary.end;
    }
  }
  return result;
}

function normalizedClaimSpan(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function normalizedEvidenceLink(
  whole: string,
  label: string,
  originalTarget: string,
  normalizedTarget: string
): string {
  if (originalTarget === normalizedTarget) return whole;
  if (citationMarkerLabel(label) !== originalTarget) return `[${label}](${normalizedTarget})`;
  const codeMarker = /^(`+)[\s\S]*\1$/.exec(label.trim());
  const normalizedLabel = codeMarker
    ? `${codeMarker[1]}${normalizedTarget}${codeMarker[1]}`
    : normalizedTarget.replace(/([\\[\]])/g, "\\$1");
  return `[${normalizedLabel}](${normalizedTarget})`;
}

const DOCUMENT_LINK_TOKEN = "<context-document>";
const DOCUMENT_LINK_LIST = String.raw`${DOCUMENT_LINK_TOKEN}(?:\s*(?:[,;·|/]\s*(?:(?:and|or)\s+)?|(?:and|or)\s+)${DOCUMENT_LINK_TOKEN})*`;
const DOCUMENT_TITLE_FUNCTION_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with"
]);
const DOCUMENT_TITLE_QUALIFIERS = new Set([
  "api",
  "application",
  "architecture",
  "authorization",
  "codebase",
  "configure",
  "context",
  "contracts",
  "dashboard",
  "debug",
  "dependency",
  "deploy",
  "design",
  "diagnose",
  "extend",
  "findings",
  "flow",
  "flows",
  "guide",
  "health",
  "maintain",
  "manage",
  "migrate",
  "operate",
  "operational",
  "operations",
  "overview",
  "platform",
  "planning",
  "postgres",
  "postgresql",
  "project",
  "recover",
  "reference",
  "renewal",
  "repository",
  "review",
  "runbook",
  "runtime",
  "semantics",
  "service",
  "system",
  "tenant",
  "test",
  "trace",
  "troubleshoot",
  "understand",
  "wide",
  "worker",
  "workflow",
  "write"
]);
const DOCUMENT_NAVIGATION_PATTERNS = [
  new RegExp(String.raw`^${DOCUMENT_LINK_LIST}[.!]?$`, "u"),
  new RegExp(String.raw`^(?:see|see also|read|read also)\s+${DOCUMENT_LINK_LIST}[.!]?$`, "u"),
  new RegExp(String.raw`^read this alongside\s+${DOCUMENT_LINK_LIST}[.!]?$`, "u"),
  new RegExp(
    String.raw`^for (?:more|further) (?:context|details|documentation|reading),?\s+(?:see|read)\s+${DOCUMENT_LINK_LIST}[.!]?$`,
    "u"
  ),
  new RegExp(
    String.raw`^(?:navigation|related pages?|next|previous|back|overview)(?: (?:context|documentation|reading|links?))?:?\s+${DOCUMENT_LINK_LIST}[.!]?$`,
    "u"
  )
] as const;

function documentTitleWords(value: string): string[] {
  return [...value.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map((match) => match[0]);
}

/**
 * A document link is navigation only when its visible text is recognizably a
 * concise title for its target. Arbitrary prose cannot become non-material
 * merely by wrapping it in a `.md` link.
 *
 * Requiring target-name overlap is deliberately conservative. The small
 * qualifier vocabulary covers conventional engineering titles while unknown
 * words fail closed and require the author to use a clearer title.
 */
function isConventionalDocumentTitle(label: string, target: string): boolean {
  if (label.length > 100 || /[.!?;]\s*$/u.test(label.trim())) return false;
  const targetPath = (target.split("#")[0] ?? target).replace(/\.md$/i, "");
  const targetName = targetPath.split("/").at(-1) ?? targetPath;
  const targetPathWords = new Set(documentTitleWords(targetPath));
  const targetWords = documentTitleWords(targetName).filter((word) => !DOCUMENT_TITLE_FUNCTION_WORDS.has(word));
  const labelWords = documentTitleWords(label);
  const labelContentWords = labelWords.filter((word) => !DOCUMENT_TITLE_FUNCTION_WORDS.has(word));
  if (targetWords.length === 0 || labelContentWords.length === 0 || labelContentWords.length > 10) return false;

  const targetWordSet = new Set(targetWords);
  const overlap = new Set(labelContentWords.filter((word) => targetWordSet.has(word)));
  // Clause splitting can isolate any part of a conventional linked title. One
  // exact target word is sufficient only because every remaining word must
  // still belong to the target path or the closed engineering-title grammar.
  if (overlap.size < 1) return false;
  return labelContentWords.every(
    (word) => targetWordSet.has(word) || targetPathWords.has(word) || DOCUMENT_TITLE_QUALIFIERS.has(word)
  );
}

/**
 * Recognizes only conventional prose that points at Context documents.
 *
 * This intentionally uses a closed grammar rather than a navigation-word bag:
 * adding any explanation, behavior, reason, or other assertion outside the
 * document links makes the whole span material again.
 */
function isPureDocumentNavigation(units: readonly RenderedUnit[]): boolean {
  if (!units.some((unit) => unit.documentLink)) return false;
  let skeleton = "";
  for (let index = 0; index < units.length;) {
    const unit = units[index]!;
    if (unit.documentLink && unit.documentTarget !== undefined) {
      const linkStart = unit.linkStart;
      let end = index + 1;
      while (
        end < units.length &&
        units[end]?.documentLink === true &&
        units[end]?.documentTarget === unit.documentTarget &&
        units[end]?.linkStart === linkStart
      ) {
        end += 1;
      }
      const label = units
        .slice(index, end)
        .map((candidate) => candidate.value)
        .join("");
      skeleton += isConventionalDocumentTitle(label, unit.documentTarget) ? DOCUMENT_LINK_TOKEN : label;
      index = end;
      continue;
    }
    skeleton += unit.value;
    index += 1;
  }
  const normalized = skeleton.toLowerCase().replace(/\s+/g, " ").trim();
  return DOCUMENT_NAVIGATION_PATTERNS.some((pattern) => pattern.test(normalized));
}

function claimClassification(
  units: readonly RenderedUnit[],
  start: number,
  end: number,
  tableHeader: boolean,
  navigationRow: boolean,
  question: boolean
): MarkdownMaterialClaim["classification"] {
  if (tableHeader || question) return "non_factual";
  if (navigationRow) return "navigation";
  const selected = units.slice(start, end);
  const text = selected
    .map((unit) => unit.value)
    .join("")
    .trim();
  if (/^(?:navigation|related pages?):?\s*$/iu.test(text)) return "navigation";
  if (isPureDocumentNavigation(selected)) return "navigation";
  return "material";
}

function claimCandidates(source: string): ClaimCandidate[] {
  const root = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()]
  }) as MarkdownAstNode;
  const candidates: ClaimCandidate[] = [];
  let summaryAssigned = false;
  const citationOnlyLinkStarts = new Set<number>();
  for (const match of source.matchAll(LINK_PATTERN)) {
    const label = match[1]?.trim();
    const target = match[2]?.trim();
    const start = match.index;
    // A fully linked natural-language sentence is itself a claim. Only the
    // conventional path-as-label form is a citation marker for the preceding
    // sentence; otherwise adjacent linked claims would be collapsed together.
    const locationLabel = label === undefined ? undefined : citationMarkerLabel(label);
    if (start !== undefined && locationLabel !== undefined && target !== undefined && locationLabel === target) {
      citationOnlyLinkStarts.add(start);
    }
  }

  const addUnits = (
    units: readonly RenderedUnit[],
    kind: MarkdownMaterialClaim["kind"],
    options: { readonly tableHeader?: boolean; readonly navigationRow?: boolean; readonly summary?: boolean } = {}
  ): void => {
    const claimUnits = units.map((unit) =>
      unit.linkStart !== undefined && citationOnlyLinkStarts.has(unit.linkStart)
        ? { value: " ", documentLink: false }
        : unit
    );
    const plain = claimUnits.map((unit) => unit.value).join("");
    if (!/[\p{L}\p{N}]/u.test(plain)) return;
    const summary = options.summary === true && !summaryAssigned;
    if (summary) summaryAssigned = true;
    const ranges = assertionRanges(plain, assertionGrammarText(claimUnits));
    const ordinaryEvidence = ranges.map((range) =>
      units
        .slice(range.start, range.end)
        .some((unit) => unit.linkStart !== undefined && !citationOnlyLinkStarts.has(unit.linkStart))
    );
    const markerSpans: { readonly start: number; readonly end: number; readonly linkStart: number }[] = [];
    for (let start = 0; start < units.length;) {
      const linkStart = units[start]?.linkStart;
      if (linkStart === undefined || !citationOnlyLinkStarts.has(linkStart)) {
        start += 1;
        continue;
      }
      let end = start + 1;
      while (end < units.length && units[end]?.linkStart === linkStart) end += 1;
      markerSpans.push({ start, end, linkStart });
      start = end;
    }

    const markerStartsByClaimEnd = new Map<number, number[]>();
    for (const marker of markerSpans) {
      let claimEnd = -1;
      for (const [rangeIndex, range] of ranges.entries()) {
        const beforeMarker = plain.slice(range.start, marker.start);
        const afterMarker = plain.slice(marker.end, range.end);
        if (
          marker.start >= range.start &&
          marker.end <= range.end &&
          /[\p{L}\p{N}]/u.test(beforeMarker) &&
          !/[\p{L}\p{N}]/u.test(afterMarker)
        ) {
          claimEnd = rangeIndex;
          break;
        }
        if (range.end <= marker.start && !plain.slice(range.end, marker.start).trim()) claimEnd = rangeIndex;
      }
      if (claimEnd < 0) continue;
      const markerStarts = markerStartsByClaimEnd.get(claimEnd) ?? [];
      markerStarts.push(marker.linkStart);
      markerStartsByClaimEnd.set(claimEnd, markerStarts);
    }

    const trailingGroups = new Map<number, { readonly claimEnd: number; readonly markerStarts: readonly number[] }>();
    const groupedRanges = new Set<number>();
    for (const [claimEnd, markerStarts] of markerStartsByClaimEnd) {
      let claimStart = claimEnd;
      const claimEndText = plain.slice(ranges[claimEnd]!.start, ranges[claimEnd]!.end).trim();
      if (/[.!?][”’"'`)\]]*$/u.test(claimEndText)) {
        while (claimStart > 0 && !ordinaryEvidence[claimStart - 1] && !markerStartsByClaimEnd.has(claimStart - 1)) {
          const prior = ranges[claimStart - 1]!;
          const priorText = plain.slice(prior.start, prior.end).trim();
          if (/[.!?][”’"'`)\]]*$/u.test(priorText)) break;
          claimStart -= 1;
        }
      }
      const existing = trailingGroups.get(claimStart);
      trailingGroups.set(claimStart, {
        claimEnd: Math.max(existing?.claimEnd ?? claimEnd, claimEnd),
        markerStarts: [...(existing?.markerStarts ?? []), ...markerStarts]
      });
      for (let index = claimStart + 1; index <= claimEnd; index += 1) groupedRanges.add(index);
    }
    for (const [rangeIndex, range] of ranges.entries()) {
      if (groupedRanges.has(rangeIndex)) continue;
      const trailingGroup = trailingGroups.get(rangeIndex);
      const claimEndRange = trailingGroup ? ranges[trailingGroup.claimEnd]! : range;
      const text = normalizedClaimSpan(plain.slice(range.start, claimEndRange.end));
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
      candidates.push({
        text,
        kind,
        classification: claimClassification(
          units,
          range.start,
          claimEndRange.end,
          options.tableHeader === true,
          options.navigationRow === true,
          range.question
        ),
        linkStarts: [
          ...new Set(
            units
              .slice(range.start, claimEndRange.end)
              .map((unit) => unit.linkStart)
              .filter((offset): offset is number => offset !== undefined)
              .concat(trailingGroup?.markerStarts ?? [])
          )
        ],
        summary
      });
    }
  };
  const add = (
    node: MarkdownAstNode,
    kind: MarkdownMaterialClaim["kind"],
    options: { readonly tableHeader?: boolean; readonly navigationRow?: boolean; readonly summary?: boolean } = {}
  ): void => addUnits(renderedClaimUnits(node), kind, options);

  const visit = (node: MarkdownAstNode, ancestors: readonly MarkdownAstNode[]): void => {
    if (node.type === "table") {
      for (const [rowIndex, row] of (node.children ?? []).entries()) {
        const cellUnits = (row.children ?? []).map(renderedClaimUnits);
        for (const units of cellUnits) {
          const hasDocumentLink = units.some((unit) => unit.documentLink);
          const hasEvidenceLink = units.some((unit) => unit.linkStart !== undefined && !unit.documentLink);
          const navigationCell = rowIndex > 0 && hasDocumentLink && !hasEvidenceLink && isPureDocumentNavigation(units);
          addUnits(units, "table_cell", { tableHeader: rowIndex === 0, navigationRow: navigationCell });
        }
      }
      return;
    }
    if (node.type === "paragraph") {
      const listItem = ancestors.some((ancestor) => ancestor.type === "listItem");
      const units = renderedClaimUnits(node);
      const plain = units.map((unit) => unit.value).join("");
      if (!listItem && /^\s*\|/.test(plain) && (plain.match(/\|/g)?.length ?? 0) >= 2) {
        const boundaries = units
          .map((unit, index) => (unit.value === "|" ? index : undefined))
          .filter((index): index is number => index !== undefined);
        for (let index = 0; index < boundaries.length - 1; index += 1) {
          const start = boundaries[index];
          const end = boundaries[index + 1];
          if (start === undefined || end === undefined) continue;
          addUnits(units.slice(start + 1, end), "table_cell");
        }
        return;
      }
      add(node, listItem ? "list_item" : "sentence", { summary: !listItem });
      return;
    }
    if (node.type === "heading" || node.type === "code" || node.type === "yaml" || node.type === "toml") return;
    for (const child of node.children ?? []) visit(child, [...ancestors, node]);
  };
  visit(root, []);
  return candidates;
}

function materialClaimIdentity(
  documentPath: string,
  kind: MarkdownMaterialClaim["kind"],
  text: string,
  occurrence: number
): string {
  return `claim_${createHash("sha256")
    .update(`${documentPath}\u0000${kind}\u0000${text}\u0000${occurrence}`)
    .digest("hex")
    .slice(0, 20)}`;
}

/**
 * Normalizes source locations emitted from a derivation workspace.
 *
 * Research reports conventionally describe a location as `path.ts:12-18`, and
 * agents sometimes preserve either that notation or the sandbox's
 * `/.../repository/path.ts` prefix in the Markdown they write. Neither should
 * leak into public context. The durable form is repository-root-relative and
 * uses GitHub's line fragment, which both the verifier and dashboard understand.
 */
export function normalizeMarkdownEvidenceTargets(source: string): string {
  return source.replace(LINK_PATTERN, (whole, label: string, target: string) => {
    if (/^https:\/\/github\.com\//i.test(target)) return whole;
    const lineFragment = /#L\d+(?:-L\d+)?$/.exec(target);
    if (lineFragment) {
      const path = normalizedRepositoryWorkspacePath(target.slice(0, lineFragment.index));
      return normalizedEvidenceLink(whole, label, target, `${path}${lineFragment[0]}`);
    }
    const range = TRAILING_LINE_RANGE_PATTERN.exec(target);
    if (!range) return whole;
    const path = normalizedRepositoryWorkspacePath(target.slice(0, range.index));
    if (
      !path ||
      path.startsWith("/") ||
      path.split("/").some((segment) => segment === ".." || segment === "" || segment === ".")
    ) {
      return whole;
    }
    const startLine = Number(range[1]);
    const endLine = range[2] === undefined ? startLine : Number(range[2]);
    if (startLine < 1 || endLine < startLine) return whole;
    return normalizedEvidenceLink(
      whole,
      label,
      target,
      `${path}#L${startLine}${endLine === startLine ? "" : `-L${endLine}`}`
    );
  });
}

function normalizedRepositoryWorkspacePath(value: string): string {
  let path = value.replaceAll("\\", "/");
  const portableCheckoutMarker = "/repository/additional/0/";
  const portableCheckoutIndex = path.lastIndexOf(portableCheckoutMarker);
  if (portableCheckoutIndex >= 0) {
    return path.slice(portableCheckoutIndex + portableCheckoutMarker.length);
  }
  path = path.replace(/^(?:\.\.\/)*repository\/additional\/0\//, "");
  path = path.replace(/^(?:\.\.\/)*additional\/0\//, "");
  const repositoryMarker = path.lastIndexOf("/repository/");
  if (repositoryMarker >= 0) {
    path = path.slice(repositoryMarker + "/repository/".length);
  } else {
    path = path.replace(/^(?:\.\.\/)+repository\//, "").replace(/^\.\//, "");
  }
  return path;
}

function normalizedEvidenceText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Moves a repository citation to the smallest nearby range that contains its
 * exact visible claim. This is a deterministic repair for reports that record
 * the beginning of a definition or comment instead of the claim's precise line.
 * It never changes the claim or path and leaves unsupported links untouched for
 * the normal fail-closed verifier.
 */
export function alignMarkdownEvidenceTargets(source: string, contentByPath: ReadonlyMap<string, string>): string {
  return normalizeMarkdownEvidenceTargets(source).replace(LINK_PATTERN, (whole, label: string, target: string) => {
    if (/^https:\/\/github\.com\//i.test(target)) return whole;
    const hash = target.indexOf("#");
    const range = hash < 0 ? null : LINE_RANGE_PATTERN.exec(target.slice(hash));
    if (!range) return whole;
    const path = target.slice(0, hash);
    const content = contentByPath.get(path);
    const claim = normalizedEvidenceText(label);
    if (!content || claim.length < 8) return whole;
    const lines = content.split(/\r?\n/);
    const originalStart = Number(range[1]);
    const originalEnd = range[2] === undefined ? originalStart : Number(range[2]);
    const originalExcerpt = lines.slice(originalStart - 1, originalEnd).join("\n");
    if (normalizedEvidenceText(originalExcerpt).includes(claim)) return whole;

    const candidates: { startLine: number; endLine: number }[] = [];
    // Exact source phrases used as labels normally span a comment or one
    // expression. A twelve-line bound avoids "repairing" a vague claim by
    // attaching it to a distant occurrence inside a broad construct.
    for (let start = 0; start < lines.length; start += 1) {
      let window = "";
      for (let end = start; end < Math.min(lines.length, start + 12); end += 1) {
        window = `${window} ${lines[end] ?? ""}`;
        if (normalizedEvidenceText(window).includes(claim)) {
          candidates.push({ startLine: start + 1, endLine: end + 1 });
          break;
        }
      }
    }
    const best = candidates.sort(
      (left, right) =>
        left.endLine - left.startLine - (right.endLine - right.startLine) ||
        Math.abs(left.startLine - originalStart) - Math.abs(right.startLine - originalStart) ||
        left.startLine - right.startLine
    )[0];
    if (!best) return whole;
    return `[${label}](${path}#L${best.startLine}${best.endLine === best.startLine ? "" : `-L${best.endLine}`})`;
  });
}

function isDocumentTarget(target: string): boolean {
  return target.endsWith(".md") || target.includes(".md#");
}

export function parseMarkdownDocument(documentPath: string, source: string): ParsedMarkdownDocument {
  source = normalizeMarkdownEvidenceTargets(source);
  const documentLinks: MarkdownDocumentLink[] = [];
  const evidenceLinks: MarkdownEvidenceLink[] = [];
  const evidenceByLinkStart = new Map<number, MarkdownEvidenceLink>();
  const citationOccurrences = new Map<string, number>();
  const candidates = claimCandidates(source);
  const claimSpanByLinkStart = new Map<number, string>();
  for (const candidate of candidates) {
    for (const start of candidate.linkStarts) claimSpanByLinkStart.set(start, candidate.text);
  }

  for (const match of source.matchAll(LINK_PATTERN)) {
    const text = match[1]!.trim();
    const target = match[2]!;
    const start = match.index ?? 0;
    if (!isRenderedMarkdownLink(source, start)) continue;
    const claimSpan = claimSpanByLinkStart.get(start) ?? containingClaimSpan(source, start, start + match[0].length);
    const identityKey = `${target}\u0000${claimSpan}`;
    const occurrence = (citationOccurrences.get(identityKey) ?? 0) + 1;
    citationOccurrences.set(identityKey, occurrence);
    const citationId = citationIdentity(documentPath, target, claimSpan, occurrence);
    if (/^https:\/\/github\.com\//i.test(target)) {
      const link = { citationId, claim: text, claimSpan, providerUrl: target };
      evidenceLinks.push(link);
      evidenceByLinkStart.set(start, link);
      continue;
    }
    const hash = target.indexOf("#");
    const range = hash < 0 ? null : LINE_RANGE_PATTERN.exec(target.slice(hash));
    if (range) {
      const startLine = Number(range[1]);
      const endLine = range[2] === undefined ? startLine : Number(range[2]);
      // A backwards or zero range is not a reference to anything; dropping it here
      // keeps the verifier's diagnostics about evidence rather than about syntax.
      if (startLine < 1 || endLine < startLine) continue;
      const link = {
        citationId,
        claim: text,
        claimSpan,
        path: target.slice(0, hash),
        startLine,
        endLine
      };
      evidenceLinks.push(link);
      evidenceByLinkStart.set(start, link);
      continue;
    }
    if (isDocumentTarget(target)) {
      documentLinks.push({ text, target });
    }
  }

  const diagnostics = parseDiagnostics(source);
  const heading = /^#\s+(.+)$/m.exec(source);
  const fallback = documentPath.split("/").at(-1) ?? documentPath;
  const claimOccurrences = new Map<string, number>();
  const materialClaims = candidates.map((candidate): MarkdownMaterialClaim => {
    const key = `${candidate.kind}\u0000${candidate.text}`;
    const occurrence = (claimOccurrences.get(key) ?? 0) + 1;
    claimOccurrences.set(key, occurrence);
    return {
      claimId: materialClaimIdentity(documentPath, candidate.kind, candidate.text, occurrence),
      text: candidate.text,
      kind: candidate.kind,
      classification: candidate.classification,
      citationIds: [
        ...new Set(
          candidate.linkStarts
            .map((start) => evidenceByLinkStart.get(start)?.citationId)
            .filter((citationId): citationId is string => citationId !== undefined)
        )
      ],
      summary: candidate.summary
    };
  });
  return {
    documentPath,
    title: heading ? heading[1]!.trim() : fallback,
    bodyMarkdown: source,
    documentLinks,
    evidenceLinks,
    materialClaims,
    diagnostics
  };
}

/**
 * Returns section-level evidence coverage without turning every explanatory
 * sentence into a publication gate.
 *
 * A substantive H2-H6 section must contain at least one rendered citation in
 * one of its factual assertions. Nested sections count toward their parent, but
 * are also returned independently so a deep section cannot hide behind an
 * unrelated source at the top of the page. Questions and pure navigation do
 * not make a section substantive.
 */
export function markdownEvidenceSections(source: string, documentPath = ""): MarkdownEvidenceSection[] {
  source = normalizeMarkdownEvidenceTargets(source);
  const document = parseMarkdownDocument(documentPath, source);
  const materialCitationIds = new Set(
    document.materialClaims.filter((claim) => claim.classification === "material").flatMap((claim) => claim.citationIds)
  );
  const evidenceOffsets: { readonly offset: number; readonly citationId: string }[] = [];
  let evidenceIndex = 0;
  for (const match of source.matchAll(LINK_PATTERN)) {
    const offset = match.index ?? 0;
    if (!isRenderedMarkdownLink(source, offset)) continue;
    const target = match[2]!;
    let isEvidence = /^https:\/\/github\.com\//i.test(target);
    if (!isEvidence) {
      const hash = target.indexOf("#");
      const range = hash < 0 ? null : LINE_RANGE_PATTERN.exec(target.slice(hash));
      if (range) {
        const startLine = Number(range[1]);
        const endLine = range[2] === undefined ? startLine : Number(range[2]);
        isEvidence = startLine >= 1 && endLine >= startLine;
      }
    }
    if (!isEvidence) continue;
    const link = document.evidenceLinks[evidenceIndex];
    evidenceIndex += 1;
    if (link) evidenceOffsets.push({ offset, citationId: link.citationId });
  }
  const root = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()]
  }) as MarkdownAstNode;
  const headings = (root.children ?? []).filter(
    (node) =>
      node.type === "heading" &&
      (node.depth ?? 0) >= 2 &&
      (node.depth ?? 0) <= 6 &&
      node.position?.start.offset !== undefined &&
      node.position?.end.offset !== undefined
  );
  return headings.map((heading, index) => {
    const level = heading.depth!;
    const start = heading.position!.end.offset!;
    const next = headings.slice(index + 1).find((candidate) => (candidate.depth ?? 7) <= level);
    const end = next?.position?.start.offset ?? source.length;
    const body = source.slice(start, end);
    const parsed = parseMarkdownDocument("", body);
    const substantiveClaims = parsed.materialClaims.filter((claim) => claim.classification === "material");
    return {
      heading: renderedClaimUnits(heading)
        .map((unit) => unit.value)
        .join("")
        .trim(),
      level,
      line: heading.position?.start.line ?? 1,
      substantiveClaimCount: substantiveClaims.length,
      citationIds: [
        ...new Set(
          evidenceOffsets
            .filter(({ offset, citationId }) => offset >= start && offset < end && materialCitationIds.has(citationId))
            .map(({ citationId }) => citationId)
        )
      ]
    };
  });
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
