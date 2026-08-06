import assert from "node:assert/strict";
import { test } from "node:test";

import pg from "pg";

import {
  getReviewFindingRecords,
  getReviewRunRecord,
  getReviewRunRecords,
  knownProjects,
} from "./store.js";

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "tenant review queries never return another tenant's runs, findings, or projects",
  { skip: connectionString ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(connectionString);
    process.env.DATABASE_URL = connectionString;
    const client = new pg.Client({ connectionString });
    await client.connect();

    const seed = Date.now() * 1_000 + Math.floor(Math.random() * 500);
    const tenantIds: string[] = [];
    try {
      for (const suffix of ["a", "b"]) {
        const tenant = await client.query<{ id: string }>(
          `insert into tenants (github_account_id, github_account_login, github_account_type)
           values ($1, $2, 'Organization')
           returning id`,
          [seed + tenantIds.length, `tenant-review-${seed}-${suffix}`],
        );
        tenantIds.push(tenant.rows[0].id);
      }
      const repositoryA = await client.query<{ id: string }>(
        `insert into repositories (tenant_id, github_repo_id, owner, name, default_branch)
         values ($1, $2, 'tenant-a', $3, 'main')
         returning id`,
        [tenantIds[0], seed + 10, `repo-${seed}`],
      );
      const repositoryB = await client.query<{ id: string }>(
        `insert into repositories (tenant_id, github_repo_id, owner, name, default_branch)
         values ($1, $2, 'tenant-b', $3, 'main')
         returning id`,
        [tenantIds[1], seed + 11, `repo-${seed}`],
      );
      const runA = await client.query<{ id: string }>(
        `insert into review_runs
           (tenant_id, repository_id, trigger, status, idempotency_key, head_sha)
         values ($1, $2, 'pull_request', 'completed', $3, repeat('a', 40))
         returning id`,
        [tenantIds[0], repositoryA.rows[0].id, `tenant-review-a-${seed}`],
      );
      const runB = await client.query<{ id: string }>(
        `insert into review_runs
           (tenant_id, repository_id, trigger, status, idempotency_key, head_sha)
         values ($1, $2, 'pull_request', 'completed', $3, repeat('b', 40))
         returning id`,
        [tenantIds[1], repositoryB.rows[0].id, `tenant-review-b-${seed}`],
      );
      await client.query(
        `insert into review_findings
           (tenant_id, review_run_id, fingerprint, severity, category, body)
         values
           ($1, $2, 'finding-a', 'medium', 'correctness', 'tenant A finding'),
           ($3, $4, 'finding-b', 'high', 'security', 'tenant B finding')`,
        [tenantIds[0], runA.rows[0].id, tenantIds[1], runB.rows[0].id],
      );

      const pageA = await getReviewRunRecords({ tenantId: tenantIds[0], limit: 100 });
      assert.deepEqual(pageA.records.map((run) => run.review_run_id), [runA.rows[0].id]);
      assert.equal(
        await getReviewRunRecord({ reviewRunId: runB.rows[0].id, tenantId: tenantIds[0] }),
        undefined,
      );
      assert.deepEqual(
        (await getReviewFindingRecords({ tenantId: tenantIds[0] })).map((finding) => finding.body),
        ["tenant A finding"],
      );
      assert.deepEqual(
        (await knownProjects(tenantIds[0])).map((project) => project.full_name),
        [`tenant-a/repo-${seed}`],
      );
    } finally {
      if (tenantIds.length > 0) {
        await client.query("delete from tenants where id = any($1::uuid[])", [tenantIds]).catch(() => {});
      }
      await client.end();
    }
  },
);
