import type { OntologyEdge, OntologyGraph, OntologyNode, OntologyNodeKind } from "./model.js";
import type { RetrievalCitation, RetrievalItem, RetrievalRequest } from "./retrieval.js";

export const causalRootKinds = ["Issue", "Feature", "Incident", "Service"] as const;
export type CausalRootKind = (typeof causalRootKinds)[number];

export interface CausalTraceNode {
  readonly id: string;
  readonly kind: OntologyNodeKind;
  readonly label: string;
  readonly description: string;
  readonly path?: string;
}

export interface CausalTracePath {
  readonly kind: "cause" | "resolution" | "implementation" | "impact" | "dependency" | "deployment" | "documentation" | "ownership" | "move" | "structure";
  readonly nodes: readonly CausalTraceNode[];
  readonly edgeIds: readonly string[];
  readonly predicates: readonly string[];
  readonly why?: string;
  readonly citations: readonly RetrievalCitation[];
}

export interface CausalTraceProjection {
  readonly root: CausalTraceNode;
  readonly causes: readonly CausalTracePath[];
  readonly resolutions: readonly CausalTracePath[];
  readonly implementations: readonly CausalTracePath[];
  readonly affectedEntities: readonly CausalTracePath[];
  readonly dependencies: readonly CausalTracePath[];
  readonly deployments: readonly CausalTracePath[];
  readonly documentation: readonly CausalTracePath[];
  readonly ownership: readonly CausalTracePath[];
  readonly movedFrom: readonly CausalTracePath[];
  readonly structuralPaths: readonly CausalTracePath[];
  readonly citations: readonly RetrievalCitation[];
}

export interface CounterfactualEvaluation {
  readonly answer: string;
  readonly basis: "graph-derived";
  readonly intervention?: CausalTraceNode;
  readonly outcome: CausalTraceNode;
  readonly removedPaths: readonly CausalTracePath[];
  readonly remainingPaths: readonly CausalTracePath[];
  readonly citedClaims: readonly { readonly text: string; readonly citations: readonly RetrievalCitation[] }[];
  readonly unresolvedAmbiguities: readonly string[];
  readonly coverageGaps: readonly string[];
}

export function causalTraceItemsFromGraph(graph: OntologyGraph, request: RetrievalRequest): readonly RetrievalItem[] {
  const roots = selectRoots(graph, request);
  return roots.map((root, index) => {
    const trace = buildCausalTrace(graph, root);
    return {
      kind: "causal_trace",
      title: `${root.kind}: ${root.label}`,
      data: trace as unknown as Readonly<Record<string, unknown>>,
      citations: trace.citations,
      score: roots.length - index
    };
  });
}

export function buildCausalTrace(graph: OntologyGraph, root: OntologyNode): CausalTraceProjection {
  if (!causalRootKinds.includes(root.kind as CausalRootKind)) throw new Error(`${root.kind} cannot root a causal trace`);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = indexEdges(graph.edges, (edge) => edge.source);
  const incoming = indexEdges(graph.edges, (edge) => edge.target);
  const direct = (edge: OntologyEdge, kind: CausalTracePath["kind"], reverse = false): CausalTracePath | undefined => {
    const other = nodes.get(reverse ? edge.source : edge.target);
    if (!other) return undefined;
    return path(kind, reverse ? [root, other] : [root, other], [edge], graph);
  };

  const causes = (outgoing.get(root.id) ?? []).filter((edge) => edge.predicate === "INTRODUCED_BY").flatMap((edge) => {
    const cause = nodes.get(edge.target);
    if (!cause) return [];
    const containing = (incoming.get(cause.id) ?? []).filter((candidate) =>
      candidate.predicate === "INCLUDES" || candidate.predicate === "MERGED_AS"
    );
    if (containing.length === 0) return [path("cause", [root, cause], [edge], graph)];
    return containing.flatMap((candidate) => {
      const pullRequest = nodes.get(candidate.source);
      return pullRequest ? [path("cause", [root, cause, pullRequest], [edge, candidate], graph)] : [];
    });
  });

  const resolutions = [
    ...(outgoing.get(root.id) ?? []).filter((edge) => edge.predicate === "RESOLVED_BY").flatMap((edge) => direct(edge, "resolution") ?? []),
    ...(incoming.get(root.id) ?? []).filter((edge) => edge.predicate === "RESOLVES").flatMap((edge) => {
      const resolver = nodes.get(edge.source);
      return resolver ? [path("resolution", [root, resolver], [edge], graph)] : [];
    })
  ];

  const implementations = [
    ...(incoming.get(root.id) ?? []).filter((edge) => edge.predicate === "IMPLEMENTS").flatMap((edge) => {
      const implementation = nodes.get(edge.source);
      return implementation ? [path("implementation", [root, implementation], [edge], graph)] : [];
    }),
    ...(outgoing.get(root.id) ?? []).filter((edge) => edge.predicate === "IMPLEMENTS").flatMap((edge) => direct(edge, "implementation") ?? [])
  ];

  const affectedEntities = [
    ...(incoming.get(root.id) ?? []).filter((edge) => edge.predicate === "LIKELY_AFFECTS").flatMap((edge) => {
      const change = nodes.get(edge.source);
      return change ? [path("impact", [root, change], [edge], graph)] : [];
    }),
    ...(outgoing.get(root.id) ?? []).filter((edge) => edge.predicate === "LIKELY_AFFECTS" || edge.predicate === "INCIDENT_IMPACTS")
      .flatMap((edge) => direct(edge, "impact") ?? []),
    ...(incoming.get(root.id) ?? []).filter((edge) => edge.predicate === "INCIDENT_IMPACTS").flatMap((edge) => {
      const incident = nodes.get(edge.source);
      return incident ? [path("impact", [root, incident], [edge], graph)] : [];
    })
  ];

  const dependencies: CausalTracePath[] = (outgoing.get(root.id) ?? [])
    .filter((edge) => edge.predicate === "DEPENDS_ON").flatMap((edge) => direct(edge, "dependency") ?? []);
  for (const implementation of implementations) {
    const implementationNode = graph.nodes.find((node) => node.id === implementation.nodes[1]?.id);
    if (!implementationNode) continue;
    const fileEdge = implementationNode.kind === "Symbol"
      ? (incoming.get(implementationNode.id) ?? []).find((edge) => edge.predicate === "DECLARES")
      : undefined;
    const file = fileEdge ? nodes.get(fileEdge.source) : implementationNode.kind === "File" ? implementationNode : undefined;
    if (!file) continue;
    for (const dependencyEdge of (outgoing.get(file.id) ?? []).filter((edge) => edge.predicate === "IMPORTS")) {
      const dependency = nodes.get(dependencyEdge.target);
      if (dependency?.kind === "Package") dependencies.push(path("dependency", [root, implementationNode, file, dependency], [
        ...implementation.edgeIds.map((id) => graph.edges.find((edge) => edge.id === id)).filter((edge): edge is OntologyEdge => Boolean(edge)),
        ...(fileEdge ? [fileEdge] : []), dependencyEdge
      ], graph));
    }
  }

  const deployments = [
    ...(incoming.get(root.id) ?? []).filter((edge) => edge.predicate === "TARGETS").flatMap((edge) => {
      const deployment = nodes.get(edge.source);
      return deployment ? [path("deployment", [root, deployment], [edge], graph)] : [];
    }),
    ...causes.filter((candidate) => candidate.nodes.some((node) => node.kind === "Deployment")).map((candidate) => ({ ...candidate, kind: "deployment" as const }))
  ];
  if (root.kind === "Incident") {
    for (const impact of affectedEntities) {
      const service = impact.nodes.find((node) => node.kind === "Service");
      if (!service) continue;
      for (const target of (incoming.get(service.id) ?? []).filter((edge) => edge.predicate === "TARGETS")) {
        const deployment = nodes.get(target.source);
        if (deployment) deployments.push(path("deployment", [root, service, deployment], [
          graph.edges.find((edge) => edge.id === impact.edgeIds[0])!, target
        ].filter(Boolean), graph));
      }
    }
  }

  const documentation = (outgoing.get(root.id) ?? []).filter((edge) => edge.predicate === "DOCUMENTED_BY")
    .flatMap((edge) => direct(edge, "documentation") ?? []);
  const ownership = (outgoing.get(root.id) ?? []).filter((edge) => edge.predicate === "OWNED_BY")
    .flatMap((edge) => direct(edge, "ownership") ?? []);
  const movedFrom: CausalTracePath[] = [];
  const structuralPaths: CausalTracePath[] = [];
  for (const implementation of implementations) {
    const implementationNode = nodes.get(implementation.nodes[1]?.id ?? "");
    if (!implementationNode) continue;
    for (const move of (outgoing.get(implementationNode.id) ?? []).filter((edge) => edge.predicate === "MOVED_FROM")) {
      const previous = nodes.get(move.target);
      if (previous) movedFrom.push(path("move", [root, implementationNode, previous], [
        graph.edges.find((edge) => edge.id === implementation.edgeIds[0])!, move
      ].filter(Boolean), graph));
    }
    for (const structural of [
      ...(outgoing.get(implementationNode.id) ?? []), ...(incoming.get(implementationNode.id) ?? [])
    ].filter((edge) => ["CALLS", "IMPORTS"].includes(edge.predicate))) {
      const otherId = structural.source === implementationNode.id ? structural.target : structural.source;
      const other = nodes.get(otherId);
      if (other) structuralPaths.push(path("structure", [root, implementationNode, other], [
        graph.edges.find((edge) => edge.id === implementation.edgeIds[0])!, structural
      ].filter(Boolean), graph));
    }
  }

  const groups = [causes, resolutions, implementations, affectedEntities, dependencies, deployments, documentation, ownership, movedFrom, structuralPaths]
    .map(dedupePaths);
  const citations = dedupeCitations(groups.flatMap((group) => group.flatMap((candidate) => candidate.citations)));
  return {
    root: causalNode(root), causes: groups[0]!, resolutions: groups[1]!, implementations: groups[2]!,
    affectedEntities: groups[3]!, dependencies: groups[4]!, deployments: groups[5]!, documentation: groups[6]!,
    ownership: groups[7]!, movedFrom: groups[8]!, structuralPaths: groups[9]!, citations
  };
}

export function evaluateCounterfactual(trace: CausalTraceProjection, question: string): CounterfactualEvaluation {
  const allPaths = dedupePaths([
    ...trace.causes, ...trace.resolutions, ...trace.implementations, ...trace.affectedEntities,
    ...trace.dependencies, ...trace.deployments, ...trace.documentation, ...trace.ownership,
    ...trace.movedFrom, ...trace.structuralPaths
  ]);
  const candidates = allPaths.flatMap((candidate) => candidate.nodes).filter((node) => node.id !== trace.root.id);
  const interventionMatches = selectInterventionNodes(candidates, question);
  if (interventionMatches.length !== 1) {
    return {
      answer: interventionMatches.length === 0
        ? `I could not resolve the intervention in the current reviewed graph for ${trace.root.label}.`
        : `The intervention is ambiguous across ${interventionMatches.length} graph entities.`,
      basis: "graph-derived", outcome: trace.root, removedPaths: [], remainingPaths: allPaths,
      citedClaims: [], unresolvedAmbiguities: interventionMatches.length > 1 ? ["Select one intervention entity."] : [],
      coverageGaps: interventionMatches.length === 0 ? ["The intervention is not present in this materialized causal trace."] : []
    };
  }
  const intervention = interventionMatches[0]!;
  const relevant = counterfactualPaths(trace, intervention);
  const removedPaths = relevant.filter((candidate) => candidate.nodes.some((node) => node.id === intervention.id));
  const remainingPaths = relevant.filter((candidate) => !candidate.nodes.some((node) => node.id === intervention.id));
  const citedClaims: { text: string; citations: readonly RetrievalCitation[] }[] = [];
  const removedCitations = dedupeCitations(removedPaths.flatMap((candidate) => candidate.citations));
  if (removedPaths.length > 0 && removedCitations.length > 0) citedClaims.push({
    text: `Removing ${intervention.label} removes ${removedPaths.length} currently known reviewed path${removedPaths.length === 1 ? "" : "s"}.`,
    citations: removedCitations
  });
  const answer = counterfactualAnswer(trace, intervention, removedPaths, remainingPaths);
  return {
    answer, basis: "graph-derived", intervention, outcome: trace.root, removedPaths, remainingPaths,
    citedClaims, unresolvedAmbiguities: [],
    coverageGaps: relevant.length === 0
      ? ["No reviewed causal, impact, implementation, dependency, or deployment path is available."]
      : removedPaths.length > 0 && removedCitations.length === 0
        ? ["The matching reviewed path has no available citation or evidence at this ref."]
        : []
  };
}

function counterfactualPaths(trace: CausalTraceProjection, intervention: CausalTraceNode): readonly CausalTracePath[] {
  if (intervention.kind === "PullRequest" || intervention.kind === "Commit" || intervention.kind === "Deployment") {
    const groups = [trace.causes, trace.resolutions, trace.deployments, trace.affectedEntities];
    const matchingGroups = groups.filter((group) => group.some((candidate) => candidate.nodes.some((node) => node.id === intervention.id)));
    return dedupePaths(matchingGroups.flat());
  }
  if (intervention.kind === "Package") return trace.dependencies;
  if (intervention.kind === "Service") {
    return dedupePaths([...trace.dependencies, ...trace.affectedEntities, ...trace.deployments]);
  }
  if (intervention.kind === "File" || intervention.kind === "Symbol") {
    return dedupePaths([...trace.implementations, ...trace.dependencies, ...trace.movedFrom, ...trace.structuralPaths]);
  }
  return dedupePaths([...trace.causes, ...trace.implementations, ...trace.affectedEntities]);
}

function counterfactualAnswer(
  trace: CausalTraceProjection,
  intervention: CausalTraceNode,
  removedPaths: readonly CausalTracePath[],
  remainingPaths: readonly CausalTracePath[]
): string {
  if (intervention.kind === "Package") {
    if (removedPaths.length === 0) return `${intervention.label} is present, but no reviewed implementation dependency path uses it.`;
    return `Excluding ${intervention.label} removes ${removedPaths.length} currently known reviewed implementation dependency path${removedPaths.length === 1 ? "" : "s"} for ${trace.root.label}; ${remainingPaths.length} known dependency path${remainingPaths.length === 1 ? " remains" : "s remain"}. This does not prove whether uncaptured implementations would still work.`;
  }
  if (intervention.kind === "File" || intervention.kind === "Symbol") {
    if (removedPaths.length === 0) return `${intervention.label} is present, but no reviewed implementation path depends on it.`;
    return `Disabling ${intervention.label} removes ${removedPaths.length} currently known reviewed implementation path${removedPaths.length === 1 ? "" : "s"}; ${remainingPaths.length} known path${remainingPaths.length === 1 ? " remains" : "s remain"} for ${trace.root.label}.`;
  }
  if (removedPaths.length === 0) return `${intervention.label} is present in the trace, but no reviewed path to ${trace.root.label} depends on it.`;
  if (remainingPaths.length === 0) return `Removing ${intervention.label} eliminates every currently known reviewed path to ${trace.root.label}. This does not prove the outcome could never occur through an unknown path.`;
  return `Removing ${intervention.label} eliminates ${removedPaths.length} currently known reviewed path${removedPaths.length === 1 ? "" : "s"}, but ${remainingPaths.length} alternative known path${remainingPaths.length === 1 ? " remains" : "s remain"} to ${trace.root.label}.`;
}

function selectRoots(graph: OntologyGraph, request: RetrievalRequest): OntologyNode[] {
  const candidates = graph.nodes.filter((node) => causalRootKinds.includes(node.kind as CausalRootKind));
  if (request.rootEntityId) return candidates.filter((node) => node.id === request.rootEntityId);
  const issue = request.issueNumber ? `#${request.issueNumber}` : undefined;
  const text = (request.issueText ?? request.featureText ?? request.rootText ?? "").trim().toLowerCase();
  const query = request.query?.toLowerCase() ?? "";
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const pullRequestNumber = request.pullRequestNumber;
  const commitSha = request.commitSha?.toLowerCase();
  const packageName = /\bpackage\s+["'`]?([^"'`,?]+?)["'`]?(?:\s+(?:were|was|is|had|excluded|removed)|,|\?|$)/i.exec(query)?.[1]?.trim().toLowerCase();
  return candidates.map((node) => {
    const haystack = `${node.label} ${node.description}`.toLowerCase();
    let score = 0;
    if (issue && (haystack.includes(issue) || haystack.includes(`issue:${request.issueNumber}`))) score += 100;
    if (text && haystack.includes(text)) score += 80;
    if (text) score += text.split(/\s+/).filter((token) => token.length > 2 && haystack.includes(token)).length;
    if (/\bincident\b/.test(query) && node.kind === "Incident") score += 20;
    if (/\bservice\b/.test(query) && node.kind === "Service") score += 20;
    if (/\bfeature\b|implement/.test(query) && node.kind === "Feature") score += 20;
    if (/derived issue|unlinked/.test(query) && node.kind === "Issue" && node.id.includes("derived:issue:")) score += 20;
    const traceEdges = graph.edges.filter((edge) => edge.source === node.id || edge.target === node.id);
    if (pullRequestNumber && traceEdges.some((edge) => {
      const other = nodeById.get(edge.source === node.id ? edge.target : edge.source);
      return other?.kind === "PullRequest" && new RegExp(`(?:#|:)${pullRequestNumber}(?:\\b|$)`).test(`${other.label} ${other.description} ${other.id}`);
    })) score += 120;
    if (commitSha && traceEdges.some((edge) => {
      const other = nodeById.get(edge.source === node.id ? edge.target : edge.source);
      return other?.kind === "Commit" && `${other.label} ${other.description} ${other.id}`.toLowerCase().includes(commitSha);
    })) score += 120;
    if ((pullRequestNumber || commitSha) && traceEdges.some((edge) => {
      if (edge.predicate !== "INTRODUCED_BY") return false;
      const cause = nodeById.get(edge.target);
      if (cause?.kind !== "Commit") return false;
      return graph.edges.some((container) => {
        if (container.target !== cause.id || !["INCLUDES", "MERGED_AS"].includes(container.predicate)) return false;
        const pullRequest = nodeById.get(container.source);
        if (pullRequestNumber && pullRequest?.kind === "PullRequest" && new RegExp(`(?:#|:)${pullRequestNumber}(?:\\b|$)`).test(`${pullRequest.label} ${pullRequest.description} ${pullRequest.id}`)) return true;
        return Boolean(commitSha && `${cause.label} ${cause.description} ${cause.id}`.toLowerCase().includes(commitSha));
      });
    })) score += 120;
    const implementationEdges = graph.edges.filter((edge) => edge.predicate === "IMPLEMENTS" && edge.target === node.id);
    if (packageName && implementationEdges.some((implementation) => {
      const source = nodeById.get(implementation.source);
      const fileId = source?.kind === "Symbol"
        ? graph.edges.find((edge) => edge.predicate === "DECLARES" && edge.target === source.id)?.source
        : source?.kind === "File" ? source.id : undefined;
      return Boolean(fileId && graph.edges.some((edge) => {
        if (edge.source !== fileId || edge.predicate !== "IMPORTS") return false;
        const dependency = nodeById.get(edge.target);
        return dependency?.kind === "Package" && `${dependency.label} ${dependency.description}`.toLowerCase().includes(packageName);
      }));
    })) score += 120;
    if (/\b(?:renamed?|moved?|previously)\b/.test(query) && implementationEdges.some((implementation) =>
      graph.edges.some((edge) => edge.source === implementation.source && edge.predicate === "MOVED_FROM")
    )) score += 120;
    return { node, score };
  }).filter((candidate) => candidate.score > 0 || (!issue && !text && candidates.length === 1))
    .sort((left, right) => right.score - left.score || left.node.label.localeCompare(right.node.label))
    .map((candidate) => candidate.node);
}

function selectInterventionNodes(nodes: readonly CausalTraceNode[], question: string): CausalTraceNode[] {
  const unique = new Map(nodes.map((node) => [node.id, node]));
  const pullRequest = /\b(?:pr|pull request)\s*#?\s*(\d+)\b/i.exec(question)?.[1];
  const commit = /\b(?:commit|sha)\s*[:#]?\s*([a-f0-9]{7,40})\b/i.exec(question)?.[1]?.toLowerCase();
  const packageName = /\bpackage\s+["'`]?([^"'`,?]+?)["'`]?(?:\s+(?:were|was|is|had|excluded|removed)|,|\?|$)/i.exec(question)?.[1]?.trim().toLowerCase();
  const deploymentName = /\bdeployment\s+["'`#]?([^"'`,?]+?)["'`]?(?:\s+(?:were|was|is|had|excluded|removed)|,|\?|$)/i.exec(question)?.[1]?.trim().toLowerCase();
  const implementationName = /\b(?:symbol|file|implementation(?:\s+path)?)\s+["'`]?([^"'`,?]+?)["'`]?(?:\s+(?:were|was|is|had|disabled|excluded|removed)|,|\?|$)/i.exec(question)?.[1]?.trim().toLowerCase();
  return [...unique.values()].filter((node) => {
    const haystack = `${node.label} ${node.description}`.toLowerCase();
    if (pullRequest) return node.kind === "PullRequest" && (haystack.includes(`#${pullRequest}`) || haystack.endsWith(`:${pullRequest}`));
    if (commit) return node.kind === "Commit" && haystack.includes(commit);
    if (packageName) return node.kind === "Package" && haystack.includes(packageName);
    if (deploymentName) return node.kind === "Deployment" && haystack.includes(deploymentName);
    if (implementationName) return (node.kind === "File" || node.kind === "Symbol") && haystack.includes(implementationName);
    return false;
  });
}

function path(kind: CausalTracePath["kind"], nodes: readonly (OntologyNode | CausalTraceNode)[], edges: readonly OntologyEdge[], graph: OntologyGraph): CausalTracePath {
  const citations = dedupeCitations([
    ...edges.flatMap((edge) => citationsForEdge(edge, graph)),
    { kind: "entity", id: nodes[0]!.id, repository: graph.repository, commitSha: graph.commitSha }
  ]);
  const why = edges.map((edge) => edge.why).find((value): value is string => Boolean(value));
  return {
    kind, nodes: nodes.map(causalNode), edgeIds: edges.map((edge) => edge.id), predicates: edges.map((edge) => edge.predicate),
    ...(why ? { why } : {}), citations
  };
}

function citationsForEdge(edge: OntologyEdge, graph: OntologyGraph): RetrievalCitation[] {
  return edge.evidence.flatMap((value): RetrievalCitation[] => {
    if (value.startsWith("assertion:")) return [{ kind: "assertion", id: value.slice("assertion:".length), repository: graph.repository, commitSha: graph.commitSha }];
    if (value.startsWith("observation:")) return [{ kind: "observation", id: value.slice("observation:".length), repository: graph.repository }];
    const match = /^(.*):(\d+)(?:-(\d+))?$/.exec(value);
    if (!match?.[1] || !match[2]) return [];
    return [{
      kind: "code", id: `${graph.commitSha}:${value}`, repository: graph.repository, commitSha: graph.commitSha,
      path: match[1], startLine: Number.parseInt(match[2], 10), endLine: Number.parseInt(match[3] ?? match[2], 10)
    }];
  });
}

function causalNode(node: OntologyNode | CausalTraceNode): CausalTraceNode {
  return { id: node.id, kind: node.kind, label: node.label, description: node.description, ...(node.path ? { path: node.path } : {}) };
}

function indexEdges(edges: readonly OntologyEdge[], key: (edge: OntologyEdge) => string): Map<string, OntologyEdge[]> {
  const index = new Map<string, OntologyEdge[]>();
  for (const edge of edges) index.set(key(edge), [...(index.get(key(edge)) ?? []), edge]);
  return index;
}

function dedupePaths(paths: readonly CausalTracePath[]): CausalTracePath[] {
  const selected = new Map<string, CausalTracePath>();
  for (const candidate of paths) selected.set(`${candidate.kind}:${candidate.nodes.map((node) => node.id).join(">")}:${candidate.edgeIds.join(">")}`, candidate);
  return [...selected.values()];
}

function dedupeCitations(citations: readonly RetrievalCitation[]): RetrievalCitation[] {
  const selected = new Map<string, RetrievalCitation>();
  for (const citation of citations) selected.set(`${citation.kind}:${citation.id}`, citation);
  return [...selected.values()];
}
