import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextDatabase } from "./context/database.js";

// This test recreates jina_context. Never fall back to DATABASE_URL.
const databaseUrl = process.env.TEST_DATABASE_URL;
const TENANT = "tenant-context-release";
const REPOSITORY = "acme/context";
const COMMIT = "a".repeat(40);

test(
  "the lean Context schema persists releases and derives current state without pointer tables",
  { skip: !databaseUrl },
  async () => {
    const database = new ContextDatabase({ connectionString: databaseUrl, manageSchema: true, max: 2 });
    try {
      await database.pool.query("drop schema if exists jina_context cascade");
      await database.initialize();

      const tables = await database.pool.query<{ table_name: string }>(
        `select table_name
       from information_schema.tables
       where table_schema='jina_context' and table_type='BASE TABLE'
       order by table_name`
      );
      assert.deepEqual(
        tables.rows.map((row) => row.table_name),
        [
          "context_phase_checkpoints",
          "context_quota_ledgers",
          "context_releases",
          "issue_graph_releases",
          "repositories",
          "repository_access"
        ]
      );

      await database.pool.query(
        `insert into jina_context.repositories
         (tenant_id,repository,default_ref,created_at,updated_at)
       values ($1,$2,'main',now(),now())`,
        [TENANT, REPOSITORY]
      );
      await database.pool.query(
        `insert into jina_context.repository_access
         (tenant_id,repository,principal_id,permission,acl_fingerprint,updated_at)
       values ($1,$2,'user:reader','read',$3,now())`,
        [TENANT, REPOSITORY, "b".repeat(64)]
      );
      await database.pool.query(
        `insert into jina_context.context_releases
         (release_id,tenant_id,repository,ref_name,ref_sequence,commit_sha,build_id,checkpoint_id,
          idempotency_key,publication_input_digest,public_snapshot_digest,certification_artifact,
          publication_plan_artifact,release_artifact,catalog,page_count,prepared_at)
       values ('cr_11111111111111111111111111111111',$1,$2,'main',1,$3,'build-1','checkpoint-1',
               'publication-1',$4,$5,'{}','{}','{}',$6,1,now())`,
        [
          TENANT,
          REPOSITORY,
          COMMIT,
          "c".repeat(64),
          "d".repeat(64),
          JSON.stringify({ version: 1, projection: {}, revisions: [], citations: [] })
        ]
      );

      assert.equal(await currentReleaseId(database), undefined);
      await assert.rejects(
        database.pool.query(
          `update jina_context.context_releases
           set ref_sequence=2,catalog=$2,pageindex_idempotency_key='pageindex-invalid',
               pageindex_attachment_input_digest=$3,pageindex_artifact='{}',
               pageindex_metadata='{}',pageindex_attached_at=now()
           where release_id=$1`,
          [
            "cr_11111111111111111111111111111111",
            JSON.stringify({ version: 1, projection: { attached: true }, revisions: [], citations: [] }),
            "e".repeat(64)
          ]
        ),
        /immutable/
      );
      await database.pool.query(
        `update jina_context.context_releases
       set catalog=$2,pageindex_idempotency_key='pageindex-1',pageindex_attachment_input_digest=$3,
           pageindex_artifact='{}',pageindex_metadata='{}',pageindex_attached_at=now()
       where release_id=$1`,
        [
          "cr_11111111111111111111111111111111",
          JSON.stringify({ version: 1, projection: { attached: true }, revisions: [], citations: [] }),
          "e".repeat(64)
        ]
      );
      assert.equal(await currentReleaseId(database), "cr_11111111111111111111111111111111");

      await assert.rejects(
        database.pool.query(
          "update jina_context.context_releases set catalog='{}' where release_id='cr_11111111111111111111111111111111'"
        ),
        /immutable/
      );
      assert.equal(await currentReleaseId(database), "cr_11111111111111111111111111111111");

      await database.pool.query(
        `insert into jina_context.issue_graph_releases
         (release_id,tenant_id,repository,ref_name,ref_sequence,commit_sha,build_id,content_digest,
          artifact,issue_count,causality_count,history_complete,published_at)
       values ('cir_22222222222222222222222222222222',$1,$2,'main',1,$3,'build-1',$4,'{}',1,0,true,now())`,
        [TENANT, REPOSITORY, COMMIT, "f".repeat(64)]
      );
      await assert.rejects(
        database.pool.query(
          "update jina_context.issue_graph_releases set issue_count=2 where release_id='cir_22222222222222222222222222222222'"
        ),
        /append-only/
      );
    } finally {
      await database.pool.query("drop schema if exists jina_context cascade").catch(() => undefined);
      await database.close();
    }
  }
);

async function currentReleaseId(database: ContextDatabase): Promise<string | undefined> {
  const result = await database.pool.query<{ release_id: string }>(
    `select release_id
     from jina_context.context_releases
     where tenant_id=$1 and repository=$2 and ref_name='main'
       and pageindex_attached_at is not null
     order by ref_sequence desc,release_id desc
     limit 1`,
    [TENANT, REPOSITORY]
  );
  return result.rows[0]?.release_id;
}
