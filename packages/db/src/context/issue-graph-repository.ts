import {
  normalizeRepository,
  type BoardIssueGraphPublicationCommit,
  type BoardIssueGraphPublicationTransactionPort,
  type ContextArtifactRef,
  type IssueGraphRelease,
  type IssueGraphStore
} from "@jina/context-engine";
import type { PoolClient } from "pg";
import { ContextDatabase, dateString } from "./database.js";

interface IssueGraphReleaseRow {
  release_id: string;
  tenant_id: string;
  repository: string;
  ref_name: string;
  ref_sequence: string;
  commit_sha: string;
  build_id: string;
  content_digest: string;
  artifact: ContextArtifactRef;
  issue_count: number;
  causality_count: number;
  history_complete: boolean;
  published_at: Date;
}

export class PostgresIssueGraphRepository implements IssueGraphStore, BoardIssueGraphPublicationTransactionPort {
  constructor(private readonly database: ContextDatabase) {}

  async publishIssueGraphRelease(release: IssueGraphRelease): Promise<IssueGraphRelease> {
    const repository = normalizeRepository(release.repository);
    return this.database.transactionAs(
      "jina_context_issue_publish",
      { tenantIds: [release.tenantId] },
      (client) => persistIssueGraphRelease(client, { ...release, repository }),
      "issue-graph.publish"
    );
  }

  async publishIssueGraphAtomically(input: BoardIssueGraphPublicationCommit): Promise<IssueGraphRelease> {
    const release = { ...input.release, repository: normalizeRepository(input.release.repository) };
    await this.database.initialize();
    const client = await this.database.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('jina_runtime.api_state'))");
      const runtime = await client.query<{ snapshot: unknown }>(
        "select snapshot from jina_runtime.api_state where id=1 for update"
      );
      const snapshot = runtime.rows[0]?.snapshot;
      if (!snapshot) throw new Error("durable Board state is unavailable for issue graph publication");
      const nowMillis = await databaseClockMillis(client);
      assertLiveIssueGraphLease(snapshot, { ...input, release }, nowMillis);
      await client.query("set local role jina_context_issue_publish");
      await client.query("select set_config('jina.tenant_id',$1,true)", [release.tenantId]);
      const stored = await persistIssueGraphRelease(client, release);
      assertLiveIssueGraphLease(snapshot, { ...input, release }, await databaseClockMillis(client));
      await client.query("commit");
      return stored;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async currentIssueGraphRelease(
    tenantId: string,
    repository: string,
    ref: string
  ): Promise<IssueGraphRelease | undefined> {
    const result = await this.database.queryAs<IssueGraphReleaseRow>(
      "jina_context_query",
      { tenantIds: [tenantId] },
      `select release.*
       from jina_context.current_issue_graph_releases current_release
       join jina_context.issue_graph_releases release on release.release_id=current_release.release_id
       where current_release.tenant_id=$1 and current_release.repository=$2 and current_release.ref_name=$3`,
      [tenantId, normalizeRepository(repository), ref],
      "issue-graph.current"
    );
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async currentAuthorizedIssueGraphRelease(
    tenantId: string,
    repository: string,
    ref: string,
    principalId: string
  ): Promise<IssueGraphRelease | undefined> {
    const result = await this.database.queryAs<IssueGraphReleaseRow>(
      "jina_context_query",
      { tenantIds: [tenantId] },
      `select release.*
       from jina_context.current_issue_graph_releases current_release
       join jina_context.issue_graph_releases release on release.release_id=current_release.release_id
       where current_release.tenant_id=$1 and current_release.repository=$2 and current_release.ref_name=$3
         and exists (
           select 1 from jina_context.current_repository_acl acl
           where acl.tenant_id=current_release.tenant_id and acl.repository=current_release.repository
             and acl.principal_id=$4 and acl.permission in ('read','write','admin')
         )`,
      [tenantId, normalizeRepository(repository), ref, principalId],
      "issue-graph.current-authorized"
    );
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async listIssueGraphReleases(tenantId: string, repository: string, ref: string): Promise<IssueGraphRelease[]> {
    const result = await this.database.queryAs<IssueGraphReleaseRow>(
      "jina_context_query",
      { tenantIds: [tenantId] },
      `select * from jina_context.issue_graph_releases
       where tenant_id=$1 and repository=$2 and ref_name=$3
       order by ref_sequence desc,release_id desc`,
      [tenantId, normalizeRepository(repository), ref],
      "issue-graph.list-releases"
    );
    return result.rows.map(fromRow);
  }
}

async function persistIssueGraphRelease(client: PoolClient, release: IssueGraphRelease): Promise<IssueGraphRelease> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    `context-issue-graph:${release.tenantId}:${release.repository}:${release.ref}`
  ]);
  await client.query(
    `insert into jina_context.repositories
      (tenant_id,repository,provider,provider_repository_id,default_ref,metadata,created_at,updated_at)
     values ($1,$2,'unknown',$2,$3,'{}'::jsonb,$4,$4)
     on conflict (tenant_id,repository) do nothing`,
    [release.tenantId, release.repository, release.ref, release.publishedAt]
  );
  const existing = await client.query<IssueGraphReleaseRow>(
    "select * from jina_context.issue_graph_releases where release_id=$1",
    [release.id]
  );
  if (existing.rows[0]) {
    const stored = fromRow(existing.rows[0]);
    if (stored.contentDigest !== release.contentDigest || stored.artifact.sha256 !== release.artifact.sha256) {
      throw new Error("Issue graph release identity collision");
    }
    return stored;
  }
  const current = await client.query<{ ref_sequence: string; release_id: string }>(
    `select ref_sequence::text,release_id
     from jina_context.current_issue_graph_releases
     where tenant_id=$1 and repository=$2 and ref_name=$3
     for update`,
    [release.tenantId, release.repository, release.ref]
  );
  const currentSequence = Number(current.rows[0]?.ref_sequence ?? 0);
  if (currentSequence >= release.refSequence) throw new Error("Issue graph release ref sequence is stale");
  await client.query(
    `insert into jina_context.issue_graph_releases
      (release_id,tenant_id,repository,ref_name,ref_sequence,commit_sha,build_id,
       content_digest,artifact,issue_count,causality_count,history_complete,published_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)`,
    [
      release.id,
      release.tenantId,
      release.repository,
      release.ref,
      release.refSequence,
      release.commitSha,
      release.buildId,
      release.contentDigest,
      JSON.stringify(release.artifact),
      release.issueCount,
      release.causalityCount,
      release.historyComplete,
      release.publishedAt
    ]
  );
  await client.query(
    `insert into jina_context.current_issue_graph_releases
      (tenant_id,repository,ref_name,ref_sequence,release_id,commit_sha,advanced_at)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (tenant_id,repository,ref_name) do update
       set ref_sequence=excluded.ref_sequence,release_id=excluded.release_id,
           commit_sha=excluded.commit_sha,advanced_at=excluded.advanced_at
     where jina_context.current_issue_graph_releases.ref_sequence < excluded.ref_sequence`,
    [
      release.tenantId,
      release.repository,
      release.ref,
      release.refSequence,
      release.id,
      release.commitSha,
      release.publishedAt
    ]
  );
  return release;
}

function assertLiveIssueGraphLease(
  snapshot: unknown,
  input: BoardIssueGraphPublicationCommit,
  databaseNowMillis: number
): void {
  const root = objectValue(snapshot);
  const intake = objectValue(root?.intakeState);
  const board = objectValue(intake?.board);
  const tasks = Array.isArray(board?.tasks) ? board.tasks.map(objectValue).filter(isObject) : [];
  const outbox = Array.isArray(board?.outbox) ? board.outbox.map(objectValue).filter(isObject) : [];
  const task = tasks.find((candidate) => candidate.id === input.lease.taskId);
  const message = outbox.find((candidate) => candidate.id === input.lease.messageId);
  const metadata = objectValue(task?.metadata);
  const payload = objectValue(message?.payload);
  const release = input.release;
  if (
    !task ||
    !message ||
    task.type !== "publish-context-issues" ||
    task.kind !== "dispatchable" ||
    task.status !== "in_progress" ||
    task.attempt !== input.lease.attempt ||
    metadata?.tenantId !== release.tenantId ||
    metadata.repository !== release.repository ||
    metadata.ref !== release.ref ||
    metadata.refSequence !== release.refSequence ||
    metadata.commitSha !== release.commitSha ||
    metadata.contextBuildId !== release.buildId ||
    message.taskId !== input.lease.taskId ||
    message.topic !== "run-context-issue-publication" ||
    message.status !== "leased" ||
    payload?.attempt !== input.lease.attempt ||
    message.leaseId !== input.lease.leaseId ||
    message.writeFenceToken !== input.lease.writeFenceToken ||
    typeof message.leaseExpiresAt !== "string" ||
    new Date(message.leaseExpiresAt).valueOf() <= databaseNowMillis
  ) {
    throw new Error("issue graph publication task no longer owns its durable Board lease");
  }
  const build = tasks.find((candidate) => candidate.id === release.buildId);
  const buildMetadata = objectValue(build?.metadata);
  if (
    !build ||
    build.type !== "build-context-issues" ||
    buildMetadata?.tenantId !== release.tenantId ||
    buildMetadata.repository !== release.repository ||
    buildMetadata.ref !== release.ref ||
    buildMetadata.refSequence !== release.refSequence ||
    buildMetadata.commitSha !== release.commitSha
  ) {
    throw new Error("issue graph publication build no longer matches its durable Board scope");
  }
  const latestAdmitted = Math.max(
    0,
    ...tasks
      .filter((candidate) => {
        const candidateMetadata = objectValue(candidate.metadata);
        return (
          candidate.type === "build-context-issues" &&
          candidateMetadata?.tenantId === release.tenantId &&
          candidateMetadata.repository === release.repository &&
          candidateMetadata.ref === release.ref &&
          Number.isSafeInteger(candidateMetadata.refSequence)
        );
      })
      .map((candidate) => Number(objectValue(candidate.metadata)!.refSequence))
  );
  if (latestAdmitted > release.refSequence) throw new Error("Issue graph release ref sequence is stale");
}

async function databaseClockMillis(client: PoolClient): Promise<number> {
  const result = await client.query<{ now_ms: string }>(
    "select (extract(epoch from clock_timestamp()) * 1000)::text as now_ms"
  );
  const value = Number(result.rows[0]?.now_ms);
  if (!Number.isFinite(value)) throw new Error("database clock is unavailable for issue graph publication");
  return value;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fromRow(row: IssueGraphReleaseRow): IssueGraphRelease {
  return {
    id: row.release_id,
    tenantId: row.tenant_id,
    repository: row.repository,
    ref: row.ref_name,
    refSequence: Number(row.ref_sequence),
    commitSha: row.commit_sha,
    buildId: row.build_id,
    contentDigest: row.content_digest,
    artifact: row.artifact,
    issueCount: row.issue_count,
    causalityCount: row.causality_count,
    historyComplete: row.history_complete,
    publishedAt: dateString(row.published_at)
  };
}
