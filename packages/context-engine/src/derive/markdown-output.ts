import type { RefManifestEntry } from "../domain/evidence.js";
import { mapMarkdownCatalog, type MarkdownCatalogProblem } from "./markdown-catalog.js";
import type { MarkdownStatement, ParsedMarkdownDocument } from "./markdown-document.js";
import type { KnowledgeGenerationOutput } from "../domain/knowledge.js";

/**
 * Turns a Markdown folder into the output shape the rest of derivation already
 * consumes.
 *
 * Converting here rather than teaching the store about Markdown is what keeps
 * the change contained: the validator still resolves every citation against the
 * checkpoint and still requires each claim to occur verbatim in the range it
 * names, the commit path is untouched, and indexing and retrieval never learn
 * that the format changed. Only the trailing marker rule is dropped, because a
 * Markdown document carries its citations as inline links instead, and the
 * validator takes that as an option rather than inferring it.
 *
 * The manifest is what makes an inline link citable: a link names a path, and a
 * citation needs the blob that path resolves to at this exact checkpoint.
 */

export interface MarkdownOutputProblem {
  readonly documentPath: string;
  readonly reason: MarkdownCatalogProblem["reason"] | "unknown-path" | "no-citable-evidence";
}

export interface MarkdownOutputConversion {
  readonly output: KnowledgeGenerationOutput;
  readonly problems: readonly MarkdownOutputProblem[];
}

/** Confidence is not asserted per document in Markdown, so it is uniform and honest. */
const MARKDOWN_CONFIDENCE = 0.8;

interface CitedStatement {
  text: string;
  citationOrdinals: number[];
  confidence: number;
}

function statementsFor(
  statements: readonly MarkdownStatement[],
  ordinalOf: (path: string, startLine: number, endLine: number) => number | undefined
): CitedStatement[] {
  const cited: CitedStatement[] = [];
  for (const statement of statements) {
    const ordinals = statement.evidence
      .map((link) => ordinalOf(link.path, link.startLine, link.endLine))
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
  manifest: readonly RefManifestEntry[]
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

    const citations: KnowledgeGenerationOutput["documents"][number]["citations"][number][] = [];
    const ordinals = new Map<string, number>();
    for (const link of parsed.evidenceLinks) {
      const blobSha = blobByPath.get(link.path);
      if (blobSha === undefined) {
        problems.push({ documentPath: entry.documentPath, reason: "unknown-path" });
        continue;
      }
      const key = `${link.path}|${link.startLine}|${link.endLine}`;
      if (ordinals.has(key)) continue;
      citations.push({
        claim: link.claim,
        sourceType: "blob",
        sourceId: blobSha,
        pathOrUrl: link.path,
        startLine: link.startLine,
        endLine: link.endLine
      });
      ordinals.set(key, citations.length);
    }

    // A document with nothing citable cannot be checked against the checkpoint,
    // and publishing an unverifiable page is exactly what separates this from a
    // wiki that is sometimes confidently wrong.
    if (citations.length === 0) {
      problems.push({ documentPath: entry.documentPath, reason: "no-citable-evidence" });
      continue;
    }

    const ordinalOf = (path: string, startLine: number, endLine: number): number | undefined =>
      ordinals.get(`${path}|${startLine}|${endLine}`);

    const paths = [
      ...new Set(citations.map((citation) => citation.pathOrUrl).filter((path): path is string => Boolean(path)))
    ];
    outputDocuments.push({
      logicalId: entry.logicalId,
      kind: entry.kind,
      title: entry.title,
      summary: entry.summary || entry.title,
      // The lead paragraph is not itself a cited sentence, so the summary carries
      // the document's first citation rather than inventing one for it.
      summaryCitationOrdinals: [1],
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
      scope: { paths, symbols: [], pullRequests: [], issues: [] },
      confidence: MARKDOWN_CONFIDENCE,
      citations
    });
  }

  return { output: { documents: outputDocuments, retiredDocuments: [] }, problems };
}
