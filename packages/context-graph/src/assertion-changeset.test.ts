import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ASSERTION_CHANGESET_CONTRACT_VERSION,
  assertionBatchToChangeSet,
  assertionSemanticKey,
  parseAssertionChangeSet,
  type AssertionCandidate,
  type AssertionChangeSetV1
} from "./assertion-changeset.js";
import { parseEvidenceLocator } from "./evidence.js";
import { ASSERTION_CHANGESET_OUTPUT_SCHEMA } from "./schema.js";
import type { ContextGraphAssertionBatch } from "./pipeline.js";

const commitSha = "a".repeat(40);
const repository = "omlabs/jina";
const scope = {
  tenantId: "tenant-1",
  repository,
  ref: "refs/heads/main",
  commitSha,
  mode: "incremental"
} as const;
const base = {
  assertionSetVersion: "assertion-set-7",
  registryVersion: "registry-v1",
  evidenceFingerprint: "evidence-v1"
} as const;
const evidence = {
  type: "repository_range",
  repository,
  commitSha,
  path: "src/retry.ts",
  startLine: 10,
  endLine: 20,
  contentDigest: null
} as const;
const candidate: AssertionCandidate = {
  subject: {
    kind: "Symbol",
    naturalKey: `repo:${repository}:moniker:scheduleRetry`,
    label: "scheduleRetry"
  },
  predicate: "IMPLEMENTS",
  object: {
    kind: "Feature",
    naturalKey: `repo:${repository}:feature:automatic-retry`,
    label: "Automatic retry"
  },
  qualifiers: {},
  truthClass: "agent_claim",
  confidence: 0.92,
  explanation: "The function schedules another attempt after retryable worker failures.",
  evidence: [evidence],
  validFrom: null,
  validUntil: null
};

function changeset(operations: AssertionChangeSetV1["operations"]): unknown {
  return {
    contractVersion: ASSERTION_CHANGESET_CONTRACT_VERSION,
    changeSetId: "changeset-1",
    scope,
    base,
    summary: "Retry behavior is represented by a cited semantic assertion.",
    operations,
    unresolved: []
  };
}

test("assertion changesets parse every semantic operation", () => {
  const parsed = parseAssertionChangeSet(
    changeset([
      { operationId: "op-propose", type: "propose", assertion: candidate },
      {
        operationId: "op-confirm",
        type: "confirm",
        assertionId: "assertion-existing-1",
        attestations: [{ type: "source_observation", observationId: "observation-1", observationType: "pull_request" }],
        reason: "The new pull request observation independently confirms the assertion."
      },
      {
        operationId: "op-supersede",
        type: "supersede",
        assertionId: "assertion-existing-2",
        replacement: {
          ...candidate,
          predicate: "DOCUMENTED_BY",
          object: {
            kind: "Document",
            naturalKey: `repo:${repository}:path:docs/retry.md`,
            label: "Retry documentation"
          }
        },
        reason: "The earlier relationship used the wrong predicate."
      },
      {
        operationId: "op-retract",
        type: "retract",
        assertionId: "assertion-existing-3",
        evidence: [{ type: "assertion_attestation", assertionId: "assertion-existing-3", attestationId: "att-3" }],
        reason: "The supporting source was withdrawn."
      },
      {
        operationId: "op-relate",
        type: "relate",
        relation: "supports",
        sourceAssertionId: "assertion-existing-4",
        targetAssertionId: "assertion-existing-5",
        evidence: [evidence],
        reason: "Both assertions describe the same documented retry behavior."
      }
    ]),
    { scope, base }
  );

  assert.deepEqual(
    parsed.operations.map((operation) => operation.type),
    ["propose", "confirm", "supersede", "retract", "relate"]
  );
});

test("assertion changesets reject untrusted scope and base substitutions", () => {
  assert.throws(
    () => parseAssertionChangeSet(changeset([]), { scope: { ...scope, repository: "other/repo" }, base }),
    /scope.repository does not match trusted scope/
  );
  assert.throws(
    () =>
      parseAssertionChangeSet(changeset([]), {
        scope,
        base: { ...base, assertionSetVersion: "assertion-set-8" }
      }),
    /base.assertionSetVersion does not match trusted base/
  );
});

test("assertion changesets reject unknown fields and graph-shaped output", () => {
  assert.throws(
    () => parseAssertionChangeSet({ ...(changeset([]) as object), nodes: [], edges: [] }),
    /unsupported fields: edges, nodes/
  );
  assert.deepEqual(Object.keys(ASSERTION_CHANGESET_OUTPUT_SCHEMA.properties).sort(), [
    "base",
    "changeSetId",
    "contractVersion",
    "operations",
    "scope",
    "summary",
    "unresolved"
  ]);
  assert.equal("nodes" in ASSERTION_CHANGESET_OUTPUT_SCHEMA.properties, false);
  assert.equal("edges" in ASSERTION_CHANGESET_OUTPUT_SCHEMA.properties, false);
});

test("the Codex output schema closes and requires every object property", () => {
  const visit = (schema: unknown, owner: string): void => {
    if (Array.isArray(schema)) {
      schema.forEach((item, index) => visit(item, `${owner}[${index}]`));
      return;
    }
    if (typeof schema !== "object" || schema === null) return;
    const value = schema as Record<string, unknown>;
    if (value.type === "object") {
      assert.equal(value.additionalProperties, false, `${owner} must reject unknown properties`);
      const properties = Object.keys((value.properties as Record<string, unknown> | undefined) ?? {}).sort();
      const required = [...(((value.required as string[] | undefined) ?? []) as readonly string[])].sort();
      assert.deepEqual(required, properties, `${owner} must require every declared property`);
    }
    for (const [key, child] of Object.entries(value)) visit(child, `${owner}.${key}`);
  };

  visit(ASSERTION_CHANGESET_OUTPUT_SCHEMA, "changeset");
});

test("assertion changesets reject invalid evidence and evidence outside their pinned scope", () => {
  assert.throws(
    () => parseEvidenceLocator({ ...evidence, path: "../secret", startLine: 1, endLine: 1 }),
    /must be repository-relative/
  );
  assert.throws(() => parseEvidenceLocator({ ...evidence, startLine: 20, endLine: 10 }), /endLine must be greater/);
  assert.throws(
    () =>
      parseAssertionChangeSet(
        changeset([
          {
            operationId: "op-other-repository",
            type: "propose",
            assertion: {
              ...candidate,
              evidence: [{ ...evidence, repository: "other/repo" }]
            }
          }
        ]),
        { scope, base }
      ),
    /evidence repository does not match changeset scope/
  );
});

test("assertion changesets reject duplicate and conflicting operations", () => {
  assert.throws(
    () =>
      parseAssertionChangeSet(
        changeset([
          { operationId: "duplicate", type: "propose", assertion: candidate },
          {
            operationId: "duplicate",
            type: "relate",
            relation: "contradicts",
            sourceAssertionId: "assertion-1",
            targetAssertionId: "assertion-2",
            evidence: [evidence],
            reason: "The assertions cannot both describe the current implementation."
          }
        ])
      ),
    /duplicate assertion operationId/
  );
  assert.throws(
    () =>
      parseAssertionChangeSet(
        changeset([
          {
            operationId: "confirm",
            type: "confirm",
            assertionId: "assertion-1",
            attestations: [evidence],
            reason: "Fresh evidence confirms the assertion."
          },
          {
            operationId: "retract",
            type: "retract",
            assertionId: "assertion-1",
            evidence: [evidence],
            reason: "The same assertion cannot be retracted in this changeset."
          }
        ])
      ),
    /conflicting lifecycle changes/
  );
});

test("semantic assertion keys are stable across qualifier ordering", () => {
  assert.equal(
    assertionSemanticKey({ ...candidate, qualifiers: { source: "worker", retries: 3 } }),
    assertionSemanticKey({ ...candidate, qualifiers: { retries: 3, source: "worker" } })
  );
});

test("legacy assertion batches adapt to stable semantic changesets", () => {
  const batch: ContextGraphAssertionBatch = {
    tenantId: scope.tenantId,
    repository,
    ref: scope.ref,
    commitSha,
    taskId: "task-1",
    generatedAt: "2026-07-24T00:00:00.000Z",
    generatorVersion: "legacy-generator",
    registryVersion: base.registryVersion,
    evidenceFingerprint: base.evidenceFingerprint,
    evidenceObservationIds: ["observation-1"],
    model: "codex",
    summary: "Retry behavior is implemented in the worker.",
    rawOutput: {
      summary: "Retry behavior is implemented in the worker.",
      nodes: [],
      edges: []
    },
    assertions: [
      {
        subject: candidate.subject,
        predicate: candidate.predicate,
        object: candidate.object,
        confidence: candidate.confidence,
        explanation: candidate.explanation,
        evidence: ["src/retry.ts:10-20"],
        qualifiers: {}
      }
    ]
  };

  const first = assertionBatchToChangeSet(batch, { assertionSetVersion: base.assertionSetVersion });
  const second = assertionBatchToChangeSet(batch, { assertionSetVersion: base.assertionSetVersion });
  assert.deepEqual(second, first);
  assert.equal(first.operations.length, 1);
  assert.equal(first.operations[0]?.type, "propose");
  if (first.operations[0]?.type !== "propose") assert.fail("expected a proposal");
  assert.deepEqual(first.operations[0].assertion.evidence, [evidence]);
  assert.equal(first.operations[0].assertion.truthClass, "agent_claim");
  assert.equal(first.scope.mode, "incremental");
});
