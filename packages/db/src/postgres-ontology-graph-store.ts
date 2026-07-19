import type { OntologyEdge, OntologyGraph, OntologyGraphStore, OntologyNode } from "@jina/ontology";
import { Pool, type PoolConfig } from "pg";

interface GraphRow {
  id: string;
  tenant_id: string;
  repository: string;
  ref: string;
  commit_sha: string;
  generated_at: Date;
  executor: "daytona" | "fixture";
  model: string;
  sandbox_id: string | null;
  summary: string;
}

interface NodeRow {
  graph_id: string;
  node_id: string;
  kind: OntologyNode["kind"];
  label: string;
  description: string;
  path: string | null;
  evidence: readonly string[];
}

interface EdgeRow {
  graph_id: string;
  edge_id: string;
  source_node_id: string;
  target_node_id: string;
  predicate: string;
  plane: OntologyEdge["plane"];
  evidence: readonly string[];
}

export class PostgresOntologyGraphStore implements OntologyGraphStore {
  private readonly pool: Pool;
  private initialized?: Promise<void>;

  constructor(config: PoolConfig) {
    this.pool = new Pool({ ...config, application_name: "jina-ontology", max: config.max ?? 5 });
  }

  async save(graph: OntologyGraph): Promise<void> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into jina_ontology.graphs
          (id, tenant_id, repository, ref, commit_sha, generated_at, executor, model, sandbox_id, summary)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (id) do update set generated_at=excluded.generated_at, executor=excluded.executor,
           model=excluded.model, sandbox_id=excluded.sandbox_id, summary=excluded.summary`,
        [graph.id, graph.tenantId, graph.repository, graph.ref, graph.commitSha, graph.generatedAt,
          graph.generator.executor, graph.generator.model, graph.generator.sandboxId ?? null, graph.summary]
      );
      await client.query("delete from jina_ontology.edges where graph_id = $1", [graph.id]);
      await client.query("delete from jina_ontology.nodes where graph_id = $1", [graph.id]);
      for (const node of graph.nodes) {
        await client.query(
          `insert into jina_ontology.nodes
            (graph_id,node_id,kind,label,description,path,evidence) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [graph.id, node.id, node.kind, node.label, node.description, node.path ?? null, JSON.stringify(node.evidence)]
        );
      }
      for (const edge of graph.edges) {
        await client.query(
          `insert into jina_ontology.edges
            (graph_id,edge_id,source_node_id,target_node_id,predicate,plane,evidence)
           values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [graph.id, edge.id, edge.source, edge.target, edge.predicate, edge.plane, JSON.stringify(edge.evidence)]
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async latest(tenantId?: string): Promise<OntologyGraph | undefined> {
    const graphs = await this.loadGraphs(tenantId, 1);
    return graphs[0];
  }

  async get(graphId: string): Promise<OntologyGraph | undefined> {
    await this.initialize();
    const result = await this.pool.query<GraphRow>("select * from jina_ontology.graphs where id = $1", [graphId]);
    return result.rows[0] ? this.hydrate(result.rows[0]) : undefined;
  }

  async list(tenantId?: string): Promise<readonly OntologyGraph[]> {
    return this.loadGraphs(tenantId, 50);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async loadGraphs(tenantId: string | undefined, limit: number): Promise<readonly OntologyGraph[]> {
    await this.initialize();
    const result = tenantId
      ? await this.pool.query<GraphRow>(
          "select * from jina_ontology.graphs where tenant_id = $1 order by generated_at desc limit $2",
          [tenantId, limit]
        )
      : await this.pool.query<GraphRow>("select * from jina_ontology.graphs order by generated_at desc limit $1", [limit]);
    return Promise.all(result.rows.map((row) => this.hydrate(row)));
  }

  private async hydrate(row: GraphRow): Promise<OntologyGraph> {
    const [nodes, edges] = await Promise.all([
      this.pool.query<NodeRow>("select * from jina_ontology.nodes where graph_id = $1 order by node_id", [row.id]),
      this.pool.query<EdgeRow>("select * from jina_ontology.edges where graph_id = $1 order by edge_id", [row.id])
    ]);
    return {
      id: row.id,
      tenantId: row.tenant_id,
      repository: row.repository,
      ref: row.ref,
      commitSha: row.commit_sha,
      generatedAt: row.generated_at.toISOString(),
      generator: {
        executor: row.executor,
        model: row.model,
        ...(row.sandbox_id ? { sandboxId: row.sandbox_id } : {})
      },
      summary: row.summary,
      nodes: nodes.rows.map((node) => ({
        id: node.node_id,
        kind: node.kind,
        label: node.label,
        description: node.description,
        ...(node.path ? { path: node.path } : {}),
        evidence: node.evidence
      })),
      edges: edges.rows.map((edge) => ({
        id: edge.edge_id,
        source: edge.source_node_id,
        target: edge.target_node_id,
        predicate: edge.predicate,
        plane: edge.plane,
        evidence: edge.evidence
      }))
    };
  }

  private initialize(): Promise<void> {
    this.initialized ??= this.createSchema();
    return this.initialized;
  }

  private async createSchema(): Promise<void> {
    await this.pool.query(`
      create schema if not exists jina_ontology;
      create table if not exists jina_ontology.graphs (
        id text primary key,
        tenant_id text not null,
        repository text not null,
        ref text not null,
        commit_sha text not null,
        generated_at timestamptz not null,
        executor text not null check (executor in ('daytona','fixture')),
        model text not null,
        sandbox_id text,
        summary text not null
      );
      create index if not exists ontology_graphs_tenant_generated
        on jina_ontology.graphs (tenant_id, generated_at desc);
      create table if not exists jina_ontology.nodes (
        graph_id text not null references jina_ontology.graphs(id) on delete cascade,
        node_id text not null,
        kind text not null,
        label text not null,
        description text not null,
        path text,
        evidence jsonb not null,
        primary key (graph_id, node_id)
      );
      create table if not exists jina_ontology.edges (
        graph_id text not null references jina_ontology.graphs(id) on delete cascade,
        edge_id text not null,
        source_node_id text not null,
        target_node_id text not null,
        predicate text not null,
        plane text not null check (plane in ('code','knowledge')),
        evidence jsonb not null,
        primary key (graph_id, edge_id),
        foreign key (graph_id, source_node_id) references jina_ontology.nodes(graph_id, node_id),
        foreign key (graph_id, target_node_id) references jina_ontology.nodes(graph_id, node_id)
      );
    `);
  }
}
