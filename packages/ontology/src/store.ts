import type { OntologyGraph } from "./model.js";

export interface OntologyGraphStore {
  save(graph: OntologyGraph): Promise<void>;
  latest(tenantId?: string): Promise<OntologyGraph | undefined>;
  get(graphId: string): Promise<OntologyGraph | undefined>;
  list(tenantId?: string): Promise<readonly OntologyGraph[]>;
  close(): Promise<void>;
}

export class MemoryOntologyGraphStore implements OntologyGraphStore {
  private readonly graphs = new Map<string, OntologyGraph>();

  async save(graph: OntologyGraph): Promise<void> {
    this.graphs.set(graph.id, graph);
  }

  async latest(tenantId?: string): Promise<OntologyGraph | undefined> {
    return (await this.list(tenantId))[0];
  }

  async get(graphId: string): Promise<OntologyGraph | undefined> {
    return this.graphs.get(graphId);
  }

  async list(tenantId?: string): Promise<readonly OntologyGraph[]> {
    return [...this.graphs.values()]
      .filter((graph) => !tenantId || graph.tenantId === tenantId)
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  }

  async close(): Promise<void> {}
}
