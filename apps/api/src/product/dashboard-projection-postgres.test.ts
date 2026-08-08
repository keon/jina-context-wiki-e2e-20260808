import assert from "node:assert/strict";
import { test } from "node:test";

import pg from "pg";

import { DASHBOARD_LIST_EVENT_LIMIT, DASHBOARD_LIST_EVENTS_SQL } from "./store.js";

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "database projection invariants keep current review list rows bounded",
  { skip: connectionString ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(connectionString);
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      await client.query("begin");
      const githubAccountId = Date.now() * 1_000 + Math.floor(Math.random() * 500);
      const tenant = await client.query<{ id: string }>(
        `insert into tenants (github_account_id, github_account_login, github_account_type)
         values ($1, 'projection-invariant', 'Organization') returning id`,
        [githubAccountId],
      );
      const installation = await client.query<{ id: string }>(
        `insert into installations (tenant_id, github_installation_id)
         values ($1, $2) returning id`,
        [tenant.rows[0].id, githubAccountId + 1],
      );
      const repository = await client.query<{ id: string }>(
        `insert into repositories (tenant_id, installation_id, github_repo_id, owner, name, default_branch)
         values ($1, $2, $3, 'omxyz', 'projection-invariant', 'main') returning id`,
        [tenant.rows[0].id, installation.rows[0].id, githubAccountId + 2],
      );
      const run = await client.query<{ id: string }>(
        `insert into review_runs
           (tenant_id, repository_id, trigger, status, idempotency_key, head_sha)
         values ($1, $2, 'pull_request', 'queued', $3, repeat('a', 40))
         returning id`,
        [tenant.rows[0].id, repository.rows[0].id, `projection-invariant-${githubAccountId}`],
      );

      await client.query(
        `update review_runs
         set result_json = jsonb_build_object(
           'status', '  completed  ',
           'error', repeat('e', 2000),
           'runtime_review', jsonb_build_object(
             'findings', jsonb_build_array(jsonb_build_object('body', repeat('x', 20000)))
           )
         )
         where id = $1`,
        [run.rows[0].id],
      );
      const projectedRun = await client.query<{ dashboard_result_json: Record<string, unknown> }>(
        `select dashboard_result_json from review_runs where id = $1`,
        [run.rows[0].id],
      );
      const result = projectedRun.rows[0].dashboard_result_json;
      assert.equal(result.status, "completed");
      assert.equal((result.error as string).length, 500);
      assert.deepEqual(Object.keys(result).sort(), ["error", "status"]);

      // A later source-only update must replace, not retain, the old projection.
      await client.query(
        `update review_runs
         set result_json = jsonb_build_object('status', 'failed', 'error', repeat('e', 2000))
         where id = $1`,
        [run.rows[0].id],
      );
      const refreshedRun = await client.query<{ dashboard_result_json: Record<string, unknown> }>(
        `select dashboard_result_json from review_runs where id = $1`,
        [run.rows[0].id],
      );
      assert.equal(refreshedRun.rows[0].dashboard_result_json.status, "failed");
      assert.equal((refreshedRun.rows[0].dashboard_result_json.error as string).length, 500);

      const projectedEvent = await client.query<{ dashboard_payload_json: Record<string, unknown> }>(
        `insert into review_run_events (review_run_id, status, payload_json, trigger_run_id)
         values (
           $1,
           'runtime_review_completed',
           jsonb_build_object(
             'status', 'issues_found',
             'summary', repeat('s', 20000),
             'findings_count', 7,
             'runtime_review', jsonb_build_object('investigations', jsonb_build_array(repeat('x', 20000)))
           ),
           'current-writer'
         )
         returning dashboard_payload_json`,
        [run.rows[0].id],
      );
      assert.equal(projectedEvent.rows[0].dashboard_payload_json.status, "issues_found");
      assert.equal((projectedEvent.rows[0].dashboard_payload_json.summary as string).length, 500);
      assert.equal(projectedEvent.rows[0].dashboard_payload_json.findings_count, 7);
      assert.equal("runtime_review" in projectedEvent.rows[0].dashboard_payload_json, false);

      await client.query(
        `insert into review_run_events (review_run_id, status, recorded_at)
         select $1, 'cardinality-' || sequence,
                timestamptz '2030-01-01 00:00:00+00' + sequence * interval '1 second'
         from generate_series(1, $2::integer + 50) sequence`,
        [run.rows[0].id, DASHBOARD_LIST_EVENT_LIMIT],
      );
      const boundedEvents = await client.query<{ status: string }>(
        DASHBOARD_LIST_EVENTS_SQL,
        [[run.rows[0].id], DASHBOARD_LIST_EVENT_LIMIT],
      );
      assert.equal(boundedEvents.rowCount, DASHBOARD_LIST_EVENT_LIMIT);
      assert.equal(boundedEvents.rows[0].status, "cardinality-51");
      assert.equal(
        boundedEvents.rows[DASHBOARD_LIST_EVENT_LIMIT - 1].status,
        `cardinality-${DASHBOARD_LIST_EVENT_LIMIT + 50}`,
      );

      const constraints = await client.query<{ conname: string; convalidated: boolean }>(
        `select conname, convalidated from pg_constraint
         where conname = any($1::text[])`,
        [
          [
            "review_runs_dashboard_projection_present",
            "review_run_events_dashboard_projection_present",
          ],
        ],
      );
      assert.deepEqual(
        constraints.rows.map((row) => [row.conname, row.convalidated]).sort(),
        [
          ["review_run_events_dashboard_projection_present", true],
          ["review_runs_dashboard_projection_present", true],
        ],
      );
    } finally {
      await client.query("rollback").catch(() => {});
      await client.end();
    }
  },
);
