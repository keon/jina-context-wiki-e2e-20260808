import assert from "node:assert/strict";
import test from "node:test";
import { wikiContentArtifactKey } from "@jina/context-engine";
import type { ContextDatabase } from "./context/database.js";
import { PostgresWikiTriggerPublicationRepository } from "./context/wiki-publication-repository.js";

const tenantId = "tenant-query";
const repository = "acme/widgets";
const releaseId = "cr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const commitSha = "b".repeat(40);
const bundleSha256 = "c".repeat(64);

test("wiki query repository keeps ref, commit, locale, release, and active audit resolution exact-scoped", async () => {
  const calls: { operation: string; sql: string; values: readonly unknown[] }[] = [];
  const database = {
    async queryAs(_role: string, _scope: unknown, sql: string, values: readonly unknown[], operation: string) {
      calls.push({ operation, sql, values });
      if (operation === "wiki_query.latest-audit") {
        return {
          rows: [
            {
              audit_id: "audit-1",
              audit_policy_version: "audit-v2",
              outcome: "passed",
              summary: { brokenLinks: 0 },
              completed_at: new Date("2026-08-08T02:00:00.000Z")
            }
          ]
        };
      }
      return { rows: [releaseRow()] };
    }
  } as unknown as ContextDatabase;
  const repositoryStore = new PostgresWikiTriggerPublicationRepository(database);

  const current = await repositoryStore.findCurrentPublishedWikiRelease({
    tenantId,
    repository,
    ref: "refs/heads/main",
    locale: "PT-BR"
  });
  assert.equal(current?.locale, "pt-br");
  assert.equal(current?.generationId, releaseId);
  const currentCall = calls.at(-1)!;
  assert.deepEqual(currentCall.values, [tenantId, repository, "refs/heads/main", "pt-br"]);
  assert.match(currentCall.sql, /current_release\.locale=\$4/);

  await repositoryStore.findNewestPublishedWikiReleaseForCommit({ tenantId, repository, commitSha, locale: "pt-br" });
  const commitCall = calls.at(-1)!;
  assert.deepEqual(commitCall.values, [tenantId, repository, commitSha, "pt-br"]);
  assert.doesNotMatch(commitCall.sql, /scope_kind='commit'/);
  assert.match(commitCall.sql, /published_at desc,publication\.release_id desc/);

  await repositoryStore.listPublishedWikiReleases({ tenantId, repository, releaseId, limit: 500 });
  const listCall = calls.at(-1)!;
  assert.equal(listCall.values.at(-1), 200);
  assert.equal(listCall.values[5], releaseId);

  const audit = await repositoryStore.latestWikiAuditSummary({
    tenantId,
    repository,
    releaseId,
    locale: "pt-br",
    auditPolicyVersion: "audit-v2"
  });
  assert.deepEqual(audit, {
    quality: "passed",
    auditId: "audit-1",
    auditPolicyVersion: "audit-v2",
    auditedAt: "2026-08-08T02:00:00.000Z",
    summary: { brokenLinks: 0 }
  });
  assert.deepEqual(calls.at(-1)!.values, [tenantId, repository, releaseId, "pt-br", "audit-v2"]);
});

function releaseRow() {
  return {
    release_id: releaseId,
    release_family_id: "family-1",
    repository,
    ref_name: "refs/heads/main",
    ref_sequence: "7",
    commit_sha: commitSha,
    public_snapshot_digest: "d".repeat(64),
    locale: "pt-br",
    scope_kind: "branch",
    scope_key: "main",
    published_at: new Date("2026-08-08T01:00:00.000Z"),
    content_bundle_artifact: {
      version: 1,
      tenantId,
      repository,
      publicSnapshotDigest: "d".repeat(64),
      bundleSha256,
      uri: `gs://wiki/${bundleSha256}.json`,
      key: wikiContentArtifactKey({ tenantId, repository, bundleSha256 }),
      contentType: "application/json",
      bytes: 42,
      sha256: bundleSha256,
      objectGeneration: "1"
    }
  };
}
