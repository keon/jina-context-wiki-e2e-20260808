import { canonicalJson } from "../domain/fingerprint.js";
import type { ContextDocument, ExactIndexEntry } from "../domain/projection.js";
import { tokenizeContext } from "./lexical.js";

export const EXACT_PROJECTOR_VERSION = "exact-v2";
export const EXACT_TERM_MAX_CHARACTERS = 512;

function entriesFor(document: ContextDocument, field: ExactIndexEntry["field"], value: string): ExactIndexEntry[] {
  return [...new Set(tokenizeContext(value))]
    .filter((term) => term.length > 1 && term.length <= EXACT_TERM_MAX_CHARACTERS)
    .map((term) => ({
      generationId: document.generationId,
      term,
      documentId: document.id,
      field
    }));
}

export class ExactProjector {
  project(documents: ContextDocument[]): ExactIndexEntry[] {
    return documents
      .flatMap((document) => [
        ...entriesFor(document, "title", document.title),
        ...entriesFor(document, "body", document.body),
        ...entriesFor(document, "metadata", canonicalJson(document.metadata))
      ])
      .sort(
        (left, right) =>
          left.term.localeCompare(right.term) ||
          left.documentId.localeCompare(right.documentId) ||
          left.field.localeCompare(right.field)
      );
  }
}
