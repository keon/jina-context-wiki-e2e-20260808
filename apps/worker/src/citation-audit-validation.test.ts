import assert from "node:assert/strict";
import test from "node:test";
import type { CitationAuditReference, CitationAuditStageResult } from "@jina/daytona";
import { citationAuditDelta, retryCitationAuditValidation } from "./citation-audit-validation.js";

test("citation audit semantic validation retries with the exact host diagnostic", async () => {
  const calls: { attempt: number; diagnostic?: string }[] = [];
  const result = await retryCitationAuditValidation({
    attempts: 2,
    run: (attempt, diagnostic) => {
      calls.push({ attempt, ...(diagnostic ? { diagnostic } : {}) });
      return Promise.resolve(attempt === 1 ? { citationId: "invented" } : { citationId: "expected" });
    },
    parse: (value) => {
      const citationId = (value as { citationId?: unknown }).citationId;
      if (citationId !== "expected") {
        throw new Error(`citation audit result invented citation ${String(citationId)}`);
      }
      return citationId;
    }
  });

  assert.equal(result, "expected");
  assert.deepEqual(calls, [
    { attempt: 1 },
    { attempt: 2, diagnostic: "citation audit result invented citation invented" }
  ]);
});

test("citation audit semantic validation remains bounded and preserves the final error", async () => {
  let runs = 0;
  await assert.rejects(
    retryCitationAuditValidation({
      attempts: 2,
      run: () => {
        runs += 1;
        return Promise.resolve({});
      },
      parse: () => {
        throw new Error("still invalid");
      }
    }),
    /still invalid/
  );
  assert.equal(runs, 2);
});

test("citation audit validation does not retry executor or transport failures", async () => {
  let runs = 0;
  await assert.rejects(
    retryCitationAuditValidation({
      attempts: 2,
      run: () => {
        runs += 1;
        return Promise.reject(new Error("executor transport unavailable"));
      },
      parse: () => "unreachable"
    }),
    /executor transport unavailable/
  );
  assert.equal(runs, 1);
});

test("citation audit delta reuses only exact digest-bound supported bindings", () => {
  const stable = reference("stable", "The stable claim.", "a".repeat(64));
  const changedClaim = reference("changed-claim", "The old claim.", "b".repeat(64));
  const changedSource = reference("changed-source", "The source-bound claim.", "c".repeat(64));
  const unsupported = reference("unsupported", "The rejected claim.", "d".repeat(64));
  const priorReferences = [stable, changedClaim, changedSource, unsupported];
  const priorAudit = audit([
    result("stable", "supported"),
    result("changed-claim", "supported"),
    result("changed-source", "supported"),
    result("unsupported", "unsupported")
  ]);

  const currentReferences = [
    stable,
    { ...changedClaim, claimSpan: "The narrowed claim.", label: "The narrowed claim." },
    { ...changedSource, contentDigest: "e".repeat(64), excerpt: "changed source bytes" },
    unsupported,
    reference("new", "A new claim.", "f".repeat(64))
  ];
  const delta = citationAuditDelta({
    references: currentReferences,
    priorReferences,
    priorAudit
  });

  assert.deepEqual(
    delta.reusedResults.map((entry) => entry.citationId),
    ["stable"]
  );
  assert.deepEqual(
    delta.pendingReferences.map((entry) => entry.citationId),
    ["changed-claim", "changed-source", "unsupported", "new"]
  );
});

test("citation audit delta re-audits an entire multi-source claim when one binding changes", () => {
  const first = { ...reference("first", "The compound claim.", "a".repeat(64)), claimId: "claim_compound" };
  const second = { ...reference("second", "The compound claim.", "b".repeat(64)), claimId: "claim_compound" };
  const independent = {
    ...reference("independent", "The independent claim.", "c".repeat(64)),
    claimId: "claim_independent"
  };
  const delta = citationAuditDelta({
    references: [{ ...first, excerpt: "changed first source bytes" }, second, independent],
    priorReferences: [first, second, independent],
    priorAudit: audit([result("first", "supported"), result("second", "supported"), result("independent", "supported")])
  });

  assert.deepEqual(
    delta.reusedResults.map((entry) => entry.citationId),
    ["independent"]
  );
  assert.deepEqual(
    delta.pendingReferences.map((entry) => entry.citationId),
    ["first", "second"]
  );
});

test("citation audit delta reuses an unsupported verdict only for an exact host-retained page", () => {
  const rejected = reference("rejected", "The unsupported claim.", "a".repeat(64));
  const priorAudit = audit([result("rejected", "unsupported")]);

  assert.deepEqual(
    citationAuditDelta({
      references: [rejected],
      priorReferences: [rejected],
      priorAudit
    }).pendingReferences.map((entry) => entry.citationId),
    ["rejected"]
  );
  assert.deepEqual(
    citationAuditDelta({
      references: [rejected],
      priorReferences: [rejected],
      priorAudit,
      reuseAllExactVerdicts: true
    }).reusedResults.map((entry) => entry.citationId),
    ["rejected"]
  );
});

test("citation audit delta accepts independently validated results from several prior page audits", () => {
  const firstPage = reference("first-page", "The first page claim.", "a".repeat(64));
  const secondPage = {
    ...reference("second-page", "The second page claim.", "b".repeat(64)),
    documentPath: "operations.md"
  };
  const delta = citationAuditDelta({
    references: [firstPage, secondPage],
    priorReferences: [firstPage, secondPage],
    priorResults: [result("first-page", "supported"), result("second-page", "supported")]
  });

  assert.deepEqual(
    delta.reusedResults.map((entry) => entry.citationId),
    ["first-page", "second-page"]
  );
  assert.deepEqual(delta.pendingReferences, []);
});

function reference(citationId: string, claimSpan: string, contentDigest: string): CitationAuditReference {
  return {
    citationId,
    claimId: `claim_${citationId}`,
    documentPath: "architecture.md",
    label: claimSpan,
    claimSpan,
    target: "src/example.ts#L1-L2",
    sourceType: "blob",
    sourceId: "1".repeat(40),
    contentDigest,
    pathOrUrl: "src/example.ts",
    startLine: 1,
    endLine: 2,
    excerpt: "const example = true;"
  };
}

function result(citationId: string, verdict: "supported" | "unsupported"): CitationAuditStageResult["results"][number] {
  return {
    citationId,
    verdict,
    rationale: `${verdict} rationale`,
    correction:
      verdict === "supported"
        ? null
        : {
            path: "src/example.ts",
            startLine: 1,
            endLine: 2,
            providerUrl: null,
            exactSourceAnchor: "const example"
          }
  };
}

function audit(results: CitationAuditStageResult["results"]): CitationAuditStageResult {
  return {
    version: 1,
    inputDigest: "1".repeat(64),
    publicSnapshotDigest: "2".repeat(64),
    worker: { id: "citation-auditor", summary: "prior audit" },
    results,
    summary: "prior audit"
  };
}
