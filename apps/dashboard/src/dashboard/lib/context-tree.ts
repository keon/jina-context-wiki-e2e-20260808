/**
 * Turns a flat list of knowledge documents into the folder structure the context
 * page browses.
 *
 * The shape comes from the engine's own identifiers rather than being invented
 * here. Every document carries a `logicalId` of the form
 * `kind:repository:subject`, where the subject may itself be a path — so
 * `component:omxyz/jina:api/server` is a component named `server` under `api`.
 * Grouping by repository, then kind, then the subject's segments gives a tree
 * that matches how the knowledge was actually derived.
 */

export type ContextDocumentSummary = {
  id: string;
  releaseId: string;
  logicalId: string;
  repository: string;
  ref?: string;
  kind: string;
  title: string;
  summary: string;
  confidence?: number;
  reviewStatus: string;
  commitSha?: string;
  createdAt: string;
};

export type ContextTreeNode = {
  /** Stable across renders, so expansion state survives a refresh. */
  path: string;
  name: string;
  kind: "repository" | "category" | "folder" | "document";
  children: ContextTreeNode[];
  document?: ContextDocumentSummary;
  /** Documents at or below this node, for the count shown beside a folder. */
  documentCount: number;
};

/**
 * A repository chooses its own folders, so most documents arrive as `topic` with
 * their structure in the path. Inserting a category level for those would add a
 * meaningless "Topic" folder above every real one, so the kind becomes a level
 * only when it says something the path does not.
 */
const STRUCTURAL_KINDS = new Set(["topic"]);

const KIND_LABELS: Record<string, string> = {
  architecture: "Architecture",
  component: "Components",
  feature: "Features",
  decision: "Decisions",
  change_summary: "Changes",
  incident: "Incidents",
  issue_explanation: "Issues",
  ownership: "Ownership",
  runbook: "Runbooks",
  glossary: "Glossary",
  flow: "Flows",
  pattern: "Patterns",
};

/** Keeps the tree's top level in a deliberate order rather than an alphabetical one. */
const KIND_ORDER = [
  "architecture",
  "component",
  "feature",
  "decision",
  "runbook",
  "ownership",
  "glossary",
  "change_summary",
  "incident",
  "issue_explanation",
  "flow",
  "pattern",
];

export function categoryLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/_/g, " ");
}

/**
 * The part of a logical ID that names the document within its kind.
 *
 * `kind:repository:subject` — but a repository contains a `/` and some subjects
 * contain `:`, so this takes everything after the second colon rather than
 * splitting naively.
 */
export function documentSubject(logicalId: string): string {
  const first = logicalId.indexOf(":");
  if (first < 0) return logicalId;
  const second = logicalId.indexOf(":", first + 1);
  if (second < 0) return logicalId.slice(first + 1);
  return logicalId.slice(second + 1);
}

/** A commit-shaped subject reads better shortened; everything else is left alone. */
function segmentLabel(segment: string, kind: string): string {
  if (kind === "change_summary" && /^[0-9a-f]{40}$/.test(segment))
    return segment.slice(0, 8);
  return segment;
}

/**
 * Segments are joined with a NUL rather than a slash. Repository names contain a
 * slash and so do subject paths, so a slash-joined key cannot be split back into
 * the segments it came from — which matters, because expansion state is keyed by
 * path and a selection is revealed by walking its ancestors.
 */
const PATH_SEPARATOR = "\u0000";

function childOf(
  parent: ContextTreeNode,
  name: string,
  kind: ContextTreeNode["kind"],
): ContextTreeNode {
  const path = `${parent.path}${PATH_SEPARATOR}${name}`;
  const existing = parent.children.find((node) => node.path === path);
  if (existing) return existing;
  const created: ContextTreeNode = {
    path,
    name,
    kind,
    children: [],
    documentCount: 0,
  };
  parent.children.push(created);
  return created;
}

function sortTree(node: ContextTreeNode, order?: string[]): void {
  node.children.sort((left, right) => {
    if (order) {
      const leftIndex = order.indexOf(left.name);
      const rightIndex = order.indexOf(right.name);
      if (leftIndex !== rightIndex) {
        return (
          (leftIndex < 0 ? order.length : leftIndex) -
          (rightIndex < 0 ? order.length : rightIndex)
        );
      }
    }
    // Folders before documents, so a category reads as structure then leaves.
    if (left.kind === "document" && right.kind !== "document") return 1;
    if (right.kind === "document" && left.kind !== "document") return -1;
    return left.name.localeCompare(right.name);
  });
  for (const child of node.children) sortTree(child);
}

function countDocuments(node: ContextTreeNode): number {
  node.documentCount =
    node.kind === "document"
      ? 1
      : node.children.reduce((sum, c) => sum + countDocuments(c), 0);
  return node.documentCount;
}

export function buildContextTree(
  documents: readonly ContextDocumentSummary[],
): ContextTreeNode[] {
  const root: ContextTreeNode = {
    path: "",
    name: "",
    kind: "folder",
    children: [],
    documentCount: 0,
  };
  for (const document of documents) {
    const repository = childOf(root, document.repository, "repository");
    // A document whose folders are its own goes straight under the repository;
    // its path already carries the structure a category level would duplicate.
    const category = STRUCTURAL_KINDS.has(document.kind)
      ? repository
      : childOf(repository, document.kind, "category");
    const segments = documentSubject(document.logicalId)
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
    // An architecture document has no subject worth nesting: it is the one
    // document that describes the repository itself.
    const leafSegments = segments.length ? segments : [document.title];
    let parent = category;
    for (const segment of leafSegments.slice(0, -1)) {
      parent = childOf(parent, segment, "folder");
    }
    const leafName = leafSegments[leafSegments.length - 1] ?? document.title;
    const leaf = childOf(parent, leafName, "document");
    leaf.name = segmentLabel(leafName, document.kind);
    // Newest revision wins: the listing is ordered newest first, so only take a
    // document for a leaf that does not have one yet.
    if (!leaf.document) leaf.document = document;
  }
  for (const repository of root.children) {
    sortTree(repository, KIND_ORDER);
  }
  root.children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of root.children) countDocuments(child);
  return root.children;
}

/** Every folder path from the root down to a document, for revealing a selection. */
export function ancestorPaths(path: string): string[] {
  const segments = path.split(PATH_SEPARATOR);
  const paths: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    paths.push(segments.slice(0, index).join(PATH_SEPARATOR));
  }
  return paths.filter(Boolean);
}
