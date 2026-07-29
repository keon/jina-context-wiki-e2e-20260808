import type { DerivationProgressPage, DerivationProgressSnapshot } from "@jina/context-engine";
import { ContextDatabase, contextTenantScope } from "./database.js";

interface ProgressRow {
  readonly document_path: string;
  readonly title: string;
  readonly bytes: number;
  readonly first_seen_at: Date;
  readonly updated_at: Date;
}

/**
 * Pages a derivation has finished, while it is still running.
 *
 * A derivation may run for hours inside a sandbox that dies with its worker, and
 * its pages were only ever collected once the run ended. A build stopped part
 * way threw away everything it had already written, and nobody could see it
 * happening. Writing each finished page here as it appears makes the work
 * durable and the run observable, which are the same problem.
 *
 * Rows are the run's working state, not the catalog: they are replaced by
 * knowledge revisions when the stage commits, and cleared at that point.
 */
export class PostgresDerivationProgressRepository {
  constructor(private readonly database: ContextDatabase) {}

  /**
   * Records the pages present at this moment.
   *
   * Upsert rather than insert, because the agent rewrites a page it is still
   * working on and the newest version is the one worth keeping. `first_seen_at`
   * survives the update so the order pages were finished in stays readable.
   */
  async record(input: {
    readonly tenantId: string;
    readonly buildId: string;
    readonly stageId: string;
    readonly checkpointId: string;
    readonly pages: readonly DerivationProgressPage[];
    readonly at: string;
  }): Promise<void> {
    if (input.pages.length === 0) return;
    await this.database.transactionAs("jina_context_derive", contextTenantScope(input.tenantId), async (client) => {
      for (const page of input.pages) {
        await client.query(
          `insert into jina_context.derivation_progress
             (stage_id,tenant_id,build_id,checkpoint_id,document_path,title,body_markdown,bytes,first_seen_at,updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
           on conflict (stage_id,document_path) do update
             set title=excluded.title,
                 body_markdown=excluded.body_markdown,
                 bytes=excluded.bytes,
                 updated_at=excluded.updated_at`,
          [
            input.stageId,
            input.tenantId,
            input.buildId,
            input.checkpointId,
            page.documentPath,
            page.title,
            page.bodyMarkdown,
            Buffer.byteLength(page.bodyMarkdown, "utf8"),
            input.at
          ]
        );
      }
    });
  }

  /** What a build has written so far, for somebody watching it happen. */
  async snapshot(tenantId: string, buildId: string): Promise<DerivationProgressSnapshot> {
    return this.database.transactionAs("jina_context_query", contextTenantScope(tenantId), async (client) => {
      // The body is deliberately not selected: watching a build wants the shape
      // of the wiki appearing, and the bodies are large enough to make polling
      // expensive for something nobody reads until it is published.
      const { rows } = await client.query<ProgressRow>(
        `select document_path,title,bytes,first_seen_at,updated_at
           from jina_context.derivation_progress
          where tenant_id=$1 and build_id=$2
          order by first_seen_at asc,document_path asc`,
        [tenantId, buildId]
      );
      const latest = rows.reduce<string | undefined>((newest, row) => {
        const at = row.updated_at.toISOString();
        return newest === undefined || at > newest ? at : newest;
      }, undefined);
      return {
        buildId,
        pages: rows.map((row) => ({
          documentPath: row.document_path,
          title: row.title,
          bytes: row.bytes,
          firstSeenAt: row.first_seen_at.toISOString(),
          updatedAt: row.updated_at.toISOString()
        })),
        ...(latest === undefined ? {} : { updatedAt: latest })
      };
    });
  }

  /**
   * One page's text, while the build that wrote it is still running.
   *
   * Fetched per page rather than included in the snapshot: the listing is
   * polled every few seconds and the bodies would make that expensive, but a
   * page somebody has actually opened is worth reading before it is published.
   */
  async pageBody(
    tenantId: string,
    buildId: string,
    documentPath: string
  ): Promise<{ documentPath: string; title: string; bodyMarkdown: string } | undefined> {
    return this.database.transactionAs("jina_context_query", contextTenantScope(tenantId), async (client) => {
      const { rows } = await client.query<{ document_path: string; title: string; body_markdown: string }>(
        `select document_path,title,body_markdown
           from jina_context.derivation_progress
          where tenant_id=$1 and build_id=$2 and document_path=$3
          limit 1`,
        [tenantId, buildId, documentPath]
      );
      const row = rows[0];
      return row ? { documentPath: row.document_path, title: row.title, bodyMarkdown: row.body_markdown } : undefined;
    });
  }

  /**
   * The pages a stopped run had already written, so the next one resumes from
   * them instead of starting the wiki again.
   */
  async pagesForStage(tenantId: string, stageId: string): Promise<DerivationProgressPage[]> {
    return this.database.transactionAs("jina_context_derive", contextTenantScope(tenantId), async (client) => {
      const { rows } = await client.query<{ document_path: string; title: string; body_markdown: string }>(
        `select document_path,title,body_markdown
           from jina_context.derivation_progress
          where tenant_id=$1 and stage_id=$2
          order by document_path asc`,
        [tenantId, stageId]
      );
      return rows.map((row) => ({
        documentPath: row.document_path,
        title: row.title,
        bodyMarkdown: row.body_markdown
      }));
    });
  }

  /** Cleared once the pages exist as revisions, so this never shadows the catalog. */
  async clear(tenantId: string, stageId: string): Promise<void> {
    await this.database.transactionAs("jina_context_derive", contextTenantScope(tenantId), async (client) => {
      await client.query(`delete from jina_context.derivation_progress where tenant_id=$1 and stage_id=$2`, [
        tenantId,
        stageId
      ]);
    });
  }
}
