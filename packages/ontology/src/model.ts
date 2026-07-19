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
  "Document"
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
    readonly executor: "daytona" | "fixture";
    readonly model: string;
    readonly sandboxId?: string;
  };
  readonly summary: string;
  readonly nodes: readonly OntologyNode[];
  readonly edges: readonly OntologyEdge[];
}

export interface OntologyBuildRequest {
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly taskId: string;
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
  readonly executor: "daytona" | "fixture";
  readonly model: string;
  readonly sandboxId?: string;
  readonly generated: GeneratedOntology;
}): OntologyGraph {
  const nodes = dedupeNodes(input.generated.nodes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = input.generated.edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map((edge) => ({
      ...edge,
      predicate: normalizePredicate(edge.predicate),
      id: stableId("edge", `${edge.source}:${edge.predicate}:${edge.target}:${edge.plane}`)
    }));

  if (!nodes.some((node) => node.kind === "Repository")) {
    throw new Error("generated ontology must contain a Repository node");
  }
  if (nodes.length < 2 || edges.length < 1) {
    throw new Error("generated ontology must contain at least two nodes and one valid edge");
  }

  return {
    id: stableId("graph", `${input.request.tenantId}:${input.request.repository}:${input.commitSha}:${input.request.taskId}`),
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

export function parseGeneratedOntology(value: unknown): GeneratedOntology {
  if (!isRecord(value) || typeof value.summary !== "string" || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new Error("Codex returned an invalid ontology document");
  }

  const nodes = value.nodes.map(parseNode);
  const edges = value.edges.map(parseEdge);
  return { summary: value.summary, nodes, edges };
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
  return {
    source: requiredString(value.source, "edge.source"),
    target: requiredString(value.target, "edge.target"),
    predicate: normalizePredicate(requiredString(value.predicate, "edge.predicate")),
    plane,
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
