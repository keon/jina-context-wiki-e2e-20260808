import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { boardPageAuditInventory, type ResearchAssignment } from "@jina/daytona";
import type { CertifiedContextReleasePage, ContextPriorPage, IngestEvidenceInput } from "@jina/context-engine";
import { parsePublicationPlanWithRepair, retainedPublicationPlanProblems } from "./board-publication-plan.js";

const QUESTION = "How does a maintainer change the request path safely?";
const ASSIGNMENT: ResearchAssignment = {
  id: "request-path",
  objective: "Trace the request path.",
  focusPaths: ["src"],
  questions: [QUESTION],
  reason: "The request path is a maintainer boundary."
};

const VALID_PLAN = {
  version: 1,
  hierarchyRationale: "One orientation page is sufficient for this focused fixture.",
  pages: [
    {
      id: "architecture",
      path: "architecture.md",
      title: "Architecture",
      purpose: "Explain the request path.",
      sourceAssignmentIds: [ASSIGNMENT.id],
      maintenanceQuestions: [QUESTION],
      coverageAreas: ["root"],
      requiredTopics: ["Request entry point and control flow"],
      diagram: "sequence",
      dependencies: []
    }
  ],
  writers: [
    {
      id: "writer-request-path",
      objective: "Document the request path.",
      pageIds: ["architecture"]
    }
  ],
  excludedAreas: []
};

const OPTIONS = {
  researchAssignments: [ASSIGNMENT],
  repositoryAreas: ["root"]
};

test("publication planning deterministically restores omitted research questions without a model repair", async () => {
  const invalid = {
    ...VALID_PLAN,
    pages: VALID_PLAN.pages.map((page) => ({ ...page, maintenanceQuestions: ["A different question"] }))
  };
  let repairCalls = 0;
  const plan = await parsePublicationPlanWithRepair({
    candidate: invalid,
    options: OPTIONS,
    repair: async () => {
      repairCalls += 1;
      throw new Error("repair must not run for deterministic question bookkeeping");
    }
  });
  assert.equal(repairCalls, 0);
  assert.deepEqual(plan.pages[0]?.maintenanceQuestions, ["A different question", QUESTION]);
});

test("publication planning does not spend a repair call on a valid candidate", async () => {
  const plan = await parsePublicationPlanWithRepair({
    candidate: VALID_PLAN,
    options: OPTIONS,
    repair: async () => {
      throw new Error("repair must not run");
    }
  });
  assert.equal(plan.pages[0]?.id, "architecture");
});

test("publication planning fails closed when the one repair is still invalid", async () => {
  const invalid = { ...VALID_PLAN, pages: [] };
  await assert.rejects(
    parsePublicationPlanWithRepair({
      candidate: invalid,
      options: OPTIONS,
      repair: async () => invalid
    }),
    /between one and forty pages/
  );
});

test("incremental planning promotes a stale retain to revise in its bounded repair", async () => {
  const priorBody = [
    "# Architecture",
    "",
    "The [request handler returns a response](src/server.ts#L1-L1).",
    "",
    "```mermaid",
    "sequenceDiagram",
    "  Client->>Server: request",
    "```"
  ].join("\n");
  const priorSnapshot = snapshot("b".repeat(40), "export const handler = () => response;");
  const priorInventory = boardPageAuditInventory({
    documentPath: "architecture.md",
    bodyMarkdown: priorBody,
    snapshot: priorSnapshot
  });
  assert.deepEqual(priorInventory.structuralProblems, []);
  const reference = priorInventory.references[0]!;
  const priorPage: CertifiedContextReleasePage = {
    documentPath: "architecture.md",
    title: "Architecture",
    bodyMarkdown: priorBody,
    bodySha256: createHash("sha256").update(priorBody).digest("hex"),
    revisionId: "rev_prior",
    citations: [
      {
        id: "citation_prior",
        revisionId: "rev_prior",
        ordinal: 0,
        claim: reference.label,
        citationId: reference.citationId,
        claimSpan: reference.claimSpan,
        anchor: {
          tenantId: priorSnapshot.tenantId,
          repository: priorSnapshot.repository,
          sourceType: "blob",
          sourceId: reference.sourceId,
          contentDigest: reference.contentDigest,
          commitSha: priorSnapshot.commitSha,
          ...(reference.pathOrUrl ? { pathOrUrl: reference.pathOrUrl } : {}),
          ...(reference.startLine === undefined ? {} : { startLine: reference.startLine }),
          ...(reference.endLine === undefined ? {} : { endLine: reference.endLine })
        }
      }
    ]
  };
  const priorCatalog: ContextPriorPage = {
    logicalId: "repository:acme/sample:architecture",
    documentPath: priorPage.documentPath,
    title: priorPage.title,
    bodyMarkdown: priorPage.bodyMarkdown,
    bodySha256: priorPage.bodySha256,
    revisionId: priorPage.revisionId
  };
  const retained = {
    ...VALID_PLAN,
    pages: VALID_PLAN.pages.map((page) => ({ ...page, change: "retain" }))
  };
  const revised = {
    ...VALID_PLAN,
    pages: VALID_PLAN.pages.map((page) => ({ ...page, change: "revise" }))
  };
  const changedSnapshot = snapshot("c".repeat(40), "export const handler = () => changedResponse;");
  let repairCalls = 0;
  const plan = await parsePublicationPlanWithRepair({
    candidate: retained,
    options: { ...OPTIONS, priorPages: [priorCatalog] },
    validate: (candidate) => {
      const problems = retainedPublicationPlanProblems({
        plan: candidate,
        priorPages: [priorPage],
        snapshot: changedSnapshot
      });
      if (problems.length > 0) throw new Error(problems.join("; "));
    },
    repair: async ({ diagnostic }) => {
      repairCalls += 1;
      assert.match(diagnostic, /changed source binding and must be revised/);
      return revised;
    }
  });
  assert.equal(repairCalls, 1);
  assert.equal(plan.pages[0]?.change, "revise");

  const unchanged = retainedPublicationPlanProblems({
    plan: { ...plan, pages: plan.pages.map((page) => ({ ...page, change: "retain" })) },
    priorPages: [priorPage],
    snapshot: priorSnapshot
  });
  assert.deepEqual(unchanged, []);
});

function snapshot(blobSha: string, body: string): IngestEvidenceInput {
  return {
    tenantId: "tenant-1",
    repository: "acme/sample",
    ref: "main",
    refSequence: 2,
    commitSha: "d".repeat(40),
    files: [{ path: "src/server.ts", blobSha, body, executable: false }],
    aclFingerprint: "e".repeat(64),
    observationFrontier: "{}",
    createdAt: "2026-07-30T00:00:00.000Z",
    sourceComplete: true
  };
}
