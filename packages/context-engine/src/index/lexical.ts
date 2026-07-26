import { fingerprint, stableId } from "../domain/fingerprint.js";
import type { ContextDocument, ContextFragment } from "../domain/projection.js";

export const LEXICAL_PROJECTOR_VERSION = "lexical-v1";

export function tokenizeContext(value: string): string[] {
  return [
    ...value
      .normalize("NFKC")
      .toLowerCase()
      .matchAll(/[a-z0-9_$./:@#-]+/g)
  ].map((match) => match[0]);
}

function splitRanges(body: string, maxCharacters: number): { start: number; end: number }[] {
  if (body.length <= maxCharacters) return [{ start: 0, end: body.length }];
  const ranges: { start: number; end: number }[] = [];
  let start = 0;
  while (start < body.length) {
    let end = Math.min(body.length, start + maxCharacters);
    if (end < body.length) {
      const paragraph = body.lastIndexOf("\n\n", end);
      const line = body.lastIndexOf("\n", end);
      const boundary = Math.max(paragraph >= start + Math.floor(maxCharacters / 2) ? paragraph + 2 : -1, line);
      if (boundary > start) end = boundary;
    }
    ranges.push({ start, end });
    start = end;
  }
  return ranges;
}

export class LexicalProjector {
  constructor(private readonly maxFragmentCharacters = 1_600) {}

  project(documents: ContextDocument[]): ContextFragment[] {
    return documents.flatMap((document) =>
      splitRanges(document.body, this.maxFragmentCharacters).map(({ start, end }, ordinal) => {
        const sourceText = document.body.slice(start, end);
        return {
          id: stableId("cf", { documentId: document.id, ordinal, sourceText }),
          generationId: document.generationId,
          documentId: document.id,
          ordinal,
          sourceText,
          contextualText: document.contextualText,
          startOffset: start,
          endOffset: end,
          anchors: document.anchors,
          tokenFingerprint: fingerprint(tokenizeContext(`${sourceText}\n${document.contextualText}`))
        };
      })
    );
  }
}
