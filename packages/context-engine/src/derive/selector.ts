import type { EvidenceCheckpoint, EvidenceRecord } from "../domain/evidence.js";
import type { PriorKnowledgeRevision } from "./service.js";
import { fingerprint } from "../domain/fingerprint.js";
import type { EvidenceStore } from "../ports/evidence-store.js";
import type { KnowledgeStore } from "../ports/knowledge-store.js";

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

export const FOCUS_SELECTOR_VERSION = "agent-evidence-v2";

function priority(record: EvidenceRecord): number {
  const path = record.anchor.pathOrUrl?.toLowerCase() ?? "";
  if (["issue", "pull_request", "document", "observation"].includes(record.anchor.sourceType)) return 0;
  if (/\/(?:adr|rfcs?|runbooks?)\//.test(`/${path}`) || /(?:readme|architecture|design)/.test(path)) return 1;
  if (record.anchor.sourceType === "commit") return 2;
  if (/(?:package\.json|pyproject\.toml|cargo\.toml|go\.mod)$/.test(path)) return 3;
  if (/(?:test|spec)\.[a-z0-9]+$/.test(path)) return 4;
  return 5;
}

export class EvidenceFocusSelector {
  constructor(
    private readonly store: EvidenceStore,
    private readonly limits: { maxItems: number; maxCharacters: number; maxItemCharacters: number } = {
      maxItems: 2_000,
      maxCharacters: 8 * 1024 * 1024,
      maxItemCharacters: 256 * 1024
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
    return {
      ...value,
      fingerprint: fingerprint({
        items,
        omittedCount: value.omittedCount,
        truncatedEvidenceIds,
        selectorVersion: FOCUS_SELECTOR_VERSION
      })
    };
  }
}

export async function selectPriorKnowledge(
  store: KnowledgeStore,
  checkpoint: EvidenceCheckpoint,
  maximumDocuments = 50
): Promise<PriorKnowledgeRevision[]> {
  const revisions = (await store.listRevisions(checkpoint.tenantId, checkpoint.repository)).sort(
    (left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
  );
  const selected: PriorKnowledgeRevision[] = [];
  const logicalIds = new Set<string>();
  for (const revision of revisions) {
    if (selected.length >= maximumDocuments) break;
    if (revision.scope.ref !== checkpoint.ref) continue;
    if (logicalIds.has(revision.logicalId)) continue;
    const events = await store.listRevisionEvents(revision.id);
    if (events.some((event) => ["rejected", "invalidated", "redacted", "superseded"].includes(event.type))) {
      continue;
    }
    logicalIds.add(revision.logicalId);
    selected.push({
      revision,
      citations: await store.listCitations(revision.id),
      reviewStatus: events.some((event) => event.type === "reviewed") ? "reviewed" : "generated"
    });
  }
  return selected;
}
