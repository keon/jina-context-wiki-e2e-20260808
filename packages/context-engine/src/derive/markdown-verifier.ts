import { evidenceExcerpt, type EvidenceRecord } from "../domain/evidence.js";
import type { MarkdownEvidenceLink, ParsedMarkdownDocument } from "./markdown-document.js";

/**
 * Checks a Markdown catalog against the checkpoint it claims to describe.
 *
 * This is the deterministic half of the Markdown evidence contract. It proves
 * that a repository path and focused line range resolve against the immutable
 * checkpoint. A bounded source-aware audit separately decides whether the
 * surrounding claim span is actually supported by the resolved excerpt.
 *
 * The difference is what happens when it fails. The JSON contract rejected the
 * whole catalog, because a citation was structurally required. Context is useful
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
  /** Evidence links whose immutable source location resolved. */
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
 * Legacy exact-phrase helper retained for the JSON catalog and remote executor.
 * Markdown claim semantics are checked by the source-aware audit instead.
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
  if (link.providerUrl) {
    return {
      documentPath,
      claim: link.claimSpan,
      target: link.providerUrl,
      reason: "unknown-path"
    };
  }
  if (link.path === undefined || link.startLine === undefined || link.endLine === undefined) {
    return { documentPath, claim: link.claimSpan, target: "(invalid evidence link)", reason: "invalid-range" };
  }
  const target = `${link.path}#L${link.startLine}-L${link.endLine}`;
  // A symbol name somewhere inside a thousand-line range technically passes a
  // containment check but does not provide the concept-to-code navigation that
  // makes generated repository documentation useful. Large constructs must be
  // cited at the focused branch, invariant, or interface that supports the
  // nearby claim.
  if (link.endLine - link.startLine + 1 > 120) {
    return { documentPath, claim: link.claimSpan, target, reason: "invalid-range" };
  }
  const record = inputs.evidenceByPath.get(link.path);
  if (record === undefined) {
    return { documentPath, claim: link.claimSpan, target, reason: "unknown-path" };
  }
  const excerpt = evidenceExcerpt(record, { startLine: link.startLine, endLine: link.endLine });
  if (excerpt === undefined) {
    return { documentPath, claim: link.claimSpan, target, reason: "invalid-range" };
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
