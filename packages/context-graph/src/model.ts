import { createHash } from "node:crypto";

export const contextGraphNodeKinds = [
  "Repository",
  "File",
  "Symbol",
  "Commit",
  "PullRequest",
  "Issue",
  "Engineer",
  "Team",
  "Document",
  "Feature",
  "Package",
  "Service",
  "Deployment",
  "Incident"
] as const;

export type ContextGraphNodeKind = (typeof contextGraphNodeKinds)[number];
export type ContextGraphPlane = "code" | "knowledge";

export interface ContextGraphNode {
  readonly id: string;
  readonly kind: ContextGraphNodeKind;
  readonly label: string;
  readonly description: string;
  readonly path?: string;
  readonly evidence: readonly string[];
}

export interface ContextGraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly predicate: string;
  readonly plane: ContextGraphPlane;
  readonly confidence?: number;
  /** Canonical assertion qualifiers retained by materialized knowledge projections. */
  readonly qualifiers?: Readonly<Record<string, string | number | boolean>>;
  /** Human-readable semantic rationale. Required for model-generated knowledge assertions. */
  readonly why?: string;
  readonly evidence: readonly string[];
}

export interface ContextGraph {
  readonly id: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly generatedAt: string;
  readonly generator: {
    readonly executor: "daytona" | "fixture" | "projection";
    readonly model: string;
    readonly sandboxId?: string;
  };
  readonly summary: string;
  readonly nodes: readonly ContextGraphNode[];
  readonly edges: readonly ContextGraphEdge[];
  /** Exact parsed JSON downloaded from a model run; omitted from projections and persisted graph reads. */
  readonly rawModelOutput?: unknown;
}

export interface ContextGraphSummary extends Omit<ContextGraph, "nodes" | "edges"> {
  readonly nodeCount: number;
  readonly edgeCount: number;
}

export function summarizeContextGraph(graph: ContextGraph): ContextGraphSummary {
  const { nodes, edges, ...summary } = graph;
  return { ...summary, nodeCount: nodes.length, edgeCount: edges.length };
}

export interface ContextGraphBuildRequest {
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly commitSha?: string;
  readonly focusPaths?: readonly string[];
  /** PRs whose complete changed-file list contains durable regression/problem evidence. */
  readonly problemEvidencePullRequestNumbers?: readonly number[];
  /** PRs present in the immutable source observations for this generation. */
  readonly sourcePullRequestNumbers?: readonly number[];
  /** Source PRs that already explicitly resolve a tracked issue. */
  readonly resolvedPullRequestNumbers?: readonly number[];
  /** Immutable source observations included in this generation's evidence fingerprint. */
  readonly sourceEvidence?: readonly ContextGraphSourceEvidence[];
  readonly taskId: string;
  /** Cancels further external work when the caller loses its execution lease. */
  readonly signal?: AbortSignal;
}

export interface ContextGraphSourceEvidence {
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly repository: string;
  readonly payloadSha: string;
  readonly payload: unknown;
}

export interface GeneratedContextGraph {
  readonly summary: string;
  readonly nodes: readonly ContextGraphNode[];
  readonly edges: readonly Omit<ContextGraphEdge, "id">[];
}

export interface EvidenceCitation {
  readonly value: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface ContextGraphExecutor {
  buildAssertions(request: ContextGraphBuildRequest): Promise<ContextGraph>;
}

export function createContextGraph(input: {
  readonly request: ContextGraphBuildRequest;
  readonly commitSha: string;
  readonly generatedAt: string;
  readonly executor: "daytona" | "fixture" | "projection";
  readonly model: string;
  readonly sandboxId?: string;
  readonly generated: GeneratedContextGraph;
  /** Projection read models are keyed by their canonical content instead of the worker task that rebuilt them. */
  readonly contentAddressed?: boolean;
  /** Assertion-generation observations may be valid with no supported semantic relationship. */
  readonly allowEmptyEdges?: boolean;
}): ContextGraph {
  const nodes = dedupeNodes(input.generated.nodes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = input.generated.edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map((edge) => ({
      ...edge,
      predicate: normalizePredicate(edge.predicate),
      id: stableId(
        "edge",
        `${edge.source}:${edge.predicate}:${edge.target}:${edge.plane}:${canonicalGraphJson(edge.qualifiers ?? {})}:${edge.why ?? ""}`
      )
    }));

  if (!nodes.some((node) => node.kind === "Repository")) {
    throw new Error("generated contextGraph must contain a Repository node");
  }
  if (!input.allowEmptyEdges && (nodes.length < 2 || edges.length < 1)) {
    throw new Error("generated contextGraph must contain at least two nodes and one valid edge");
  }

  const generationIdentity = input.contentAddressed
    ? `${input.request.tenantId}:${input.request.repository}:${input.request.ref}:${input.commitSha}:${input.model}:${stableId("content", canonicalGraphJson({ summary: input.generated.summary.trim(), nodes, edges: dedupeEdges(edges) }))}`
    : `${input.request.tenantId}:${input.request.repository}:${input.commitSha}:${input.request.taskId}`;
  return {
    id: stableId("graph", generationIdentity),
    tenantId: input.request.tenantId,
    repository: input.request.repository,
    ref: input.request.ref,
    commitSha: input.commitSha,
    generatedAt: input.generatedAt,
    generator: {
      executor: input.executor,
      model: input.model,
      ...(input.sandboxId ? { sandboxId: input.sandboxId } : {})
    },
    summary: input.generated.summary.trim(),
    nodes,
    edges: dedupeEdges(edges)
  };
}

function canonicalGraphJson(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalGraphJson(item)).sort();
    return `[${items.join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalGraphJson(record[key])}`)
      .join(",")}}`;
  }
  return value === undefined ? "undefined" : JSON.stringify(value);
}

export function parseGeneratedContextGraph(value: unknown): GeneratedContextGraph {
  if (
    !isRecord(value) ||
    typeof value.summary !== "string" ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges)
  ) {
    throw new Error("The model returned an invalid contextGraph document");
  }

  const nodes = value.nodes.map(parseNode);
  const edges = value.edges.map(parseEdge);
  return { summary: value.summary, nodes, edges };
}

/**
 * Source-backed semantic identities are supplied by deterministic intake. The
 * model may connect them, but cannot mint a Package, Service, Deployment, or
 * Incident that was absent from the pinned evidence bundle.
 */
export function sourceBackedModelEntityIds(evidence: readonly ContextGraphSourceEvidence[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const item of evidence) {
    if (!isRecord(item.payload) || item.payload.removed === true) continue;
    const payload = item.payload;
    const repository = typeof payload.repository === "string" ? payload.repository : item.repository;
    if (
      payload.kind === "package_manifest" &&
      typeof payload.ecosystem === "string" &&
      Array.isArray(payload.dependencies)
    ) {
      for (const dependency of payload.dependencies) {
        if (isRecord(dependency) && typeof dependency.name === "string") {
          ids.add(`package:${payload.ecosystem.toLowerCase()}:${dependency.name.toLowerCase()}`);
        }
      }
    }
    if (
      payload.kind === "service_definition" &&
      typeof payload.source === "string" &&
      typeof payload.externalId === "string"
    ) {
      ids.add(`service:${payload.source}:${payload.externalId}`);
      for (const dependency of Array.isArray(payload.dependsOnServices) ? payload.dependsOnServices : []) {
        if (
          isRecord(dependency) &&
          typeof dependency.source === "string" &&
          typeof dependency.externalId === "string"
        ) {
          ids.add(`service:${dependency.source}:${dependency.externalId}`);
        }
      }
    }
    if (payload.kind === "deployment" && typeof payload.source === "string" && typeof payload.externalId === "string") {
      ids.add(`deployment:${payload.source}:${payload.externalId}`);
      if (
        isRecord(payload.service) &&
        typeof payload.service.source === "string" &&
        typeof payload.service.externalId === "string"
      ) {
        ids.add(`service:${payload.service.source}:${payload.service.externalId}`);
      }
    }
    if (payload.kind === "incident" && typeof payload.source === "string" && typeof payload.externalId === "string") {
      ids.add(
        typeof payload.issueNumber === "number"
          ? `incident:github:${repository}#${payload.issueNumber}`
          : `incident:${payload.source}:${payload.externalId}`
      );
      if (
        isRecord(payload.impactedService) &&
        typeof payload.impactedService.source === "string" &&
        typeof payload.impactedService.externalId === "string"
      ) {
        ids.add(`service:${payload.impactedService.source}:${payload.impactedService.externalId}`);
      }
    }
  }
  return ids;
}

export function validateSourceBackedModelEntities(
  generated: GeneratedContextGraph,
  evidence: readonly ContextGraphSourceEvidence[]
): void {
  const allowed = sourceBackedModelEntityIds(evidence);
  for (const node of generated.nodes) {
    if (!["Package", "Service", "Deployment", "Incident"].includes(node.kind)) continue;
    if (!allowed.has(node.id))
      throw new Error(`${node.kind} ${node.id} is not anchored by deterministic source evidence`);
  }
}

export function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

export function contextGraphEvidenceCitations(generated: GeneratedContextGraph): readonly EvidenceCitation[] {
  const values = new Set([
    ...generated.nodes.flatMap((node) => node.evidence),
    ...generated.edges.flatMap((edge) => edge.evidence)
  ]);
  return [...values].map(parseEvidenceCitation);
}

export async function validateContextGraphEvidence(
  generated: GeneratedContextGraph,
  readFile: (path: string) => Promise<string>
): Promise<void> {
  const files = new Map<string, string>();
  for (const citation of contextGraphEvidenceCitations(generated)) {
    let source = files.get(citation.path);
    if (source === undefined) {
      try {
        source = await readFile(citation.path);
      } catch {
        throw new Error(`contextGraph evidence file does not exist: ${citation.path}`);
      }
      files.set(citation.path, source);
    }
    const lineCount = source.split(/\r?\n/).length;
    if (citation.startLine > lineCount || citation.endLine > lineCount) {
      throw new Error(`contextGraph evidence is outside ${citation.path}: ${citation.value}`);
    }
  }
  validateCausalEvidenceContents(generated, files);
}

/**
 * A merged PR that explicitly describes an untracked repair and changes a
 * durable problem/evidence file must yield a reviewable derived Issue proposal.
 * The rule only detects a missing proposal; the model still names the problem,
 * explains it, and supplies repository citations.
 */
export function validateRequiredDerivedIssues(
  generated: GeneratedContextGraph,
  sourceEvidence: readonly ContextGraphSourceEvidence[],
  problemEvidencePullRequestNumbers: readonly number[] = []
): void {
  for (const number of requiredDerivedIssuePullRequestNumbers(sourceEvidence, problemEvidencePullRequestNumbers)) {
    const derivedIssueId = `derived:pr:${number}`;
    const node = generated.nodes.find((candidate) => candidate.kind === "Issue" && candidate.id === derivedIssueId);
    const resolutions = node
      ? generated.edges.filter(
          (edge) =>
            (edge.predicate === "RESOLVED_BY" && edge.source === node.id) ||
            (edge.predicate === "RESOLVES" && edge.target === node.id)
        )
      : [];
    const resolution = resolutions[0];
    const pullRequestId = resolution?.predicate === "RESOLVED_BY" ? resolution.target : resolution?.source;
    const pullRequest = pullRequestId ? generated.nodes.find((candidate) => candidate.id === pullRequestId) : undefined;
    const pullRequestNumber =
      pullRequest?.kind === "PullRequest" ? /^(?:pr:|#)?(\d+)$/i.exec(pullRequest.id.trim())?.[1] : undefined;
    if (!node || resolutions.length !== 1 || pullRequestNumber !== String(number)) {
      throw new Error(
        `pull request #${number} explicitly repairs an untracked problem and requires derived Issue ${derivedIssueId}`
      );
    }
  }
}

export function requiredDerivedIssuePullRequestNumbers(
  sourceEvidence: readonly ContextGraphSourceEvidence[],
  problemEvidencePullRequestNumbers: readonly number[] = []
): readonly number[] {
  const problemPullRequests = new Set(problemEvidencePullRequestNumbers);
  if (problemPullRequests.size === 0) return [];
  const required = sourceEvidence.flatMap((evidence) => {
    if (!isRecord(evidence.payload)) return [];
    const payload = evidence.payload;
    if (payload.kind !== "pull_request" || typeof payload.number !== "number" || !payload.mergedAt) return [];
    if (!problemPullRequests.has(payload.number)) return [];
    if (Array.isArray(payload.resolvesIssueNumbers) && payload.resolvesIssueNumbers.length > 0) return [];
    if (Array.isArray(payload.referencesIssueNumbers) && payload.referencesIssueNumbers.length > 0) return [];
    const text = `${typeof payload.title === "string" ? payload.title : ""}\n${typeof payload.body === "string" ? payload.body : ""}`;
    if (/\b(?:not|isn't|is not)\s+(?:a\s+)?(?:bug\s+)?fix\b|\bno\s+behavior\s+change\b/i.test(text)) return [];
    const repair = /\b(?:fix(?:e[sd])?|repair(?:s|ed|ing)?|restor(?:e[sd]?|ing)|correct(?:s|ed|ing)?)\b/i.test(text);
    const problem =
      /\b(?:bug|regression|incorrect|broken|fail(?:s|ed|ing|ure)?|cannot|can't|unable|denied|wrong)\b/i.test(text);
    return repair && problem ? [payload.number] : [];
  });
  return [...new Set(required)];
}

export interface CausalEvidenceFile {
  readonly path: string;
  readonly content: string;
}

export interface RequiredCausalAnchor {
  readonly issueId: string;
  readonly commitSha: string;
  readonly evidencePath: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface RequiredMoveAnchor {
  readonly currentPath: string;
  readonly previousPath: string;
  readonly evidencePath: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** Detect only explicit root-cause records; proximity or PR membership never qualifies. */
export function requiredCausalAnchors(
  files: readonly CausalEvidenceFile[],
  derivedIssuePullRequestNumbers: readonly number[] = []
): readonly RequiredCausalAnchor[] {
  const anchors: RequiredCausalAnchor[] = [];
  for (const file of files) {
    if (!/(?:^|\/)(?:incident|postmortem|root[-_]?cause)|root[-_]?cause/i.test(file.path)) continue;
    if (!/\bintroduced\s+by\b/i.test(file.content)) continue;
    const lines = file.content.split(/\r?\n/);
    const shaMatch = /\b([a-f0-9]{40})\b/i.exec(file.content);
    const commitSha = shaMatch?.[1]?.toLowerCase();
    if (!commitSha) continue;
    const issuePattern = /\b(?:github\s+)?issue\s+#(\d+)\b/i;
    const issueNumber = issuePattern.exec(file.content)?.[1];
    const issueId =
      issueNumber ??
      (/\bno\s+github\s+issue\s+was\s+opened\b/i.test(file.content) && derivedIssuePullRequestNumbers.length === 1
        ? `derived:pr:${derivedIssuePullRequestNumbers[0]}`
        : undefined);
    if (issueId) {
      const shaLine = Math.max(1, lines.findIndex((line) => line.toLowerCase().includes(commitSha)) + 1);
      const issueLine = issueNumber ? Math.max(1, lines.findIndex((line) => issuePattern.test(line)) + 1) : 1;
      anchors.push({
        issueId,
        commitSha,
        evidencePath: file.path,
        startLine: Math.min(issueLine, shaLine),
        endLine: Math.min(lines.length, shaLine + 2)
      });
    }
  }
  return anchors.filter(
    (anchor, index) =>
      anchors.findIndex(
        (candidate) => candidate.issueId === anchor.issueId && candidate.commitSha === anchor.commitSha
      ) === index
  );
}

/** Detect only explicit, repository-authored file continuity statements. */
export function requiredMoveAnchors(files: readonly CausalEvidenceFile[]): readonly RequiredMoveAnchor[] {
  const anchors: RequiredMoveAnchor[] = [];
  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const currentFromPrevious = /`([^`\n]+)`\s+(?:was\s+)?moved\s+from\s+`([^`\n]+)`/i.exec(line);
      const previousToCurrent = /\bmoved\s+from\s+`([^`\n]+)`\s+to\s+`([^`\n]+)`/i.exec(line);
      const currentPath = normalizeExplicitMovePath(currentFromPrevious?.[1] ?? previousToCurrent?.[2]);
      const previousPath = normalizeExplicitMovePath(currentFromPrevious?.[2] ?? previousToCurrent?.[1]);
      if (!currentPath || !previousPath || currentPath === previousPath) continue;
      anchors.push({
        currentPath,
        previousPath,
        evidencePath: file.path,
        startLine: index + 1,
        endLine: index + 1
      });
    }
  }
  return anchors.filter(
    (anchor, index) =>
      anchors.findIndex(
        (candidate) => candidate.currentPath === anchor.currentPath && candidate.previousPath === anchor.previousPath
      ) === index
  );
}

/** Materialize explicit move contracts without treating similarity candidates as facts. */
export function materializeRequiredMoveAssertions(
  generated: GeneratedContextGraph,
  anchors: readonly RequiredMoveAnchor[]
): GeneratedContextGraph {
  const nodes = [...generated.nodes];
  const edges = [...generated.edges];
  const fileNode = (path: string, evidence: string, historical: boolean): ContextGraphNode => {
    const canonicalId = `file:${path}`;
    const existingIndex = nodes.findIndex(
      (node) => node.kind === "File" && (node.path === path || node.id === canonicalId)
    );
    const existing = nodes[existingIndex];
    if (existing?.kind === "File") {
      if (existing.path === path) return existing;
      const anchored = { ...existing, path };
      nodes[existingIndex] = anchored;
      return anchored;
    }
    const node: ContextGraphNode = {
      id: canonicalId,
      kind: "File",
      label: path.split("/").at(-1) ?? path,
      description: historical
        ? `Historical file named by explicit repository move-continuity evidence: ${path}`
        : `Current file named by explicit repository move-continuity evidence: ${path}`,
      path,
      evidence: [evidence]
    };
    nodes.push(node);
    return node;
  };

  for (const anchor of anchors) {
    const evidence = `${anchor.evidencePath}:${anchor.startLine}-${anchor.endLine}`;
    const current = fileNode(anchor.currentPath, evidence, false);
    const previous = fileNode(anchor.previousPath, evidence, true);
    const requiredEdge: Omit<ContextGraphEdge, "id"> = {
      source: current.id,
      target: previous.id,
      predicate: "MOVED_FROM",
      plane: "knowledge",
      confidence: 1,
      why: `Repository evidence explicitly states that ${anchor.currentPath} moved from ${anchor.previousPath}.`,
      evidence: [evidence]
    };
    const existing = edges.findIndex(
      (edge) => edge.predicate === "MOVED_FROM" && edge.source === current.id && edge.target === previous.id
    );
    if (existing === -1) edges.push(requiredEdge);
    else edges[existing] = requiredEdge;
  }
  return { ...generated, nodes, edges };
}

export function validateRequiredMoveAssertions(
  generated: GeneratedContextGraph,
  anchors: readonly RequiredMoveAnchor[]
): void {
  for (const anchor of anchors) {
    const current = generated.nodes.find((node) => node.kind === "File" && node.path === anchor.currentPath);
    const previous = generated.nodes.find((node) => node.kind === "File" && node.path === anchor.previousPath);
    const edge =
      current && previous
        ? generated.edges.find(
            (candidate) =>
              candidate.predicate === "MOVED_FROM" &&
              candidate.source === current.id &&
              candidate.target === previous.id
          )
        : undefined;
    const spansAnchor = edge?.evidence.some((value) => {
      const citation = parseEvidenceCitation(value);
      return (
        citation.path === anchor.evidencePath &&
        citation.startLine <= anchor.startLine &&
        citation.endLine >= anchor.endLine
      );
    });
    if (!edge || !spansAnchor) {
      throw new Error(`explicit move evidence requires ${anchor.currentPath} MOVED_FROM ${anchor.previousPath}`);
    }
  }
}

function normalizeExplicitMovePath(value: string | undefined): string | undefined {
  const path = value?.trim().replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.split("/").includes("..") || /[\s\\]/.test(path)) return undefined;
  return path;
}

/**
 * Materializes host-detected root-cause contracts after model generation.
 * The model still supplies every non-contract semantic assertion, but an
 * explicit Issue -> Commit statement in repository evidence is not left to
 * probabilistic omission. Malformed optional causal edges are discarded here
 * and well-shaped optional edges still undergo the normal evidence validator.
 */
export function materializeRequiredCausalAssertions(
  generated: GeneratedContextGraph,
  anchors: readonly RequiredCausalAnchor[]
): GeneratedContextGraph {
  const nodes = [...generated.nodes];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const edges = generated.edges.filter((edge) => {
    if (edge.predicate !== "INTRODUCED_BY") return true;
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    return (
      Boolean(source && (source.kind === "Issue" || source.kind === "Incident")) &&
      Boolean(target && (target.kind === "Commit" || target.kind === "Deployment"))
    );
  });

  for (const anchor of anchors) {
    const evidence = `${anchor.evidencePath}:${anchor.startLine}-${anchor.endLine}`;
    if (!nodesById.has(anchor.issueId)) {
      const derivedPullRequest = /^derived:pr:(\d+)$/i.exec(anchor.issueId)?.[1];
      const issue: ContextGraphNode = {
        id: anchor.issueId,
        kind: "Issue",
        label: derivedPullRequest
          ? `Untracked problem repaired by PR #${derivedPullRequest}`
          : `Issue #${anchor.issueId}`,
        description: "An explicit repository root-cause record identifies this issue.",
        evidence: [evidence]
      };
      nodes.push(issue);
      nodesById.set(issue.id, issue);
    }
    if (!nodesById.has(anchor.commitSha)) {
      const commit: ContextGraphNode = {
        id: anchor.commitSha,
        kind: "Commit",
        label: anchor.commitSha.slice(0, 12),
        description: "The commit identified by an explicit repository root-cause record.",
        evidence: [evidence]
      };
      nodes.push(commit);
      nodesById.set(commit.id, commit);
    }

    const existing = edges.findIndex(
      (edge) => edge.predicate === "INTRODUCED_BY" && edge.source === anchor.issueId && edge.target === anchor.commitSha
    );
    const requiredEdge: Omit<ContextGraphEdge, "id"> = {
      source: anchor.issueId,
      target: anchor.commitSha,
      predicate: "INTRODUCED_BY",
      plane: "knowledge",
      confidence: 1,
      why: `The cited root-cause record explicitly attributes Issue ${anchor.issueId} to commit ${anchor.commitSha}.`,
      evidence: [evidence]
    };
    if (existing === -1) edges.push(requiredEdge);
    else edges[existing] = requiredEdge;
  }

  return { ...generated, nodes, edges };
}

export function validateRequiredCausalAssertions(
  generated: GeneratedContextGraph,
  anchors: readonly RequiredCausalAnchor[]
): void {
  for (const anchor of anchors) {
    const issue = generated.nodes.find((node) => node.kind === "Issue" && node.id === anchor.issueId);
    const commit = generated.nodes.find((node) => node.kind === "Commit" && node.id.toLowerCase() === anchor.commitSha);
    const edge =
      issue && commit
        ? generated.edges.find(
            (candidate) =>
              candidate.predicate === "INTRODUCED_BY" && candidate.source === issue.id && candidate.target === commit.id
          )
        : undefined;
    const spansAnchor = edge?.evidence.some((value) => {
      const citation = parseEvidenceCitation(value);
      return (
        citation.path === anchor.evidencePath &&
        citation.startLine <= anchor.startLine &&
        citation.endLine >= anchor.endLine
      );
    });
    if (!edge || !spansAnchor) {
      throw new Error(
        `explicit root-cause evidence requires Issue ${anchor.issueId} INTRODUCED_BY commit ${anchor.commitSha}`
      );
    }
  }
}

export function isProblemEvidencePath(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  const baseName = segments.at(-1) ?? "";
  return (
    segments.some((segment) => /^(?:incidents?|postmortems?|root[-_]?causes?|bugs?|regressions?)$/i.test(segment)) ||
    /(?:^|[-_.])(?:incident|postmortem|root[-_]?cause|bug[-_]?report|regression[-_]?(?:test|spec))(?:[-_.]|$)/i.test(
      baseName
    ) ||
    /(?:\.|[-_])(?:test|spec)\.[^/]+$/i.test(baseName)
  );
}

function validateCausalEvidenceContents(generated: GeneratedContextGraph, files: ReadonlyMap<string, string>): void {
  const nodes = new Map(generated.nodes.map((node) => [node.id, node]));
  for (const edge of generated.edges) {
    if (edge.predicate !== "INTRODUCED_BY") continue;
    const root = nodes.get(edge.source);
    const cause = nodes.get(edge.target);
    if (
      !root ||
      !["Issue", "Incident"].includes(root.kind) ||
      !cause ||
      !["Commit", "Deployment"].includes(cause.kind)
    ) {
      throw new Error("INTRODUCED_BY evidence must connect an Issue or Incident to a Commit or Deployment");
    }
    const issueNumber = root.kind === "Issue" ? /^(?:issue:)?#?(\d+)$/i.exec(root.id.trim())?.[1] : undefined;
    const derivedAnchor = root.kind === "Issue" ? /^derived:pr:(\d+)$/i.exec(root.id.trim())?.[1] : undefined;
    const incidentId = root.kind === "Incident" ? /^incident:[^:]+:.+$/i.test(root.id.trim()) : false;
    const commitSha =
      cause.kind === "Commit"
        ? /^(?:(?:commit|sha):)?([a-f0-9]{40})$/i.exec(cause.id.trim())?.[1]?.toLowerCase()
        : undefined;
    const deploymentId =
      cause.kind === "Deployment" && /^deployment:[^:]+:.+$/i.test(cause.id.trim()) ? cause.id.trim() : undefined;
    if ((!issueNumber && !derivedAnchor && !incidentId) || (cause.kind === "Commit" ? !commitSha : !deploymentId)) {
      throw new Error("INTRODUCED_BY evidence requires valid causal entity identities");
    }
    const citedText = edge.evidence
      .map((value) => {
        const citation = parseEvidenceCitation(value);
        const lines = files.get(citation.path)?.split(/\r?\n/) ?? [];
        return lines.slice(citation.startLine - 1, citation.endLine).join("\n");
      })
      .join("\n");
    const namesRoot = issueNumber
      ? new RegExp(`(?:#${issueNumber}\\b|\\bissue\\s*#?\\s*${issueNumber}\\b|/issues/${issueNumber}\\b)`, "i").test(
          citedText
        )
      : citedText.toLowerCase().includes(root.label.trim().toLowerCase()) ||
        citedText.toLowerCase().includes(root.id.trim().toLowerCase());
    const namesCause = commitSha
      ? citedText.toLowerCase().includes(commitSha)
      : Boolean(
          deploymentId &&
          (citedText.toLowerCase().includes(deploymentId.toLowerCase()) ||
            citedText.toLowerCase().includes(cause.label.trim().toLowerCase()))
        );
    if (!namesRoot || !namesCause) {
      const rootReference = issueNumber
        ? `Issue #${issueNumber}`
        : derivedAnchor
          ? `Issue ${root.label}`
          : `${root.kind} ${root.label}`;
      const causeReference = commitSha ? `commit ${commitSha}` : `Deployment ${cause.label}`;
      throw new Error(`INTRODUCED_BY evidence must explicitly name ${rootReference} and ${causeReference}`);
    }
    if (!edge.why) throw new Error("INTRODUCED_BY must include a causal explanation for human review");
  }
}

function parseNode(value: unknown): ContextGraphNode {
  if (!isRecord(value)) {
    throw new Error("contextGraph node must be an object");
  }
  const kind = requiredString(value.kind, "node.kind");
  if (!contextGraphNodeKinds.includes(kind as ContextGraphNodeKind)) {
    throw new Error(`unsupported contextGraph node kind: ${kind}`);
  }
  const id = requiredString(value.id, "node.id");
  return {
    id,
    kind: kind as ContextGraphNodeKind,
    label: requiredString(value.label, "node.label"),
    description: requiredString(value.description, "node.description"),
    ...(typeof value.path === "string" && value.path ? { path: value.path } : {}),
    evidence: requiredEvidence(value.evidence, `node ${id}`)
  };
}

function parseEdge(value: unknown): Omit<ContextGraphEdge, "id"> {
  if (!isRecord(value)) {
    throw new Error("contextGraph edge must be an object");
  }
  const plane = requiredString(value.plane, "edge.plane");
  if (plane !== "code" && plane !== "knowledge") {
    throw new Error(`unsupported contextGraph plane: ${plane}`);
  }
  const confidence = typeof value.confidence === "number" ? value.confidence : undefined;
  if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    throw new Error("edge confidence must be between 0 and 1");
  }
  return {
    source: requiredString(value.source, "edge.source"),
    target: requiredString(value.target, "edge.target"),
    predicate: normalizePredicate(requiredString(value.predicate, "edge.predicate")),
    plane,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(typeof value.why === "string" && value.why.trim() ? { why: value.why.trim() } : {}),
    evidence: requiredEvidence(value.evidence, "edge")
  };
}

function dedupeNodes(nodes: readonly ContextGraphNode[]): readonly ContextGraphNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

function dedupeEdges(edges: readonly ContextGraphEdge[]): readonly ContextGraphEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    if (seen.has(edge.id)) return false;
    seen.add(edge.id);
    return true;
  });
}

function normalizePredicate(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function requiredEvidence(value: unknown, owner: string): readonly string[] {
  const evidence = Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
  if (evidence.length === 0) throw new Error(`${owner} must include evidence`);
  evidence.forEach(parseEvidenceCitation);
  return evidence;
}

export function parseEvidenceCitation(value: string): EvidenceCitation {
  const match = /^(.*):(\d+)(?:-(\d+))?$/.exec(value);
  if (!match?.[1] || !match[2]) throw new Error(`invalid contextGraph evidence citation: ${value}`);
  const path = match[1];
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`contextGraph evidence path must be repository-relative: ${value}`);
  }
  const startLine = Number.parseInt(match[2], 10);
  const endLine = match[3] ? Number.parseInt(match[3], 10) : startLine;
  if (startLine < 1 || endLine < startLine) throw new Error(`invalid contextGraph evidence range: ${value}`);
  return { value, path, startLine, endLine };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
