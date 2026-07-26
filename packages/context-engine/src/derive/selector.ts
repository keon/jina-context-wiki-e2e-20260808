import type { EvidenceCheckpoint, EvidenceRecord } from "../domain/evidence.js";
import { fingerprint } from "../domain/fingerprint.js";
import type { EvidenceStore } from "../ports/evidence-store.js";

export interface FocusBundleItem {
  evidenceId: string;
  title: string;
  body: string;
  anchor: EvidenceRecord["anchor"];
  authorityClass: EvidenceRecord["authorityClass"];
  metadata: Record<string, unknown>;
}

export interface FocusBundle {
  checkpoint: EvidenceCheckpoint;
  items: FocusBundleItem[];
  omittedCount: number;
  truncatedEvidenceIds: string[];
  selectorVersion: string;
  fingerprint: string;
}

export const FOCUS_SELECTOR_VERSION = "bounded-evidence-v1";

function priority(record: EvidenceRecord): number {
  const path = record.anchor.pathOrUrl?.toLowerCase() ?? "";
  if (/\/(?:adr|rfcs?|runbooks?)\//.test(`/${path}`) || /(?:readme|architecture|design)/.test(path)) return 0;
  if (/(?:package\.json|pyproject\.toml|cargo\.toml|go\.mod)$/.test(path)) return 1;
  if (/(?:test|spec)\.[a-z0-9]+$/.test(path)) return 2;
  if (record.anchor.sourceType !== "blob") return 3;
  return 4;
}

export class EvidenceFocusSelector {
  constructor(
    private readonly store: EvidenceStore,
    private readonly limits: { maxItems: number; maxCharacters: number; maxItemCharacters: number } = {
      maxItems: 80,
      maxCharacters: 120_000,
      maxItemCharacters: 20_000
    }
  ) {}

  async select(checkpointId: string): Promise<FocusBundle> {
    const checkpoint = await this.store.getCheckpoint(checkpointId);
    if (checkpoint === undefined) throw new Error("Unknown evidence checkpoint");
    const records = (await this.store.listEvidence(checkpointId)).sort(
      (left, right) =>
        priority(left) - priority(right) || left.title.localeCompare(right.title) || left.id.localeCompare(right.id)
    );
    const items: FocusBundleItem[] = [];
    const truncatedEvidenceIds: string[] = [];
    let characters = 0;
    for (const record of records) {
      if (items.length >= this.limits.maxItems || characters >= this.limits.maxCharacters) break;
      const remaining = this.limits.maxCharacters - characters;
      const size = Math.min(record.body.length, this.limits.maxItemCharacters, remaining);
      if (size <= 0) break;
      if (size < record.body.length) truncatedEvidenceIds.push(record.id);
      items.push({
        evidenceId: record.id,
        title: record.title,
        body: record.body.slice(0, size),
        anchor: record.anchor,
        authorityClass: record.authorityClass,
        metadata: record.metadata
      });
      characters += size;
    }
    const value = {
      checkpoint,
      items,
      omittedCount: records.length - items.length,
      truncatedEvidenceIds,
      selectorVersion: FOCUS_SELECTOR_VERSION
    };
    return { ...value, fingerprint: fingerprint(value) };
  }
}
