import { summarizeOntologyGraph, type OntologyGraph, type OntologyGraphSummary } from "./model.js";

export interface OntologyGraphStore {
  save(graph: OntologyGraph): Promise<void>;
  latest(tenantId: string): Promise<OntologyGraph | undefined>;
  get(graphId: string, tenantId: string): Promise<OntologyGraph | undefined>;
  list(tenantId: string): Promise<readonly OntologyGraph[]>;
  listSummaries(tenantId: string): Promise<readonly OntologyGraphSummary[]>;
  migrateTenantAliases(tenantId: string, aliases: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

export class MemoryOntologyGraphStore implements OntologyGraphStore {
  private readonly graphs = new Map<string, OntologyGraph>();

  async save(graph: OntologyGraph): Promise<void> {
    if (!this.graphs.has(graph.id)) this.graphs.set(graph.id, graph);
  }

  async latest(tenantId: string): Promise<OntologyGraph | undefined> {
    return (await this.list(tenantId))[0];
  }

  async get(graphId: string, tenantId: string): Promise<OntologyGraph | undefined> {
    const graph = this.graphs.get(graphId);
    return graph?.tenantId === tenantId ? graph : undefined;
  }

  async list(tenantId: string): Promise<readonly OntologyGraph[]> {
    return [...this.graphs.values()]
      .filter((graph) => graph.tenantId === tenantId)
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  }

  async listSummaries(tenantId: string): Promise<readonly OntologyGraphSummary[]> {
    return (await this.list(tenantId)).map(summarizeOntologyGraph);
  }

  async migrateTenantAliases(tenantId: string, aliases: readonly string[]): Promise<void> {
    for (const [id, graph] of this.graphs) {
      if (aliases.includes(graph.tenantId)) this.graphs.set(id, { ...graph, tenantId });
    }
  }

  async close(): Promise<void> {}
}
