import { evidenceExcerpt, type EvidenceRecord } from "../domain/evidence.js";
import type { MarkdownEvidenceLink, ParsedMarkdownDocument } from "./markdown-document.js";

/**
 * Checks a Markdown catalog against the checkpoint it claims to describe.
 *
 * The format changed; what makes a claim trustworthy did not. An evidence link's
 * text must occur in the exact line range it points at, resolved from the
 * immutable checkpoint — the same containment check the JSON contract applied,
 * against the same evidence.
 *
 * The difference is what happens when it fails. The JSON contract rejected the
 * whole catalog, because a citation was structurally required. A wiki is useful
 * with a broken link in it, so an unsupported reference is reported against the
 * document that carries it and the catalog still lands. Refusing to publish a
 * repository's knowledge because one line range moved is a worse outcome than
 * publishing it with that reference marked.
 */

export interface MarkdownReferenceProblem {
  readonly documentPath: string;
  readonly claim: string;
  readonly target: string;
  readonly reason: "unknown-path" | "invalid-range" | "claim-absent" | "unknown-document";
}

export interface MarkdownVerification {
  /** Evidence links whose claim was found in the range they cite. */
  readonly supported: number;
  readonly problems: readonly MarkdownReferenceProblem[];
  /** Verified links per document, for the share a reader can trust. */
  readonly supportedByDocument: ReadonlyMap<string, number>;
}

export interface MarkdownVerifierInputs {
  /** Path in the checkpoint tree to the evidence record holding that file. */
  readonly evidenceByPath: ReadonlyMap<string, EvidenceRecord>;
  /** Every document path in the catalog, for cross-reference checking. */
  readonly documentPaths: ReadonlySet<string>;
  readonly resolveDocumentLink: (fromDocumentPath: string, target: string) => string | undefined;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The same rule the JSON contract used: the claim must appear inside the cited
 * excerpt, whitespace and case insensitive, and be long enough that containment
 * means something. A three-character claim matches almost any file.
 */
export function evidenceSupportsClaim(claim: string, excerpt: string): boolean {
  const normalizedClaim = normalize(claim);
  return normalizedClaim.length >= 8 && normalize(excerpt).includes(normalizedClaim);
}

function verifyEvidenceLink(
  documentPath: string,
  link: MarkdownEvidenceLink,
  inputs: MarkdownVerifierInputs
): MarkdownReferenceProblem | undefined {
  const target = `${link.path}#L${link.startLine}-L${link.endLine}`;
  const record = inputs.evidenceByPath.get(link.path);
  if (record === undefined) {
    return { documentPath, claim: link.claim, target, reason: "unknown-path" };
  }
  const excerpt = evidenceExcerpt(record, { startLine: link.startLine, endLine: link.endLine });
  if (excerpt === undefined) {
    return { documentPath, claim: link.claim, target, reason: "invalid-range" };
  }
  if (!evidenceSupportsClaim(link.claim, excerpt)) {
    return { documentPath, claim: link.claim, target, reason: "claim-absent" };
  }
  return undefined;
}

export function verifyMarkdownCatalog(
  documents: readonly ParsedMarkdownDocument[],
  inputs: MarkdownVerifierInputs
): MarkdownVerification {
  const problems: MarkdownReferenceProblem[] = [];
  const supportedByDocument = new Map<string, number>();
  let supported = 0;

  for (const document of documents) {
    let documentSupported = 0;
    for (const link of document.evidenceLinks) {
      const problem = verifyEvidenceLink(document.documentPath, link, inputs);
      if (problem) {
        problems.push(problem);
        continue;
      }
      documentSupported += 1;
      supported += 1;
    }
    for (const link of document.documentLinks) {
      const resolved = inputs.resolveDocumentLink(document.documentPath, link.target);
      if (resolved === undefined || !inputs.documentPaths.has(resolved)) {
        problems.push({
          documentPath: document.documentPath,
          claim: link.text,
          target: link.target,
          reason: "unknown-document"
        });
      }
    }
    supportedByDocument.set(document.documentPath, documentSupported);
  }

  return { supported, problems, supportedByDocument };
}
