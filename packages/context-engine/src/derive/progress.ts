import type { ContextArtifactRef } from "../ports/artifact-store.js";

/**
 * Validates the extensionless, repository-context-relative identity used by
 * provisional page checkpoints.
 *
 * These paths cross a worker/API trust boundary and are later joined onto a
 * writable derivation directory. Keeping the validation next to the shared
 * progress contract prevents a forged checkpoint from becoming a traversal on
 * retry. Hidden segments are excluded because output collectors deliberately
 * reserve them for private control-plane state.
 */
export function derivationProgressDocumentPath(value: string): string {
  const candidate = value.trim().replaceAll("\\", "/");
  const segments = candidate.split("/");
  if (
    candidate.length === 0 ||
    candidate.length > 500 ||
    candidate.startsWith("/") ||
    candidate.endsWith(".md") ||
    candidate.includes("\0") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.startsWith("."))
  ) {
    throw new Error("derivation progress documentPath must be a safe extensionless relative path");
  }
  return candidate;
}

/**
 * A page a derivation has finished, before the run that wrote it has ended.
 *
 * The file contract finishes pages one at a time onto disk, which makes a
 * partial run meaningful: what exists is complete, not half-written. That is
 * what makes it worth both keeping when a run is stopped and showing while it
 * is still going.
 */
export interface DerivationProgressPage {
  readonly documentPath: string;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly contentDigest?: string;
  readonly validationStatus?: "pending" | "valid" | "invalid";
  readonly diagnostics?: readonly string[];
  readonly checkpointSequence?: number;
}

/**
 * Opaque private agent-stage state restored only to the derivation worker.
 *
 * It is never part of the context catalog or progress/read APIs. The API
 * encrypts it before artifact storage and stores only this tenant/stage-bound
 * reference in the control-plane database.
 */
export interface DerivationPrivateCheckpoint {
  readonly artifact: ContextArtifactRef;
  readonly plaintextDigest: string;
  readonly bytes: number;
  readonly checkpointSequence: number;
  readonly updatedAt: string;
}

/** What a build has written so far, for somebody watching it happen. */
export interface DerivationProgressSnapshot {
  readonly buildId: string;
  readonly pages: readonly {
    readonly documentPath: string;
    readonly title: string;
    readonly bytes: number;
    readonly contentDigest?: string;
    readonly validationStatus: "pending" | "valid" | "invalid";
    readonly diagnostics: readonly string[];
    readonly checkpointSequence: number;
    readonly firstSeenAt: string;
    readonly updatedAt: string;
  }[];
  readonly orchestration?: {
    readonly state: ContextOrchestrationState;
    readonly contentDigest?: string;
    readonly checkpointSequence: number;
    readonly updatedAt: string;
  };
  readonly updatedAt?: string;
}
import type { ContextOrchestrationState } from "./orchestration.js";
