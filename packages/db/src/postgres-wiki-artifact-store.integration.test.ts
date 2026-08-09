import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { contextPublicSnapshotDigest, parseWikiContentBundle } from "@jina/context-engine";
import { Pool } from "pg";
import { ContextDatabase } from "./context/database.js";
import { PostgresWikiArtifactStore } from "./context/postgres-wiki-artifact-store.js";

// This test recreates jina_context. Never fall back to DATABASE_URL.
const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "Postgres wiki artifacts are tenant-scoped, append-only, idempotent, and byte exact",
  { skip: !databaseUrl },
  async () => {
    const bootstrap = new Pool({ connectionString: databaseUrl, max: 1 });
    await bootstrap.query("drop schema if exists jina_context cascade");
    await bootstrap.end();
    const database = new ContextDatabase({ connectionString: databaseUrl, manageRoles: true, max: 2 });
    try {
      await database.initialize();
      await database.pool.query(
        `insert into jina_context.repositories
           (tenant_id,repository,default_ref,created_at,updated_at)
         values
           ('tenant-a','acme/widgets','main',now(),now()),
           ('tenant-b','acme/widgets','main',now(),now())`
      );
      const store = new PostgresWikiArtifactStore(database);
      const write = {
        tenantId: "tenant-a",
        repository: "acme/widgets",
        buildId: "build-1",
        kind: "evidence-snapshot" as const,
        name: "wiki-source.json",
        contentType: "application/json",
        content: '{"source":1}'
      };
      const [ref, concurrentRef] = await Promise.all([store.put(write), store.put(write)]);
      assert.deepEqual(concurrentRef, ref);
      assert.equal(concurrentRef.objectGeneration, ref.objectGeneration);
      assert.match(ref.objectGeneration ?? "", /^[1-9][0-9]*$/);
      assert.equal(
        ref.uri,
        `postgres://jina_context/context_wiki_artifacts/${ref.key}?generation=${ref.objectGeneration}`
      );
      assert.deepEqual(await store.put(write), ref);
      assert.equal(Buffer.from(await store.get(ref)).toString("utf8"), write.content);
      const { content: _content, ...lookup } = write;
      void _content;
      assert.deepEqual(await store.find(lookup), ref);
      await assert.rejects(store.put({ ...write, content: '{"source":2}' }), /key collision/);
      await assert.rejects(store.get({ ...ref, sha256: "f".repeat(64) }), /metadata does not match/);

      const bodyMarkdown = "# Architecture\n\nThe worker publishes asynchronously.\n";
      const bundle = parseWikiContentBundle({
        version: 1,
        publicSnapshotDigest: contextPublicSnapshotDigest([
          { documentPath: "architecture.md", title: "architecture.md", bodyMarkdown }
        ]),
        pages: [
          {
            documentPath: "architecture.md",
            bodyMarkdown,
            bodySha256: createHash("sha256").update(bodyMarkdown).digest("hex")
          }
        ]
      });
      const contentRef = await store.putIfAbsent({ tenantId: "tenant-a", repository: "acme/widgets", bundle });
      assert.deepEqual(await store.get(contentRef), bundle);
      await assert.rejects(store.get({ ...contentRef, repository: "acme/other" }), /key does not match/);
      assert.deepEqual(
        await store.find({
          tenantId: "tenant-a",
          repository: "acme/widgets",
          bundleSha256: contentRef.bundleSha256,
          publicSnapshotDigest: contentRef.publicSnapshotDigest
        }),
        contentRef
      );

      const auditIdentity = {
        tenantId: "tenant-a",
        repository: "acme/widgets",
        auditId: "audit-1",
        releaseId: "cr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        auditInputDigest: "b".repeat(64)
      };
      const auditContent = `${JSON.stringify({ version: 1, ...auditIdentity, findings: [] })}\n`;
      const auditRef = await store.putIfAbsent({ ...auditIdentity, content: auditContent });
      assert.equal(Buffer.from(await store.get(auditRef)).toString("utf8"), auditContent);
      await assert.rejects(store.get({ ...auditRef, repository: "acme/other" }), /key does not match/);
      assert.deepEqual(await store.find(auditIdentity), auditRef);

      const invisible = await database.transactionAs(
        "jina_context_admin",
        { tenantIds: ["tenant-b"] },
        (client) =>
          client.query(
            `select object_key from jina_context.context_wiki_artifacts
             where tenant_id='tenant-a' and object_key=$1`,
            [ref.key]
          ),
        "wiki_artifact_rls_test"
      );
      assert.equal(invisible.rowCount, 0);

      const queryClient = await database.pool.connect();
      try {
        await queryClient.query("begin");
        await queryClient.query("set local role jina_context_query");
        await queryClient.query("select set_config('jina.tenant_id','tenant-a',true)");
        await assert.rejects(
          queryClient.query(
            `select content_bytes from jina_context.context_wiki_artifacts
             where tenant_id='tenant-a' and object_key=$1`,
            [ref.key]
          ),
          /permission denied/
        );
      } finally {
        await queryClient.query("rollback").catch(() => undefined);
        queryClient.release();
      }

      await assert.rejects(
        database.pool.query(
          `update jina_context.context_wiki_artifacts set content_type='text/plain'
           where tenant_id='tenant-a' and object_key=$1`,
          [ref.key]
        ),
        /append-only/
      );
      await assert.rejects(
        database.pool.query(
          `delete from jina_context.context_wiki_artifacts
           where tenant_id='tenant-a' and object_key=$1`,
          [ref.key]
        ),
        /append-only/
      );
      await assert.rejects(
        store.put({ ...write, tenantId: "tenant-missing", name: "missing-repository.json" }),
        /foreign key/
      );
    } finally {
      await database.pool.query("drop schema if exists jina_context cascade").catch(() => undefined);
      await database.close();
    }
  }
);
