import { createHash } from "node:crypto";

export const ontologyNodeKinds = [
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
  "Incident",
  "VirtualIssue"
] as const;

export type OntologyNodeKind = (typeof ontologyNodeKinds)[number];
export type OntologyPlane = "code" | "knowledge";

export interface OntologyNode {
  readonly id: string;
  readonly kind: OntologyNodeKind;
  readonly label: string;
  readonly description: string;
  readonly path?: string;
  readonly evidence: readonly string[];
}

export interface OntologyEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly predicate: string;
  readonly plane: OntologyPlane;
  readonly confidence?: number;
  /** Canonical assertion qualifiers retained by materialized knowledge projections. */
  readonly qualifiers?: Readonly<Record<string, string | number | boolean>>;
  /** Human-readable semantic rationale. Required for model-generated knowledge assertions. */
  readonly why?: string;
  readonly evidence: readonly string[];
}

export interface OntologyGraph {
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
  readonly nodes: readonly OntologyNode[];
  readonly edges: readonly OntologyEdge[];
  /** Exact parsed JSON downloaded from a model run; omitted from projections and persisted graph reads. */
  readonly rawModelOutput?: unknown;
}

export interface OntologyGraphSummary extends Omit<OntologyGraph, "nodes" | "edges"> {
  readonly nodeCount: number;
  readonly edgeCount: number;
}

export function summarizeOntologyGraph(graph: OntologyGraph): OntologyGraphSummary {
  const { nodes, edges, ...summary } = graph;
  return { ...summary, nodeCount: nodes.length, edgeCount: edges.length };
}

export interface OntologyBuildRequest {
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly commitSha?: string;
  readonly focusPaths?: readonly string[];
  /** PRs whose complete changed-file list contains durable regression/problem evidence. */
  readonly problemEvidencePullRequestNumbers?: readonly number[];
  /** Immutable source observations included in this generation's evidence fingerprint. */
  readonly sourceEvidence?: readonly OntologySourceEvidence[];
  readonly taskId: string;
  /** Cancels further external work when the caller loses its execution lease. */
  readonly signal?: AbortSignal;
}

export interface OntologySourceEvidence {
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly repository: string;
  readonly payloadSha: string;
  readonly payload: unknown;
}

export interface GeneratedOntology {
  readonly summary: string;
  readonly nodes: readonly OntologyNode[];
  readonly edges: readonly Omit<OntologyEdge, "id">[];
}

export interface EvidenceCitation {
  readonly value: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface OntologyExecutor {
  build(request: OntologyBuildRequest): Promise<OntologyGraph>;
}

export function createOntologyGraph(input: {
  readonly request: OntologyBuildRequest;
  readonly commitSha: string;
  readonly generatedAt: string;
  readonly executor: "daytona" | "fixture" | "projection";
  readonly model: string;
  readonly sandboxId?: string;
  readonly generated: GeneratedOntology;
  /** Projection read models are keyed by their canonical content instead of the worker task that rebuilt them. */
  readonly contentAddressed?: boolean;
  /** Assertion-generation observations may be valid with no supported semantic relationship. */
  readonly allowEmptyEdges?: boolean;
}): OntologyGraph {
  const nodes = dedupeNodes(input.generated.nodes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = input.generated.edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map((edge) => ({
      ...edge,
      predicate: normalizePredicate(edge.predicate),
      id: stableId("edge", `${edge.source}:${edge.predicate}:${edge.target}:${edge.plane}:${canonicalGraphJson(edge.qualifiers ?? {})}:${edge.why ?? ""}`)
    }));

  if (!nodes.some((node) => node.kind === "Repository")) {
    throw new Error("generated ontology must contain a Repository node");
  }
  if ((!input.allowEmptyEdges && (nodes.length < 2 || edges.length < 1)) || nodes.length < 1) {
    throw new Error("generated ontology must contain at least two nodes and one valid edge");
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
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalGraphJson(record[key])}`).join(",")}}`;
  }
  return value === undefined ? "undefined" : JSON.stringify(value);
}

export function parseGeneratedOntology(value: unknown): GeneratedOntology {
  if (!isRecord(value) || typeof value.summary !== "string" || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new Error("Codex returned an invalid ontology document");
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
export function sourceBackedModelEntityIds(evidence: readonly OntologySourceEvidence[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const item of evidence) {
    if (!isRecord(item.payload) || item.payload.removed === true) continue;
    const payload = item.payload;
    const repository = typeof payload.repository === "string" ? payload.repository : item.repository;
    if (payload.kind === "package_manifest" && typeof payload.ecosystem === "string" && Array.isArray(payload.dependencies)) {
      for (const dependency of payload.dependencies) {
        if (isRecord(dependency) && typeof dependency.name === "string") {
          ids.add(`package:${payload.ecosystem.toLowerCase()}:${dependency.name.toLowerCase()}`);
        }
      }
    }
    if (payload.kind === "service_definition" && typeof payload.source === "string" && typeof payload.externalId === "string") {
      ids.add(`service:${payload.source}:${payload.externalId}`);
      for (const dependency of Array.isArray(payload.dependsOnServices) ? payload.dependsOnServices : []) {
        if (isRecord(dependency) && typeof dependency.source === "string" && typeof dependency.externalId === "string") {
          ids.add(`service:${dependency.source}:${dependency.externalId}`);
        }
      }
    }
    if (payload.kind === "deployment" && typeof payload.source === "string" && typeof payload.externalId === "string") {
      ids.add(`deployment:${payload.source}:${payload.externalId}`);
      if (isRecord(payload.service) && typeof payload.service.source === "string" && typeof payload.service.externalId === "string") {
        ids.add(`service:${payload.service.source}:${payload.service.externalId}`);
      }
    }
    if (payload.kind === "incident" && typeof payload.source === "string" && typeof payload.externalId === "string") {
      ids.add(typeof payload.issueNumber === "number"
        ? `incident:github:${repository}#${payload.issueNumber}`
        : `incident:${payload.source}:${payload.externalId}`);
      if (isRecord(payload.impactedService) && typeof payload.impactedService.source === "string" && typeof payload.impactedService.externalId === "string") {
        ids.add(`service:${payload.impactedService.source}:${payload.impactedService.externalId}`);
      }
    }
  }
  return ids;
}

export function validateSourceBackedModelEntities(
  generated: GeneratedOntology,
  evidence: readonly OntologySourceEvidence[]
): void {
  const allowed = sourceBackedModelEntityIds(evidence);
  for (const node of generated.nodes) {
    if (!["Package", "Service", "Deployment", "Incident"].includes(node.kind)) continue;
    if (!allowed.has(node.id)) throw new Error(`${node.kind} ${node.id} is not anchored by deterministic source evidence`);
  }
}

export function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

export function ontologyEvidenceCitations(generated: GeneratedOntology): readonly EvidenceCitation[] {
  const values = new Set([
    ...generated.nodes.flatMap((node) => node.evidence),
    ...generated.edges.flatMap((edge) => edge.evidence)
  ]);
  return [...values].map(parseEvidenceCitation);
}

export async function validateOntologyEvidence(
  generated: GeneratedOntology,
  readFile: (path: string) => Promise<string>
): Promise<void> {
  const files = new Map<string, string>();
  for (const citation of ontologyEvidenceCitations(generated)) {
    let source = files.get(citation.path);
    if (source === undefined) {
      try {
        source = await readFile(citation.path);
      } catch {
        throw new Error(`ontology evidence file does not exist: ${citation.path}`);
      }
      files.set(citation.path, source);
    }
    const lineCount = source.split(/\r?\n/).length;
    if (citation.startLine > lineCount || citation.endLine > lineCount) {
      throw new Error(`ontology evidence is outside ${citation.path}: ${citation.value}`);
    }
  }
  validateCausalEvidenceContents(generated, files);
}

/**
 * A merged PR that explicitly describes an untracked repair and changes a
 * durable problem/evidence file must yield a reviewable virtual Issue proposal.
 * The rule only detects a missing proposal; the model still names the problem,
 * explains it, and supplies repository citations.
 */
export function validateRequiredVirtualIssues(
  generated: GeneratedOntology,
  sourceEvidence: readonly OntologySourceEvidence[],
  problemEvidencePullRequestNumbers: readonly number[] = []
): void {
  for (const number of requiredVirtualIssuePullRequestNumbers(sourceEvidence, problemEvidencePullRequestNumbers)) {
    const legacyIssueId = `virtual:pr:${number}`;
    const node = generated.nodes.find((candidate) =>
      candidate.kind === "VirtualIssue" && candidate.id === legacyIssueId
    ) ?? generated.nodes.find((candidate) => candidate.kind === "Issue" && candidate.id === legacyIssueId);
    const resolutions = node ? generated.edges.filter((edge) =>
      (edge.predicate === "RESOLVED_BY" && edge.source === node.id) ||
      (edge.predicate === "RESOLVES" && edge.target === node.id)
    ) : [];
    const resolution = resolutions[0];
    const pullRequestId = resolution?.predicate === "RESOLVED_BY" ? resolution.target : resolution?.source;
    const pullRequest = pullRequestId ? generated.nodes.find((candidate) => candidate.id === pullRequestId) : undefined;
    const pullRequestNumber = pullRequest?.kind === "PullRequest"
      ? /^(?:pr:|#)?(\d+)$/i.exec(pullRequest.id.trim())?.[1]
      : undefined;
    if (!node || resolutions.length !== 1 || pullRequestNumber !== String(number)) {
      throw new Error(`pull request #${number} explicitly repairs an untracked problem and requires virtual Issue ${legacyIssueId}`);
    }
  }
}

export function requiredVirtualIssuePullRequestNumbers(
  sourceEvidence: readonly OntologySourceEvidence[],
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
    const problem = /\b(?:bug|regression|incorrect|broken|fail(?:s|ed|ing|ure)?|cannot|can't|unable|denied|wrong)\b/i.test(text);
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

/** Detect only explicit root-cause records; proximity or PR membership never qualifies. */
export function requiredCausalAnchors(
  files: readonly CausalEvidenceFile[],
  virtualIssuePullRequestNumbers: readonly number[] = []
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
    const issueId = issueNumber ?? (
      /\bno\s+github\s+issue\s+was\s+opened\b/i.test(file.content) && virtualIssuePullRequestNumbers.length === 1
        ? `virtual:pr:${virtualIssuePullRequestNumbers[0]}`
        : undefined
    );
    if (issueId) {
      const shaLine = Math.max(1, lines.findIndex((line) => line.toLowerCase().includes(commitSha)) + 1);
      const issueLine = issueNumber
        ? Math.max(1, lines.findIndex((line) => issuePattern.test(line)) + 1)
        : 1;
      anchors.push({
        issueId,
        commitSha,
        evidencePath: file.path,
        startLine: Math.min(issueLine, shaLine),
        endLine: Math.min(lines.length, shaLine + 2)
      });
    }
  }
  return anchors.filter((anchor, index) => anchors.findIndex((candidate) =>
    candidate.issueId === anchor.issueId && candidate.commitSha === anchor.commitSha
  ) === index);
}

export function validateRequiredCausalAssertions(
  generated: GeneratedOntology,
  anchors: readonly RequiredCausalAnchor[]
): void {
  for (const anchor of anchors) {
    const issue = generated.nodes.find((node) => (node.kind === "Issue" || node.kind === "VirtualIssue") && node.id === anchor.issueId);
    const commit = generated.nodes.find((node) => node.kind === "Commit" && node.id.toLowerCase() === anchor.commitSha);
    const edge = issue && commit ? generated.edges.find((candidate) =>
      candidate.predicate === "INTRODUCED_BY" && candidate.source === issue.id && candidate.target === commit.id
    ) : undefined;
    const spansAnchor = edge?.evidence.some((value) => {
      const citation = parseEvidenceCitation(value);
      return citation.path === anchor.evidencePath && citation.startLine <= anchor.startLine && citation.endLine >= anchor.endLine;
    });
    if (!edge || !spansAnchor) {
      throw new Error(`explicit root-cause evidence requires Issue ${anchor.issueId} INTRODUCED_BY commit ${anchor.commitSha}`);
    }
  }
}

export function isProblemEvidencePath(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  const baseName = segments.at(-1) ?? "";
  return segments.some((segment) => /^(?:incidents?|postmortems?|root[-_]?causes?|bugs?|regressions?)$/i.test(segment))
    || /(?:^|[-_.])(?:incident|postmortem|root[-_]?cause|bug[-_]?report|regression[-_]?(?:test|spec))(?:[-_.]|$)/i.test(baseName)
    || /(?:\.|[-_])(?:test|spec)\.[^/]+$/i.test(baseName);
}

function validateCausalEvidenceContents(generated: GeneratedOntology, files: ReadonlyMap<string, string>): void {
  const nodes = new Map(generated.nodes.map((node) => [node.id, node]));
  for (const edge of generated.edges) {
    if (edge.predicate !== "INTRODUCED_BY") continue;
    const root = nodes.get(edge.source);
    const cause = nodes.get(edge.target);
    if (!root || !["Issue", "VirtualIssue", "Incident"].includes(root.kind) ||
      !cause || !["Commit", "Deployment"].includes(cause.kind)) {
      throw new Error("INTRODUCED_BY evidence must connect an Issue, VirtualIssue, or Incident to a Commit or Deployment");
    }
    const issueNumber = root.kind === "Issue" ? /^(?:issue:)?#?(\d+)$/i.exec(root.id.trim())?.[1] : undefined;
    const virtualAnchor = root.kind === "VirtualIssue" || root.kind === "Issue"
      ? /^virtual:pr:(\d+)$/i.exec(root.id.trim())?.[1]
      : undefined;
    const incidentId = root.kind === "Incident" ? /^incident:[^:]+:.+$/i.test(root.id.trim()) : false;
    const commitSha = cause.kind === "Commit"
      ? /^(?:(?:commit|sha):)?([a-f0-9]{40})$/i.exec(cause.id.trim())?.[1]?.toLowerCase()
      : undefined;
    const deploymentId = cause.kind === "Deployment" && /^deployment:[^:]+:.+$/i.test(cause.id.trim())
      ? cause.id.trim()
      : undefined;
    if ((!issueNumber && !virtualAnchor && !incidentId) || (cause.kind === "Commit" ? !commitSha : !deploymentId)) {
      throw new Error("INTRODUCED_BY evidence requires valid causal entity identities");
    }
    const citedText = edge.evidence.map((value) => {
      const citation = parseEvidenceCitation(value);
      const lines = files.get(citation.path)?.split(/\r?\n/) ?? [];
      return lines.slice(citation.startLine - 1, citation.endLine).join("\n");
    }).join("\n");
    const namesRoot = issueNumber
      ? new RegExp(`(?:#${issueNumber}\\b|\\bissue\\s*#?\\s*${issueNumber}\\b|/issues/${issueNumber}\\b)`, "i").test(citedText)
      : citedText.toLowerCase().includes(root.label.trim().toLowerCase()) || citedText.toLowerCase().includes(root.id.trim().toLowerCase());
    const namesCause = commitSha
      ? citedText.toLowerCase().includes(commitSha)
      : Boolean(deploymentId && (citedText.toLowerCase().includes(deploymentId.toLowerCase()) || citedText.toLowerCase().includes(cause.label.trim().toLowerCase())));
    if (!namesRoot || !namesCause) {
      const rootReference = issueNumber ? `Issue #${issueNumber}` : virtualAnchor ? `VirtualIssue ${root.label}` : `${root.kind} ${root.label}`;
      const causeReference = commitSha ? `commit ${commitSha}` : `Deployment ${cause.label}`;
      throw new Error(`INTRODUCED_BY evidence must explicitly name ${rootReference} and ${causeReference}`);
    }
    if (!edge.why) throw new Error("INTRODUCED_BY must include a causal explanation for human review");
  }
}

function parseNode(value: unknown): OntologyNode {
  if (!isRecord(value)) {
    throw new Error("ontology node must be an object");
  }
  const kind = requiredString(value.kind, "node.kind");
  if (!ontologyNodeKinds.includes(kind as OntologyNodeKind)) {
    throw new Error(`unsupported ontology node kind: ${kind}`);
  }
  const id = requiredString(value.id, "node.id");
  return {
    id,
    kind: kind as OntologyNodeKind,
    label: requiredString(value.label, "node.label"),
    description: requiredString(value.description, "node.description"),
    ...(typeof value.path === "string" && value.path ? { path: value.path } : {}),
    evidence: requiredEvidence(value.evidence, `node ${id}`)
  };
}

function parseEdge(value: unknown): Omit<OntologyEdge, "id"> {
  if (!isRecord(value)) {
    throw new Error("ontology edge must be an object");
  }
  const plane = requiredString(value.plane, "edge.plane");
  if (plane !== "code" && plane !== "knowledge") {
    throw new Error(`unsupported ontology plane: ${plane}`);
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

function dedupeNodes(nodes: readonly OntologyNode[]): readonly OntologyNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

function dedupeEdges(edges: readonly OntologyEdge[]): readonly OntologyEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    if (seen.has(edge.id)) return false;
    seen.add(edge.id);
    return true;
  });
}

function normalizePredicate(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

function requiredEvidence(value: unknown, owner: string): readonly string[] {
  const evidence = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
  if (evidence.length === 0) throw new Error(`${owner} must include evidence`);
  evidence.forEach(parseEvidenceCitation);
  return evidence;
}

function parseEvidenceCitation(value: string): EvidenceCitation {
  const match = /^(.*):(\d+)(?:-(\d+))?$/.exec(value);
  if (!match?.[1] || !match[2]) throw new Error(`invalid ontology evidence citation: ${value}`);
  const path = match[1];
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`ontology evidence path must be repository-relative: ${value}`);
  }
  const startLine = Number.parseInt(match[2], 10);
  const endLine = match[3] ? Number.parseInt(match[3], 10) : startLine;
  if (startLine < 1 || endLine < startLine) throw new Error(`invalid ontology evidence range: ${value}`);
  return { value, path, startLine, endLine };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
