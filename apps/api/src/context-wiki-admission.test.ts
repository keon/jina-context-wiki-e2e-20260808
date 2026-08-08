import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyBoardState, findTask } from "@jina/board";
import { contextWikiBoardTaskType, contextWikiBoardTopic, wikiAuditArtifactKey } from "@jina/context-engine";
import { parseWikiTriggerRequest } from "@jina/shared-kernel";
import { admitContextWikiBuild } from "./context-wiki-admission.js";

const NOW = "2026-08-08T12:00:00.000Z";
const BASE = {
  tenantId: "tenant-1",
  repository: "Acme/Docs",
  scopeKind: "branch" as const,
  scopeKey: "main",
  commitSha: "a".repeat(40),
  requestKey: "github:push:acme/docs:main:a",
  generationReason: "initial" as const,
  locale: "en",
  generatorPolicyVersion: "wiki-generator-v1",
  now: NOW
};

test("wiki admission creates one root dispatchable task and exact replay is idempotent", () => {
  const admitted = admitContextWikiBuild(createEmptyBoardState(), BASE);
  assert.equal(admitted.outcome, "created");
  assert.equal(admitted.state.tasks.length, 1);
  assert.equal(admitted.state.dependencies.length, 0);
  assert.equal(admitted.state.outbox.length, 1);
  const task = findTask(admitted.state, admitted.build.buildTaskId)!;
  assert.equal(task.type, contextWikiBoardTaskType);
  assert.equal(task.dispatchTopic, contextWikiBoardTopic);
  assert.equal(task.metadata.ref, "refs/heads/main");
  assert.equal(task.metadata.refSequence, 1);

  const duplicate = admitContextWikiBuild(admitted.state, BASE);
  assert.equal(duplicate.outcome, "duplicate");
  assert.strictEqual(duplicate.state, admitted.state);
});

test("newer mutable wiki admission supersedes only the same ref and locale", () => {
  const first = admitContextWikiBuild(createEmptyBoardState(), BASE);
  const second = admitContextWikiBuild(first.state, {
    ...BASE,
    commitSha: "b".repeat(40),
    requestKey: "github:push:acme/docs:main:b",
    generationReason: "source_update"
  });
  assert.equal(second.outcome, "created");
  assert.equal(second.request.source.refSequence, 2);
  assert.deepEqual(second.supersededBuildTaskIds, [first.build.buildTaskId]);
  assert.equal(findTask(second.state, first.build.buildTaskId)?.status, "canceled");

  const french = admitContextWikiBuild(second.state, {
    ...BASE,
    locale: "fr",
    requestKey: "github:push:acme/docs:main:a:fr"
  });
  assert.equal(french.request.source.refSequence, 1);
});

test("direct commit wiki admission has an immutable synthetic ref and no sequence", () => {
  const commit = "c".repeat(40);
  const admitted = admitContextWikiBuild(createEmptyBoardState(), {
    ...BASE,
    scopeKind: "commit",
    scopeKey: commit,
    commitSha: commit,
    requestKey: "manual:commit:c"
  });
  assert.equal(admitted.request.source.ref, `refs/commits/${commit}`);
  assert.equal(admitted.request.source.refSequence, undefined);
});

test("regional locales use one lowercase identity for Board metadata and ref sequencing", () => {
  const first = admitContextWikiBuild(createEmptyBoardState(), {
    ...BASE,
    locale: "en-US",
    requestKey: "github:push:acme/docs:main:a:en-US"
  });
  assert.equal(first.request.requestedLocale, "en-us");
  assert.equal(findTask(first.state, first.build.buildTaskId)?.metadata.locale, "en-us");
  assert.equal(first.request.source.refSequence, 1);

  const second = admitContextWikiBuild(first.state, {
    ...BASE,
    commitSha: "b".repeat(40),
    locale: "EN-us",
    requestKey: "github:push:acme/docs:main:b:EN-us",
    generationReason: "source_update"
  });
  assert.equal(second.request.requestedLocale, "en-us");
  assert.equal(second.request.source.refSequence, 2);
  assert.deepEqual(second.supersededBuildTaskIds, [first.build.buildTaskId]);
});

test("translation admission preserves source release family and locale lineage", () => {
  const translated = admitContextWikiBuild(createEmptyBoardState(), {
    ...BASE,
    requestKey: "translation:fr:source-1",
    generationReason: "translation",
    locale: "fr",
    sourceReleaseId: "release-source-1",
    sourceLocale: "en",
    releaseFamilyId: "family-source-1"
  });
  assert.equal(translated.request.generationReason, "translation");
  assert.equal(translated.request.releaseFamilyId, "family-source-1");
  assert.equal(translated.request.sourceReleaseId, "release-source-1");
  assert.equal(translated.request.sourceLocale, "en");
  assert.equal(translated.request.requestedLocale, "fr");
  assert.throws(
    () =>
      admitContextWikiBuild(createEmptyBoardState(), {
        ...BASE,
        requestKey: "translation:missing-family",
        generationReason: "translation",
        locale: "fr",
        sourceReleaseId: "release-source-1",
        sourceLocale: "en"
      }),
    /releaseFamilyId/
  );
});

test("audit-fix admission accepts the production audit artifact key without weakening repository scope", () => {
  const auditId = "wa_audit_fix_contract";
  const key = wikiAuditArtifactKey({ tenantId: BASE.tenantId, repository: BASE.repository, auditId });
  assert.equal(
    key,
    `context/tenants/${BASE.tenantId}/repositories/acme/docs/audits/${auditId}/wiki-audit-report/report.json`
  );
  const improvement = {
    auditId,
    auditedReleaseId: "cr_audited",
    auditInputDigest: "b".repeat(64),
    findingsArtifact: {
      uri: `gs://wiki-artifacts/${key}`,
      key,
      contentType: "application/json",
      bytes: 128,
      sha256: "c".repeat(64),
      objectGeneration: "1"
    },
    findingsDigest: "d".repeat(64)
  };
  const admitted = admitContextWikiBuild(createEmptyBoardState(), {
    ...BASE,
    requestKey: `wiki-audit-fix:${auditId}`,
    generationReason: "daily_audit_fix",
    parentReleaseId: improvement.auditedReleaseId,
    improvement
  });
  assert.equal(parseWikiTriggerRequest(admitted.request).improvement?.findingsArtifact.key, key);

  assert.throws(
    () =>
      admitContextWikiBuild(createEmptyBoardState(), {
        ...BASE,
        requestKey: `wiki-audit-fix:${auditId}:wrong-scope`,
        generationReason: "daily_audit_fix",
        parentReleaseId: improvement.auditedReleaseId,
        improvement: {
          ...improvement,
          findingsArtifact: {
            ...improvement.findingsArtifact,
            key: key.replace("/repositories/acme/docs/", "/repositories/acme/other/")
          }
        }
      }),
    /outside the audit's repository scope/
  );
});
