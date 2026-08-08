import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresBoardContextPublicationRepository,
  contextPublicationMayAdvanceCurrent
} from "./context/board-publication-repository.js";
import type { ContextDatabase } from "./context/database.js";

const TENANT = "tenant-seed";
const REPOSITORY = "omxyz/jina";
const REF = "main";
const RELEASE_ID = "cr_current";

test("current release seed is derived from the latest attached release", async () => {
  let statement = "";
  let queryValues: readonly unknown[] | undefined;
  const database = {
    async queryAs(_role: string, _scope: unknown, sql: string, values: readonly unknown[]) {
      statement = sql;
      queryValues = values;
      return {
        rows: [
          {
            release_id: RELEASE_ID,
            ref_sequence: "7",
            commit_sha: "a".repeat(40),
            public_snapshot_digest: "b".repeat(64),
            release_artifact: releaseArtifact(TENANT)
          }
        ]
      };
    }
  } as unknown as ContextDatabase;

  const seed = await new PostgresBoardContextPublicationRepository(database).findCurrentReleaseSeed({
    tenantId: ` ${TENANT} `,
    repository: "OMXYZ/JINA",
    ref: REF
  });

  assert.deepEqual(queryValues, [TENANT, REPOSITORY, REF]);
  assert.match(statement, /from jina_context\.context_releases/);
  assert.match(statement, /pageindex_attached_at is not null/);
  assert.match(statement, /order by ref_sequence desc,release_id desc/);
  assert.deepEqual(seed, {
    version: 1,
    tenantId: TENANT,
    repository: REPOSITORY,
    ref: REF,
    refSequence: 7,
    commitSha: "a".repeat(40),
    releaseId: RELEASE_ID,
    publicSnapshotDigest: "b".repeat(64),
    releaseArtifact: releaseArtifact(TENANT)
  });
});

test("current release seed rejects an artifact outside the requested tenant scope", async () => {
  const database = {
    async queryAs() {
      return {
        rows: [
          {
            release_id: RELEASE_ID,
            ref_sequence: "7",
            commit_sha: "a".repeat(40),
            public_snapshot_digest: "b".repeat(64),
            release_artifact: releaseArtifact("other-tenant")
          }
        ]
      };
    }
  } as unknown as ContextDatabase;

  await assert.rejects(
    () =>
      new PostgresBoardContextPublicationRepository(database).findCurrentReleaseSeed({
        tenantId: TENANT,
        repository: REPOSITORY,
        ref: REF
      }),
    /outside its immutable repository release scope/
  );
});

test("publication must be based on the exact current release", () => {
  assert.equal(contextPublicationMayAdvanceCurrent({}), true);
  assert.equal(contextPublicationMayAdvanceCurrent({ priorRelease: { releaseId: RELEASE_ID, refSequence: 7 } }), false);
  assert.equal(contextPublicationMayAdvanceCurrent({ current: { releaseId: RELEASE_ID, refSequence: 7 } }), false);
  assert.equal(
    contextPublicationMayAdvanceCurrent({
      current: { releaseId: RELEASE_ID, refSequence: 7 },
      priorRelease: { releaseId: RELEASE_ID, refSequence: 7 }
    }),
    true
  );
  assert.equal(
    contextPublicationMayAdvanceCurrent({
      current: { releaseId: RELEASE_ID, refSequence: 7 },
      priorRelease: { releaseId: "cr_stale", refSequence: 6 }
    }),
    false
  );
});

function releaseArtifact(tenantId: string) {
  const key =
    `context/tenants/${tenantId}/repositories/omxyz/jina/builds/` + `task_prior/context-release/${RELEASE_ID}.json`;
  return {
    uri: `gs://context-artifacts/${key}`,
    key,
    contentType: "application/json",
    bytes: 512,
    sha256: "c".repeat(64),
    objectGeneration: "42"
  };
}
