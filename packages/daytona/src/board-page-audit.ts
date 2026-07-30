import { createHash } from "node:crypto";
import {
  canonicalJson,
  fingerprint,
  markdownEvidenceSections,
  normalizeProviderObservation,
  parseMarkdownDocument,
  type IngestEvidenceInput
} from "@jina/context-engine";
import type { CitationAuditReference } from "./local-agent-stages.js";

export interface BoardPageAuditInput {
  readonly documentPath: string;
  readonly bodyMarkdown: string;
  readonly snapshot: IngestEvidenceInput;
}

export interface BoardPageAuditInventory {
  readonly references: readonly CitationAuditReference[];
  readonly structuralProblems: readonly string[];
}

/**
 * Builds the exact source excerpts an independent page auditor receives.
 *
 * This is deliberately deterministic and model-free: the model judges
 * entailment, while the host owns citation identity, source binding, range
 * bounds, byte digests, a grounded lead, and substantive-section coverage.
 */
export function boardPageAuditInventory(input: BoardPageAuditInput): BoardPageAuditInventory {
  const documentIdentity = input.documentPath.replace(/\.md$/i, "");
  const document = parseMarkdownDocument(documentIdentity, input.bodyMarkdown);
  const structuralProblems: string[] = [];
  const knownCitationIds = new Set(document.evidenceLinks.map((link) => link.citationId));
  const materialClaims = document.materialClaims.filter((claim) => claim.classification === "material");
  const auditableCitationIds = new Set(materialClaims.flatMap((claim) => claim.citationIds));
  const claimIdByCitationId = new Map(
    materialClaims.flatMap((claim) => claim.citationIds.map((citationId) => [citationId, claim.claimId] as const))
  );
  const groundedSummaryCitationIds = [
    ...new Set(
      document.materialClaims
        .filter((claim) => claim.summary && claim.classification === "material")
        .flatMap((claim) => claim.citationIds)
        .filter((citationId) => knownCitationIds.has(citationId))
    )
  ];
  if (groundedSummaryCitationIds.length === 0) {
    structuralProblems.push(`ungrounded lead summary in ${input.documentPath}`);
  }
  for (const section of markdownEvidenceSections(input.bodyMarkdown, documentIdentity)) {
    if (section.substantiveClaimCount === 0) continue;
    if (section.citationIds.some((citationId) => knownCitationIds.has(citationId))) continue;
    structuralProblems.push(
      `ungrounded substantive section in ${input.documentPath}: ${section.heading || `line ${section.line}`}`
    );
  }

  const files = new Map(input.snapshot.files.map((file) => [file.path, file]));
  const observationsByUrl = new Map<string, NonNullable<IngestEvidenceInput["observations"]>[number][]>();
  for (const observation of input.snapshot.observations ?? []) {
    if (!observation.pathOrUrl) continue;
    const normalized = normalizedProviderUrl(observation.pathOrUrl);
    if (!normalized) continue;
    const existing = observationsByUrl.get(normalized) ?? [];
    existing.push(observation);
    observationsByUrl.set(normalized, existing);
  }
  const commitsByUrl = new Map<
    string,
    {
      readonly sha: string;
      readonly body: string;
    }
  >();
  if (input.snapshot.git) {
    const commits = new Map<string, object>();
    commits.set(input.snapshot.commitSha, {
      sha: input.snapshot.commitSha,
      ...input.snapshot.git.commit,
      changes: input.snapshot.git.changes
    });
    for (const commit of input.snapshot.git.history ?? []) {
      commits.set(commit.sha, commit);
    }
    for (const [sha, commit] of commits) {
      const url = normalizedProviderUrl(`https://github.com/${input.snapshot.repository}/commit/${sha}`);
      if (!url) continue;
      commitsByUrl.set(url, { sha, body: canonicalJson(commit) });
    }
  }

  const references: CitationAuditReference[] = [];
  const ids = new Set<string>();
  for (const link of document.evidenceLinks) {
    // Source links inside explicit questions or pure navigation are useful
    // pointers, not factual assertions. The deterministic claim classifier has
    // already proved that distinction; sending those links to a semantic
    // citation auditor wastes model work and invites nonsensical entailment
    // failures against question wording.
    if (!auditableCitationIds.has(link.citationId)) continue;
    if (ids.has(link.citationId)) {
      structuralProblems.push(`citation identity collision in ${input.documentPath}: ${link.citationId}`);
      continue;
    }
    ids.add(link.citationId);
    if (link.providerUrl) {
      const normalized = normalizedProviderUrl(link.providerUrl);
      const commit = normalized ? commitsByUrl.get(normalized) : undefined;
      if (commit) {
        references.push({
          citationId: link.citationId,
          claimId: claimIdByCitationId.get(link.citationId)!,
          documentPath: input.documentPath,
          label: link.claim,
          claimSpan: link.claimSpan,
          target: link.providerUrl,
          sourceType: "commit",
          sourceId: commit.sha,
          contentDigest: fingerprint(commit.body),
          pathOrUrl: link.providerUrl,
          jsonPointer: "",
          excerpt: commit.body
        });
        continue;
      }
      const matches = normalized ? (observationsByUrl.get(normalized) ?? []) : [];
      if (matches.length !== 1) {
        structuralProblems.push(
          `provider citation does not bind to exactly one captured observation or Git commit: ${link.providerUrl}`
        );
        continue;
      }
      const observation = matches[0]!;
      const normalizedObservation = normalizeProviderObservation(observation);
      const body = normalizedObservation.body;
      references.push({
        citationId: link.citationId,
        claimId: claimIdByCitationId.get(link.citationId)!,
        documentPath: input.documentPath,
        label: link.claim,
        claimSpan: link.claimSpan,
        target: link.providerUrl,
        sourceType: observation.sourceType,
        sourceId: observation.sourceId,
        contentDigest: normalizedObservation.contentDigest,
        ...(observation.pathOrUrl ? { pathOrUrl: observation.pathOrUrl } : {}),
        jsonPointer: "",
        excerpt: body
      });
      continue;
    }
    if (link.path === undefined || link.startLine === undefined || link.endLine === undefined) {
      structuralProblems.push(`repository citation has no complete path and range in ${input.documentPath}`);
      continue;
    }
    const file = files.get(link.path);
    if (!file || file.contentOmitted) {
      structuralProblems.push(`repository citation path is unavailable in the snapshot: ${link.path}`);
      continue;
    }
    if (link.startLine < 1 || link.endLine < link.startLine || link.endLine - link.startLine + 1 > 120) {
      structuralProblems.push(`repository citation range is invalid or exceeds 120 lines: ${link.path}`);
      continue;
    }
    const lines = file.body.split(/\r?\n/);
    if (link.endLine > lines.length) {
      structuralProblems.push(`repository citation range exceeds the source: ${link.path}#L${link.endLine}`);
      continue;
    }
    references.push({
      citationId: link.citationId,
      claimId: claimIdByCitationId.get(link.citationId)!,
      documentPath: input.documentPath,
      label: link.claim,
      claimSpan: link.claimSpan,
      target: `${link.path}#L${link.startLine}${link.endLine === link.startLine ? "" : `-L${link.endLine}`}`,
      sourceType: "blob",
      sourceId: file.blobSha,
      contentDigest: sha256(file.body),
      pathOrUrl: link.path,
      startLine: link.startLine,
      endLine: link.endLine,
      excerpt: lines.slice(link.startLine - 1, link.endLine).join("\n")
    });
  }
  if (references.length === 0) structuralProblems.push("page has no source-bound public evidence links");
  if (references.length > 500) structuralProblems.push(`page has ${references.length} citations; maximum is 500`);
  return { references, structuralProblems };
}

export function boardPublicPageDigest(documentPath: string, bodyMarkdown: string): string {
  return sha256(`${documentPath}\0${bodyMarkdown}`);
}

function normalizedProviderUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
