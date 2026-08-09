import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { contextPublicSnapshotDigest, parseWikiContentBundle, type ContextArtifactWrite } from "@jina/context-engine";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { CONTEXT_ROLES_SQL } from "./context/roles.js";
import { CONTEXT_SCHEMA_SQL } from "./context/schema.js";
import { ContextDatabase } from "./context/database.js";
import {
  POSTGRES_CONTEXT_ARTIFACT_MAX_BYTES,
  POSTGRES_WIKI_AUDIT_ARTIFACT_MAX_BYTES,
  POSTGRES_WIKI_CONTENT_MAX_BYTES,
  PostgresWikiArtifactStore
} from "./context/postgres-wiki-artifact-store.js";

interface MemoryRow extends QueryResultRow {
  tenant_id: string;
  repository: string;
  object_key: string;
  object_generation: string;
  artifact_class: string;
  content_type: string;
  content_sha256: string;
  content_length: number;
  content_metadata: unknown;
  content_bytes: Buffer;
}

class MemoryArtifactDatabase {
  readonly rows = new Map<string, MemoryRow>();
  generation = 0;

  async transactionAs<T>(_role: string, _scope: unknown, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    return operation({ query: this.query.bind(this) } as unknown as PoolClient);
  }

  queryAs<T extends QueryResultRow>(_role: string, _scope: unknown, text: string, values?: readonly unknown[]) {
    return this.query<T>(text, values);
  }

  corrupt(key: string, content: string): void {
    const row = this.rows.get(key);
    if (!row) throw new Error("missing fake artifact");
    row.content_bytes = Buffer.from(content);
  }

  private async query<T extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<QueryResult<T>> {
    if (text.includes("insert into jina_context.context_wiki_artifacts")) {
      const key = String(values[2]);
      if (this.rows.has(key)) return result<T>([]);
      const row: MemoryRow = {
        tenant_id: String(values[0]),
        repository: String(values[1]),
        object_key: key,
        object_generation: String(++this.generation),
        artifact_class: String(values[3]),
        content_type: String(values[4]),
        content_sha256: String(values[5]),
        content_length: Number(values[6]),
        content_metadata: JSON.parse(String(values[7])),
        content_bytes: Buffer.from(values[8] as Uint8Array)
      };
      this.rows.set(key, row);
      return result<T>([withoutContent(row) as T]);
    }
    const row = this.rows.get(String(values[1]));
    if (!row || row.tenant_id !== values[0]) return result<T>([]);
    if (text.includes("object_generation=$3::bigint") && row.object_generation !== String(values[2])) {
      return result<T>([]);
    }
    if (text.includes("content_bytes=$3::bytea")) {
      return result<T>([
        {
          ...withoutContent(row),
          content_equal: row.content_bytes.equals(Buffer.from(values[2] as Uint8Array))
        } as unknown as T
      ]);
    }
    return result<T>([(text.includes(",content_bytes") ? { ...row } : withoutContent(row)) as T]);
  }
}

const genericWrite: ContextArtifactWrite = {
  tenantId: "tenant-a",
  repository: "acme/widgets",
  buildId: "build-1",
  kind: "evidence-snapshot",
  name: "wiki-source.json",
  contentType: "application/json",
  content: '{"source":1}'
};

test("Postgres artifact schema is append-only, tenant scoped, binary, and separately bounded by the adapter", () => {
  assert.match(CONTEXT_SCHEMA_SQL, /create table if not exists jina_context\.context_wiki_artifacts/);
  assert.match(CONTEXT_SCHEMA_SQL, /content_bytes bytea not null/);
  assert.match(CONTEXT_SCHEMA_SQL, /object_generation bigint generated always as identity/);
  assert.match(CONTEXT_SCHEMA_SQL, /content_length integer not null check \(content_length between 0 and 536870912\)/);
  assert.match(CONTEXT_SCHEMA_SQL, /create trigger context_wiki_artifacts_immutable/);
  assert.match(CONTEXT_ROLES_SQL, /alter table jina_context\.context_wiki_artifacts enable row level security/);
  const queryGrant = /grant select on([\s\S]*?)to jina_context_query;/.exec(CONTEXT_ROLES_SQL)?.[1] ?? "";
  assert.doesNotMatch(queryGrant, /context_wiki_artifacts/);
  assert.equal(POSTGRES_CONTEXT_ARTIFACT_MAX_BYTES, 32 * 1024 * 1024);
  assert.equal(POSTGRES_WIKI_AUDIT_ARTIFACT_MAX_BYTES, 2 * 1024 * 1024);
  assert.equal(POSTGRES_WIKI_CONTENT_MAX_BYTES, 512 * 1024 * 1024);
});

test("generic Context artifacts replay exact bytes and bind key, URI, metadata, and numeric generation", async () => {
  const database = new MemoryArtifactDatabase();
  const store = new PostgresWikiArtifactStore(database as unknown as ContextDatabase);
  const ref = await store.put(genericWrite);
  assert.equal(ref.objectGeneration, "1");
  assert.equal(ref.uri, `postgres://jina_context/context_wiki_artifacts/${ref.key}?generation=1`);
  assert.equal(Buffer.from(await store.get(ref)).toString("utf8"), genericWrite.content);
  const { content: _content, ...lookup } = genericWrite;
  void _content;
  assert.deepEqual(await store.find(lookup), ref);
  assert.deepEqual(await store.put(genericWrite), ref);

  await assert.rejects(store.get({ ...ref, uri: `${ref.uri}-tampered` }), /URI does not match/);
  await assert.rejects(store.get({ ...ref, objectGeneration: "2" }), /URI does not match/);
  await assert.rejects(store.get({ ...ref, contentType: "text/plain" }), /metadata does not match/);
  await assert.rejects(
    store.get({
      ...ref,
      key: ref.key.replace("tenant-a", "tenant-b"),
      uri: ref.uri.replace("tenant-a", "tenant-b")
    }),
    /reference was not found/
  );

  database.corrupt(ref.key, '{"source":2}');
  await assert.rejects(store.put(genericWrite), /key collision/);
  await assert.rejects(
    store.put({
      ...genericWrite,
      name: "oversized.bin",
      content: new Uint8Array(POSTGRES_CONTEXT_ARTIFACT_MAX_BYTES + 1)
    }),
    /exceeds/
  );
});

test("wiki content and audit ports retain their canonical identities and reject key collisions", async () => {
  const database = new MemoryArtifactDatabase();
  const store = new PostgresWikiArtifactStore(database as unknown as ContextDatabase);
  const bodyMarkdown = "# Quickstart\n\nReady.\n";
  const bundle = parseWikiContentBundle({
    version: 1,
    publicSnapshotDigest: contextPublicSnapshotDigest([
      { documentPath: "quickstart.md", title: "quickstart.md", bodyMarkdown }
    ]),
    pages: [
      {
        documentPath: "quickstart.md",
        bodyMarkdown,
        bodySha256: sha256(bodyMarkdown)
      }
    ]
  });
  const contentRef = await store.putIfAbsent({ tenantId: "tenant-a", repository: "Acme/Widgets", bundle });
  assert.deepEqual(await store.putIfAbsent({ tenantId: "tenant-a", repository: "acme/widgets", bundle }), contentRef);
  assert.deepEqual(
    await store.find({
      tenantId: "tenant-a",
      repository: "acme/widgets",
      bundleSha256: contentRef.bundleSha256,
      publicSnapshotDigest: bundle.publicSnapshotDigest
    }),
    contentRef
  );
  assert.deepEqual(await store.get(contentRef), bundle);

  const identity = {
    tenantId: "tenant-a",
    repository: "acme/widgets",
    auditId: "audit-1",
    releaseId: "cr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    auditInputDigest: "b".repeat(64)
  };
  const content = `${JSON.stringify({ version: 1, ...identity, findings: [] })}\n`;
  const auditRef = await store.putIfAbsent({ ...identity, content });
  assert.deepEqual(await store.find(identity), auditRef);
  assert.equal(Buffer.from(await store.get(auditRef)).toString("utf8"), content);
  const otherIdentity = { ...identity, releaseId: "cr_cccccccccccccccccccccccccccccccc" };
  const otherContent = `${JSON.stringify({ version: 1, ...otherIdentity, findings: [] })}\n`;
  await assert.rejects(store.putIfAbsent({ ...otherIdentity, content: otherContent }), /key collision/);
});

function withoutContent(row: MemoryRow): Omit<MemoryRow, "content_bytes"> {
  const { content_bytes: _content, ...metadata } = row;
  void _content;
  return metadata;
}

function result<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { command: "", rowCount: rows.length, oid: 0, fields: [], rows };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
