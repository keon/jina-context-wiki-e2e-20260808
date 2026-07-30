import type { EvidenceAnchor, RefManifestEntry } from "../domain/evidence.js";
import { mapMarkdownCatalog, type MarkdownCatalogProblem } from "./markdown-catalog.js";
import {
  markdownEvidenceSections,
  type MarkdownEvidenceLink,
  type MarkdownStatement,
  type ParsedMarkdownDocument
} from "./markdown-document.js";
import type { KnowledgeGenerationOutput } from "../domain/knowledge.js";
import type { ContextOrchestrationState } from "./orchestration.js";

/**
 * Turns a Markdown folder into the output shape the rest of derivation already
 * consumes.
 *
 * Converting here rather than teaching the store about Markdown is what keeps
 * the change contained. In natural-label mode, the stored citation claim is a
 * deterministic exact source anchor while the public link label remains normal
 * prose. A separately certified claim audit binds the surrounding public claim
 * span to that immutable evidence.
 *
 * The manifest is what makes an inline link citable: a link names a path, and a
 * citation needs the blob that path resolves to at this exact checkpoint.
 */

export interface MarkdownOutputProblem {
  readonly documentPath: string;
  readonly reason:
    | MarkdownCatalogProblem["reason"]
    | "unknown-path"
    | "claim-absent"
    | "no-citable-evidence"
    | "ungrounded-section"
    | "uncited-summary"
    | "incomplete-document";
  /**
   * The link that could not be used, when the problem is about one.
   *
   * A page withheld for citing nothing usable is only actionable if the report
   * says what it cited: three runbooks were dropped for twenty-four unknown
   * paths, and without the paths there was no way to tell a manifest that was
   * missing files from an agent that invented them.
   */
  readonly target?: string;
  readonly claim?: string;
}

export interface MarkdownOutputConversion {
  readonly output: KnowledgeGenerationOutput;
  readonly problems: readonly MarkdownOutputProblem[];
}

/** Confidence is not asserted per document in Markdown, so it is uniform and honest. */
const MARKDOWN_CONFIDENCE = 0.8;

/**
 * Detects the common durable-file failure mode: a worker exits while its last
 * write is only a syntactically plausible prefix. Stabilized byte size cannot
 * distinguish that from a finished page.
 */
function documentEndsCompletely(body: string): boolean {
  const trimmed = body.trimEnd();
  if (!trimmed) return false;
  const fences = trimmed.match(/^(?:```|~~~)/gm)?.length ?? 0;
  if (fences % 2 !== 0) return false;
  const last = trimmed.split(/\r?\n/).at(-1)?.trim() ?? "";
  if (!last || /^#{1,6}\s/.test(last) || /^[-*+]\s*$/.test(last)) return false;
  // Context pages are prose. A substantial final line ending in a bare word is
  // usually exactly what a killed patch leaves behind; short labels remain OK.
  if (/[\p{L}\p{N}]$/u.test(last) && last.split(/\s+/).length >= 4) return false;
  return true;
}

interface CitedStatement {
  text: string;
  citationOrdinals: number[];
  confidence: number;
}

function statementsFor(
  statements: readonly MarkdownStatement[],
  ordinalOf: (link: MarkdownEvidenceLink) => number | undefined
): CitedStatement[] {
  const cited: CitedStatement[] = [];
  for (const statement of statements) {
    const ordinals = statement.evidence
      .map((link) => ordinalOf(link))
      .filter((ordinal): ordinal is number => ordinal !== undefined);
    // A statement with no resolved evidence is prose, not a cited diagnostic, and
    // the schema requires at least one ordinal. Dropping it keeps the diagnostic
    // groups trustworthy rather than padding them.
    if (ordinals.length === 0) continue;
    cited.push({ text: statement.text, citationOrdinals: [...new Set(ordinals)], confidence: MARKDOWN_CONFIDENCE });
  }
  return cited;
}

export function markdownCatalogToOutput(
  documents: readonly ParsedMarkdownDocument[],
  repository: string,
  manifest: readonly RefManifestEntry[],
  /**
   * Whether the checkpoint actually says what a link claims.
   *
   * Supplied where the checked-out files are readable. A link that fails is
   * dropped rather than carried forward, because the host validator rejects the
   * whole document over one unverifiable claim — so an agent that cites nine
   * things and gets one wrong published nothing at all. Dropping keeps the eight
   * that hold, and a document left with no citation is withheld anyway.
   */
  supports?: (link: MarkdownEvidenceLink) => boolean | string,
  providerEvidence: readonly {
    readonly body: string;
    readonly anchor: EvidenceAnchor;
  }[] = [],
  /**
   * Document paths the agent moved into the retired directory.
   *
   * Under the file contract an untouched page is carried forward, so deleting
   * one has to be said out loud rather than shown by absence. These are the
   * pages it said to drop.
   */
  retiredDocumentPaths: readonly string[] = [],
  orchestration?: ContextOrchestrationState,
  options: {
    /** Public link labels are navigation prose; source semantics are audit-certified. */
    readonly naturalEvidenceLabels?: boolean;
  } = {}
): MarkdownOutputConversion {
  const blobByPath = new Map(
    manifest.filter((entry) => entry.contentAvailable).map((entry) => [entry.path, entry.blobSha])
  );
  const byPath = new Map(documents.map((document) => [document.documentPath, document]));
  const { entries, problems: catalogProblems } = mapMarkdownCatalog(documents, repository);
  const problems: MarkdownOutputProblem[] = [...catalogProblems];
  const outputDocuments: KnowledgeGenerationOutput["documents"][number][] = [];

  for (const entry of entries) {
    const parsed = byPath.get(entry.documentPath);
    if (!parsed) continue;
    if (!documentEndsCompletely(parsed.bodyMarkdown)) {
      problems.push({ documentPath: entry.documentPath, reason: "incomplete-document" });
      continue;
    }

    const citations: KnowledgeGenerationOutput["documents"][number]["citations"][number][] = [];
    const ordinals = new Map<string, number>();
    const semanticOrdinals = new Map<string, number[]>();
    let invalidEvidence = false;
    for (const link of parsed.evidenceLinks) {
      if (link.providerUrl) {
        const resolved = resolveProviderLink(link, providerEvidence, options.naturalEvidenceLabels === true);
        if (!resolved) {
          problems.push({
            documentPath: entry.documentPath,
            reason: "claim-absent",
            target: link.providerUrl,
            claim: link.claimSpan.slice(0, 120)
          });
          invalidEvidence = true;
          continue;
        }
        const key = evidenceLinkKey(link);
        if (ordinals.has(key)) continue;
        citations.push({
          claim: resolved.sourceAnchor,
          citationId: link.citationId,
          claimSpan: link.claimSpan,
          sourceType: resolved.anchor.sourceType,
          sourceId: resolved.anchor.sourceId,
          ...(resolved.anchor.pathOrUrl ? { pathOrUrl: resolved.anchor.pathOrUrl } : {}),
          jsonPointer: resolved.jsonPointer
        });
        ordinals.set(key, citations.length);
        const semanticKey = evidenceSemanticKey(link);
        semanticOrdinals.set(semanticKey, [...(semanticOrdinals.get(semanticKey) ?? []), citations.length]);
        continue;
      }
      if (link.path === undefined || link.startLine === undefined || link.endLine === undefined) continue;
      const blobSha = blobByPath.get(link.path);
      if (blobSha === undefined) {
        problems.push({
          documentPath: entry.documentPath,
          reason: "unknown-path",
          target: `${link.path}#L${link.startLine}-L${link.endLine}`,
          claim: link.claim.slice(0, 120)
        });
        invalidEvidence = true;
        continue;
      }
      const support = supports?.(link);
      if (support === false) {
        problems.push({
          documentPath: entry.documentPath,
          reason: "claim-absent",
          target: `${link.path}#L${link.startLine}-L${link.endLine}`,
          claim: link.claimSpan.slice(0, 120)
        });
        invalidEvidence = true;
        continue;
      }
      const key = evidenceLinkKey(link);
      if (ordinals.has(key)) continue;
      citations.push({
        claim: options.naturalEvidenceLabels && typeof support === "string" ? support : link.claim,
        citationId: link.citationId,
        claimSpan: link.claimSpan,
        sourceType: "blob",
        sourceId: blobSha,
        pathOrUrl: link.path,
        startLine: link.startLine,
        endLine: link.endLine
      });
      ordinals.set(key, citations.length);
      const semanticKey = evidenceSemanticKey(link);
      semanticOrdinals.set(semanticKey, [...(semanticOrdinals.get(semanticKey) ?? []), citations.length]);
    }

    // A page is the atomic validation and publication unit. Keeping its valid
    // links while silently dropping a bad one would leave unsupported prose in
    // the published body, so the whole page is withheld for repair.
    if (invalidEvidence) continue;

    for (const section of markdownEvidenceSections(parsed.bodyMarkdown, parsed.documentPath)) {
      if (section.substantiveClaimCount === 0) continue;
      if (section.citationIds.some((citationId) => ordinals.has(citationId))) continue;
      problems.push({
        documentPath: entry.documentPath,
        reason: "ungrounded-section",
        claim: section.heading.slice(0, 240)
      });
      invalidEvidence = true;
    }
    if (invalidEvidence) continue;

    // A document with nothing citable cannot be checked against the checkpoint,
    // and publishing an unverifiable page is exactly what separates this from a
    // context that is sometimes confidently wrong.
    if (citations.length === 0) {
      problems.push({ documentPath: entry.documentPath, reason: "no-citable-evidence" });
      continue;
    }

    const ordinalOf = (link: MarkdownEvidenceLink): number | undefined =>
      ordinals.get(evidenceLinkKey(link)) ?? semanticOrdinals.get(evidenceSemanticKey(link))?.[0];
    const summaryCitationOrdinals = [
      ...new Set(
        parsed.materialClaims
          .filter((claim) => claim.summary && claim.classification === "material")
          .flatMap((claim) => claim.citationIds)
          .map((citationId) => ordinals.get(citationId))
          .filter((ordinal): ordinal is number => ordinal !== undefined)
      )
    ].sort((left, right) => left - right);
    if (summaryCitationOrdinals.length === 0) {
      problems.push({
        documentPath: entry.documentPath,
        reason: "uncited-summary",
        claim: entry.summary.slice(0, 240)
      });
      continue;
    }

    const paths = [
      ...new Set(
        citations
          .filter((citation) => citation.sourceType === "blob")
          .map((citation) => citation.pathOrUrl)
          .filter((path): path is string => Boolean(path))
      )
    ];
    const planItem = orchestration?.items.find(
      (item) => item.path.replace(/\.md$/i, "") === entry.documentPath.replace(/\.md$/i, "")
    );
    const pullRequests = [
      ...new Set(
        citations
          .filter((citation) => citation.sourceType === "pull_request")
          .map((citation) => citation.pathOrUrl)
          .filter((url): url is string => Boolean(url))
      )
    ];
    const issues = [
      ...new Set(
        citations
          .filter((citation) => citation.sourceType === "issue")
          .map((citation) => citation.pathOrUrl)
          .filter((url): url is string => Boolean(url))
      )
    ];
    outputDocuments.push({
      logicalId: entry.logicalId,
      kind: entry.kind,
      title: entry.title,
      summary: entry.summary || entry.title,
      summaryCitationOrdinals,
      bodyMarkdown: entry.bodyMarkdown,
      structuredSummary: {
        facts: [],
        questionsAnswered: [],
        diagnostics: {
          symptoms: statementsFor(parsed.diagnostics.symptoms, ordinalOf),
          causes: statementsFor(parsed.diagnostics.causes, ordinalOf),
          checks: statementsFor(parsed.diagnostics.checks, ordinalOf),
          fixes: statementsFor(parsed.diagnostics.fixes, ordinalOf)
        },
        // A conflict-comparable claim is an assertion about one value, which a
        // Markdown page does not single out; omitting both is how the domain type
        // expresses "this document makes no such claim".
        claimCitationOrdinals: []
      },
      // Symbols come from the agent's durable page scope so exact retrieval can
      // find a context page by API/class/function name. Paths and provider
      // identifiers remain citation-derived and therefore checkpoint-valid.
      scope: { paths, symbols: [...(planItem?.scope.symbols ?? [])], pullRequests, issues },
      confidence: MARKDOWN_CONFIDENCE,
      citations
    });
  }

  // A retired page names a logical ID the same way a live one does; only its
  // location differs, so it maps through the same rules rather than a second set.
  const { entries: retiredEntries } = mapMarkdownCatalog(
    retiredDocumentPaths.map((documentPath) => ({
      documentPath,
      title: documentPath,
      summary: "",
      bodyMarkdown: "",
      evidenceLinks: [],
      documentLinks: [],
      materialClaims: [],
      diagnostics: { symptoms: [], causes: [], checks: [], fixes: [] }
    })),
    repository
  );
  const retiredDocuments = [...new Set(retiredEntries.map((entry) => entry.logicalId))].map((logicalId) => ({
    logicalId,
    reason: "retired by the derivation agent"
  }));
  return {
    output: {
      documents: outputDocuments,
      retiredDocuments,
      ...(orchestration ? { orchestration } : {})
    },
    problems
  };
}

function evidenceLinkKey(link: MarkdownEvidenceLink): string {
  return link.citationId;
}

function evidenceSemanticKey(link: MarkdownEvidenceLink): string {
  return [
    link.providerUrl ?? link.path ?? "",
    link.startLine ?? "",
    link.endLine ?? "",
    link.claim,
    link.claimSpan
  ].join("\u0000");
}

function normalizeProviderUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function matchingPointers(value: unknown, claim: string, pointer = ""): string[] {
  const normalizedClaim = claim.toLowerCase().replace(/\s+/g, " ").trim();
  // Keep provider links on the same evidentiary threshold as blob links and the
  // final validator. Without this, labels such as "open" resolve during
  // Markdown conversion and fail only after the repair opportunity has passed.
  if (normalizedClaim.length < 8) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).toLowerCase().replace(/\s+/g, " ").includes(normalizedClaim) ? [pointer || ""] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => matchingPointers(item, claim, `${pointer}/${index}`));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) =>
      matchingPointers(item, claim, `${pointer}/${pointerSegment(key)}`)
    );
  }
  return [];
}

function resolveProviderLink(
  link: MarkdownEvidenceLink,
  evidence: readonly { readonly body: string; readonly anchor: EvidenceAnchor }[],
  naturalEvidenceLabels: boolean
): { anchor: EvidenceAnchor; jsonPointer: string; sourceAnchor: string } | undefined {
  if (!link.providerUrl) return undefined;
  const target = normalizeProviderUrl(link.providerUrl);
  if (!target) return undefined;
  const candidates = evidence.filter((item) => {
    const observed = item.anchor.pathOrUrl ? normalizeProviderUrl(item.anchor.pathOrUrl) : undefined;
    if (observed === target) return true;
    return item.anchor.sourceType === "commit" && target.endsWith(`/commit/${item.anchor.sourceId}`);
  });
  for (const candidate of candidates) {
    try {
      if (naturalEvidenceLabels) {
        const parsed = JSON.parse(candidate.body) as unknown;
        const excerpt = JSON.stringify(parsed);
        const sourceAnchor = exactSourceAnchor(excerpt);
        if (sourceAnchor) return { anchor: candidate.anchor, jsonPointer: "", sourceAnchor };
        continue;
      }
      const pointers = matchingPointers(JSON.parse(candidate.body), link.claim).sort(
        (left, right) => left.length - right.length || left.localeCompare(right)
      );
      const jsonPointer = pointers[0];
      if (jsonPointer !== undefined) {
        const selected = matchingPointerValue(JSON.parse(candidate.body), jsonPointer);
        const sourceAnchor = exactSourceAnchor(typeof selected === "string" ? selected : JSON.stringify(selected));
        if (sourceAnchor) return { anchor: candidate.anchor, jsonPointer, sourceAnchor };
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function exactSourceAnchor(excerpt: string): string | undefined {
  const normalized = excerpt.replace(/\s+/g, " ").trim();
  if (normalized.length < 8) return undefined;
  return normalized.slice(0, 240);
}

function matchingPointerValue(value: unknown, pointer: string): unknown {
  if (!pointer) return value;
  let selected = value;
  for (const encoded of pointer.slice(1).split("/")) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    selected = Array.isArray(selected)
      ? selected[Number(key)]
      : selected && typeof selected === "object"
        ? (selected as Record<string, unknown>)[key]
        : undefined;
  }
  return selected;
}
