import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BoardContextPublicationError,
  FileContextArtifactStore,
  contextPublicSnapshotDigest,
  type BoardContextPublicationCommit,
  type BoardContextPublicationRecord,
  type BoardContextPublicationTransactionPort,
  type BoardContextPublicationScope,
  type ContextArtifactRef
} from "@jina/context-engine";
import {
  type ContextPublicationArtifactQuota,
  ContextBoardPublicationService,
  type PublishCertifiedContextRequest
} from "./context-board-publication.js";

const TENANT = "tenant-publication";
const REPOSITORY = "acme/context";
const REF = "main";
const COMMIT = "a".repeat(40);
const BUILD = "task_context_build";
const PUBLISHED_AT = "2026-07-30T12:00:00.000Z";

class AtomicPublicationFixture implements BoardContextPublicationTransactionPort {
  readonly records = new Map<string, BoardContextPublicationRecord>();
  readonly commits: BoardContextPublicationCommit[] = [];
  readonly frontiers = new Map<string, number>();
  beforeCommit?: (input: BoardContextPublicationCommit) => void;

  async publishAtomically(input: BoardContextPublicationCommit): Promise<BoardContextPublicationRecord> {
    if (input.lease.leaseExpiresAt <= PUBLISHED_AT) {
      throw new BoardContextPublicationError("stale_publication_lease", "lease expired");
    }
    const existing = this.records.get(input.idempotencyKey);
    if (existing) {
      if (existing.publicationInputDigest !== input.publicationInputDigest) {
        throw new BoardContextPublicationError("idempotency_conflict", "idempotency digest changed");
      }
      return structuredClone(existing);
    }
    this.beforeCommit?.(input);
    const frontierKey = scopeKey(input.scope);
    if ((this.frontiers.get(frontierKey) ?? 0) > input.scope.refSequence) {
      throw new BoardContextPublicationError("stale_ref_sequence", "newer ref already won");
    }
    const record: BoardContextPublicationRecord = {
      releaseId: input.releaseId,
      publicationInputDigest: input.publicationInputDigest,
      publicSnapshotDigest: input.publicSnapshotDigest,
      releaseArtifact: input.releaseArtifact,
      refSequence: input.scope.refSequence,
      commitSha: input.scope.commitSha,
      publishedAt: input.publishedAt
    };
    this.frontiers.set(frontierKey, input.scope.refSequence);
    this.records.set(input.idempotencyKey, structuredClone(record));
    this.commits.push(structuredClone(input));
    return structuredClone(record);
  }
}

test("certified publication is exactly-once under an idempotent replay", async () => {
  await withFixture(async ({ service, transaction, request }) => {
    const first = await service.publish(request);
    const replay = await service.publish(request);

    assert.deepEqual(replay, first);
    assert.equal(transaction.commits.length, 1);
    assert.equal(transaction.records.size, 1);
    assert.match(first.releaseId, /^cr_[0-9a-f]{32}$/);
    assert.equal(transaction.commits[0]?.pages.length, 1);
    assert.equal(transaction.commits[0]?.pages[0]?.citations.length, 1);
  });
});

test("publication rejects a certification digest that does not bind the exact page bytes", async () => {
  await withFixture(
    async ({ service, transaction, request }) => {
      await assert.rejects(
        () => service.publish(request),
        (error: unknown) =>
          error instanceof BoardContextPublicationError &&
          error.code === "certification_mismatch" &&
          error.message.includes("exact public Markdown snapshot")
      );
      assert.equal(transaction.commits.length, 0);
    },
    { certificationDigest: "f".repeat(64) }
  );
});

test("publication validates the complete page set and never commits a partially valid catalog", async () => {
  const secondPage = {
    documentPath: "components/runtime.md",
    title: "Runtime",
    bodyMarkdown: "# Runtime\n\nThe runtime [returns a stable greeting](src/missing.ts#L1-L1).\n"
  };
  await withFixture(
    async ({ service, transaction, request }) => {
      await assert.rejects(
        () => service.publish(request),
        (error: unknown) =>
          error instanceof BoardContextPublicationError &&
          error.code === "invalid_publication" &&
          error.message.includes("unresolved references")
      );
      assert.equal(transaction.commits.length, 0);
      assert.equal(transaction.records.size, 0);
    },
    {
      pages: [
        {
          documentPath: "architecture.md",
          title: "Architecture",
          bodyMarkdown: [
            "# Architecture",
            "",
            "The API [returns a stable greeting](src/index.ts#L1-L1).",
            "",
            "Read [Runtime](components/runtime.md).",
            ""
          ].join("\n")
        },
        secondPage
      ]
    }
  );
});

test("publication accepts an explicitly dispositioned unsupported new page", async () => {
  const architecture = {
    documentPath: "architecture.md",
    title: "Architecture",
    bodyMarkdown: "# Architecture\n\nThe API [returns a stable greeting](src/index.ts#L1-L1).\n"
  };
  await withFixture(
    async ({ service, transaction, request }) => {
      await service.publish(request);
      assert.deepEqual(transaction.commits[0]?.pages.map((page) => page.documentPath), ["architecture.md"]);
    },
    {
      pages: [architecture],
      plannedPages: [
        architecture,
        {
          documentPath: "legacy-administrator-deletion.md",
          title: "Legacy Administrator Deletion",
          bodyMarkdown: "# Legacy Administrator Deletion\n"
        }
      ],
      omittedPages: [
        { path: "legacy-administrator-deletion.md", reasonCode: "unsupported_core_claims" }
      ]
    }
  );
});

test("a delayed older ref sequence cannot advance the current release", async () => {
  await withFixture(async ({ service, transaction, request }) => {
    transaction.frontiers.set(scopeKey(request.scope), request.scope.refSequence + 1);
    await assert.rejects(
      () => service.publish(request),
      (error: unknown) => error instanceof BoardContextPublicationError && error.code === "stale_ref_sequence"
    );
    assert.equal(transaction.commits.length, 0);
    assert.equal(transaction.frontiers.get(scopeKey(request.scope)), 2);
  });
});

test("the ref frontier is checked inside the transaction so a newer-ref race wins", async () => {
  await withFixture(async ({ service, transaction, request }) => {
    transaction.beforeCommit = (input) => {
      transaction.frontiers.set(scopeKey(input.scope), input.scope.refSequence + 1);
    };
    await assert.rejects(
      () => service.publish(request),
      (error: unknown) => error instanceof BoardContextPublicationError && error.code === "stale_ref_sequence"
    );
    assert.equal(transaction.commits.length, 0);
    assert.equal(transaction.records.size, 0);
  });
});

test("release artifact storage is reserved before authority commit and committed afterward", async () => {
  const events: string[] = [];
  const quotaCalls: {
    reserve?: Parameters<ContextPublicationArtifactQuota["reserveArtifactStorage"]>[0];
    commit?: Parameters<ContextPublicationArtifactQuota["commitArtifactStorage"]>[0];
  } = {};
  const quota: ContextPublicationArtifactQuota = {
    async reserveArtifactStorage(input) {
      events.push("reserve");
      quotaCalls.reserve = input;
    },
    async commitArtifactStorage(input) {
      events.push("quota-commit");
      quotaCalls.commit = input;
    }
  };
  await withFixture(
    async ({ service, transaction, request }) => {
      transaction.beforeCommit = () => events.push("publication-commit");
      const result = await service.publish(request);
      assert.deepEqual(events, ["reserve", "publication-commit", "quota-commit"]);
      assert.deepEqual(quotaCalls.commit, quotaCalls.reserve);
      assert.equal(quotaCalls.commit?.tenantId, TENANT);
      assert.equal(quotaCalls.commit?.bytes, result.releaseArtifact.bytes);
      assert.match(quotaCalls.commit?.artifactId ?? "", /:context-release:cr_[0-9a-f]{32}$/);
    },
    { artifactQuota: quota }
  );
});

test("storage quota denial prevents release upload from reaching publication authority", async () => {
  const quota: ContextPublicationArtifactQuota = {
    async reserveArtifactStorage() {
      throw new Error("storage quota denied");
    },
    async commitArtifactStorage() {
      assert.fail("denied storage must never commit");
    }
  };
  await withFixture(
    async ({ service, transaction, request }) => {
      await assert.rejects(() => service.publish(request), /storage quota denied/);
      assert.equal(transaction.commits.length, 0);
    },
    { artifactQuota: quota }
  );
});

interface FixtureOptions {
  readonly certificationDigest?: string;
  readonly artifactQuota?: ContextPublicationArtifactQuota;
  readonly pages?: readonly {
    readonly documentPath: string;
    readonly title: string;
    readonly bodyMarkdown: string;
  }[];
  readonly plannedPages?: readonly {
    readonly documentPath: string;
    readonly title: string;
    readonly bodyMarkdown: string;
  }[];
  readonly omittedPages?: readonly { readonly path: string; readonly reasonCode: string }[];
}

async function withFixture(
  operation: (input: {
    readonly service: ContextBoardPublicationService;
    readonly transaction: AtomicPublicationFixture;
    readonly request: PublishCertifiedContextRequest;
  }) => Promise<void>,
  options: FixtureOptions = {}
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "context-board-publication-test-"));
  const artifacts = new FileContextArtifactStore(directory);
  const transaction = new AtomicPublicationFixture();
  const scope: BoardContextPublicationScope = {
    tenantId: TENANT,
    repository: REPOSITORY,
    ref: REF,
    refSequence: 1,
    commitSha: COMMIT,
    buildId: BUILD
  };
  try {
    const snapshot = await putJson(artifacts, scope, "evidence-snapshot", "snapshot.json", {
      tenantId: TENANT,
      repository: REPOSITORY,
      ref: REF,
      refSequence: 1,
      commitSha: COMMIT,
      files: [
        {
          path: "src/index.ts",
          blobSha: "b".repeat(40),
          body: "export function greeting() { return 'hello'; }\n",
          language: "typescript"
        }
      ],
      observations: [],
      aclFingerprint: "acl-publication",
      observationFrontier: "fixture",
      createdAt: PUBLISHED_AT,
      sourceComplete: true
    });
    const pages = options.pages ?? [
      {
        documentPath: "architecture.md",
        title: "Architecture",
        bodyMarkdown: "# Architecture\n\nThe API [returns a stable greeting](src/index.ts#L1-L1).\n"
      }
    ];
    const plan = await putJson(artifacts, scope, "publication-plan", "plan.json", {
      version: 1,
      plan: {
        pages: (options.plannedPages ?? pages).map((page) => ({ path: page.documentPath, change: "add" })),
        retiredPages: []
      }
    });
    const pageRefs = await Promise.all(
      pages.map((page, index) =>
        putJson(artifacts, scope, "context-page", `page-${index + 1}.json`, {
          version: 1,
          ...page,
          publicationPlanArtifact: plan,
          snapshotArtifact: snapshot
        })
      )
    );
    const publicSnapshotDigest =
      options.certificationDigest ??
      contextPublicSnapshotDigest(
        pages.map((page) => ({
          documentPath: page.documentPath,
          title: page.title,
          bodyMarkdown: page.bodyMarkdown
        }))
      );
    const certification = await putJson(artifacts, scope, "certification", "certification.json", {
      version: 1,
      verdict: "certified",
      publicSnapshotDigest,
      publicationPlanArtifact: plan,
      pageArtifacts: pageRefs,
      omittedPages: options.omittedPages ?? [],
      sourceChallengeArtifact: pageRefs[0],
      taskEvaluationArtifact: pageRefs[0]
    });
    const service = new ContextBoardPublicationService(artifacts, transaction, options.artifactQuota);
    await operation({
      service,
      transaction,
      request: {
        scope,
        lease: {
          taskId: "task_publication",
          messageId: "outbox_publication",
          attempt: 1,
          leaseId: "lease-publication",
          writeFenceToken: "fence-publication",
          leaseExpiresAt: "2099-01-01T00:00:00.000Z"
        },
        certificationArtifact: certification,
        idempotencyKey: "task_publication:certification-sha",
        publishedAt: PUBLISHED_AT
      }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function putJson(
  store: FileContextArtifactStore,
  scope: BoardContextPublicationScope,
  kind: "evidence-snapshot" | "publication-plan" | "context-page" | "certification",
  name: string,
  value: unknown
): Promise<ContextArtifactRef> {
  return store.put({
    tenantId: scope.tenantId,
    repository: scope.repository,
    buildId: scope.buildId,
    kind,
    name,
    contentType: "application/json",
    content: JSON.stringify(value)
  });
}

function scopeKey(scope: BoardContextPublicationScope): string {
  return `${scope.tenantId}\u0000${scope.repository}\u0000${scope.ref}`;
}
