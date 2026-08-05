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

test("current release seed lookup is exact-scoped and returns its immutable artifact binding", async () => {
  let queryValues: readonly unknown[] | undefined;
  let queryRole: string | undefined;
  let queryScope: unknown;
  const database = {
    async queryAs(role: string, scope: unknown, _statement: string, values: readonly unknown[]) {
      queryRole = role;
      queryScope = scope;
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

  assert.equal(queryRole, "jina_context_query");
  assert.deepEqual(queryScope, { tenantIds: [TENANT] });
  assert.deepEqual(queryValues, [TENANT, REPOSITORY, REF]);
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

test("current release seed lookup rejects an artifact outside the requested tenant scope", async () => {
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

test("current release seed lookup cold-starts across the legacy context-v2 artifact boundary", async () => {
  const database = {
    async queryAs() {
      return {
        rows: [
          {
            release_id: RELEASE_ID,
            ref_sequence: "7",
            commit_sha: "a".repeat(40),
            public_snapshot_digest: "b".repeat(64),
            release_artifact: releaseArtifact(TENANT, "context-v2")
          }
        ]
      };
    }
  } as unknown as ContextDatabase;

  const seed = await new PostgresBoardContextPublicationRepository(database).findCurrentReleaseSeed({
    tenantId: TENANT,
    repository: REPOSITORY,
    ref: REF
  });

  assert.equal(seed, undefined);
});

test("publication may replace only an older exact-scoped legacy cold-start boundary", () => {
  const current = {
    refSequence: 7,
    releaseId: RELEASE_ID,
    releaseArtifact: releaseArtifact(TENANT, "context-v2")
  };
  assert.equal(
    contextPublicationMayAdvanceCurrent({
      tenantId: TENANT,
      repository: REPOSITORY,
      publicationSequence: 8,
      current
    }),
    true
  );
  assert.equal(
    contextPublicationMayAdvanceCurrent({
      tenantId: TENANT,
      repository: REPOSITORY,
      publicationSequence: 7,
      current
    }),
    false
  );
  assert.equal(
    contextPublicationMayAdvanceCurrent({
      tenantId: TENANT,
      repository: REPOSITORY,
      publicationSequence: 8,
      current: { ...current, releaseArtifact: releaseArtifact(TENANT) }
    }),
    false
  );
  assert.equal(
    contextPublicationMayAdvanceCurrent({
      tenantId: TENANT,
      repository: REPOSITORY,
      publicationSequence: 8,
      current: { ...current, releaseArtifact: releaseArtifact("other-tenant", "context-v2") }
    }),
    false
  );
  assert.equal(
    contextPublicationMayAdvanceCurrent({
      tenantId: TENANT,
      repository: REPOSITORY,
      publicationSequence: 8,
      current: { ...current, releaseArtifact: releaseArtifact(TENANT) },
      priorRelease: { releaseId: RELEASE_ID, refSequence: 7 }
    }),
    true
  );
});

function releaseArtifact(tenantId: string, root = "context") {
  const key =
    `${root}/tenants/${tenantId}/repositories/omxyz/jina/builds/` + `task_prior/context-release/${RELEASE_ID}.json`;
  return {
    uri: `gs://context-artifacts/${key}`,
    key,
    contentType: "application/json",
    bytes: 512,
    sha256: "c".repeat(64),
    objectGeneration: "42"
  };
}
