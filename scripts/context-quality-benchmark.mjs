#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  documentPathFromFile,
  markdownEvidenceSections,
  parseMarkdownDocument
} from "../packages/context-engine/dist/derive/markdown-document.js";

const SCHEMA_VERSION = "context-quality-benchmark-v3";
const SUPPORTED_PLAN_VERSION = 4;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CITATION_ID_PATTERN = /^cite_[a-f0-9]{20}$/;

export async function analyzeContextQuality(inputPath, options = {}) {
  const current = await loadArtifact(inputPath, options.planPath);
  const previous = options.previousPath
    ? await loadArtifact(options.previousPath, options.previousPlanPath)
    : undefined;
  const violations = [];
  const questionById = new Map();
  const duplicateQuestionIds = new Set();
  const allItems = current.plan.items ?? [];
  const itemById = new Map(allItems.map((item) => [item.id, item]));

  for (const subject of current.plan.subjects ?? []) {
    for (const question of subject.questions ?? []) {
      if (questionById.has(question.id)) duplicateQuestionIds.add(question.id);
      questionById.set(question.id, question);
    }
  }
  for (const questionId of duplicateQuestionIds) {
    violation(violations, "duplicate_question", `Maintenance question ${questionId} is declared more than once.`);
  }

  const gapById = new Map((current.plan.gaps ?? []).map((gap) => [gap.id, gap]));
  const completedResults = [];
  const latestResultByQuestion = new Map();
  for (const review of current.plan.reviews ?? []) {
    if (review.status !== "complete") continue;
    const resultIds = new Set();
    for (const result of review.results ?? []) {
      if (resultIds.has(result.questionId)) {
        violation(
          violations,
          "duplicate_review_result",
          `Completed review ${review.id} records question ${result.questionId} more than once.`
        );
      }
      resultIds.add(result.questionId);
      if (!questionById.has(result.questionId)) {
        violation(
          violations,
          "unknown_review_question",
          `Completed review ${review.id} refers to unknown question ${result.questionId}.`
        );
      }
      if (!Array.isArray(result.pageIds) || result.pageIds.length === 0) {
        violation(
          violations,
          "review_without_pages",
          `Completed review ${review.id} did not identify context pages used for ${result.questionId}.`
        );
      }
      const question = questionById.get(result.questionId);
      for (const pageId of result.pageIds ?? []) {
        if (!itemById.has(pageId)) {
          violation(
            violations,
            "unknown_review_page",
            `Completed review ${review.id} refers to unknown page ${pageId}.`
          );
        } else if (question && !(question.pageIds ?? []).includes(pageId)) {
          violation(
            violations,
            "review_page_outside_answer",
            `Completed review ${review.id} used page ${pageId} outside ${result.questionId}'s declared answer.`
          );
        }
      }
      for (const gapId of result.gapIds ?? []) {
        if (!gapById.has(gapId)) {
          violation(violations, "unknown_review_gap", `Completed review ${review.id} refers to unknown gap ${gapId}.`);
        }
      }
      if ((result.verdict === "partial" || result.verdict === "fail") && (result.gapIds ?? []).length === 0) {
        violation(
          violations,
          "failed_review_without_gap",
          `${result.questionId} has verdict ${result.verdict} but no recorded coverage gap.`
        );
      }
      completedResults.push({ reviewId: review.id, ...result });
      latestResultByQuestion.set(result.questionId, { reviewId: review.id, ...result });
    }
  }

  const questions = [...questionById.values()];
  const requiredQuestions = questions.filter((question) => question.priority === "required");
  const requiredLatestPasses = requiredQuestions.filter(
    (question) => latestResultByQuestion.get(question.id)?.verdict === "pass"
  );
  for (const question of requiredQuestions) {
    if (question.status !== "answered") {
      violation(
        violations,
        "required_question_not_answered",
        `Required maintenance question ${question.id} is ${question.status}, not answered.`
      );
    }
    const latest = latestResultByQuestion.get(question.id);
    if (!latest || latest.verdict !== "pass") {
      violation(
        violations,
        "required_question_not_passed",
        `Required maintenance question ${question.id} has no latest completed critic pass.`
      );
    }
  }
  for (const question of questions) {
    for (const pageId of question.pageIds ?? []) {
      const item = itemById.get(pageId);
      if (!item) {
        violation(
          violations,
          "unknown_question_page",
          `Maintenance question ${question.id} refers to unknown page ${pageId}.`
        );
      } else if (!(item.questions ?? []).includes(question.id)) {
        violation(
          violations,
          "question_page_not_bidirectional",
          `Maintenance question ${question.id} maps to ${pageId}, but that page does not map back.`
        );
      }
    }
  }
  if ((current.plan.subjects ?? []).length === 0) {
    violation(violations, "no_subjects", "A complete context plan must contain discovered repository subjects.");
  }
  if (requiredQuestions.length === 0) {
    violation(
      violations,
      "no_required_questions",
      "A complete context plan must contain at least one required maintenance question."
    );
  }

  const passingPageIds = new Set(
    [...latestResultByQuestion.values()]
      .filter((result) => result.verdict === "pass")
      .flatMap((result) => result.pageIds ?? [])
  );
  const completeItems = allItems.filter((item) => item.status === "complete");
  const itemByPath = new Map(allItems.map((item) => [normalizeRelativePath(item.path), item]));
  const documentByPath = new Map(current.documents.map((document) => [document.relativePath, document]));

  for (const item of allItems) {
    for (const questionId of item.questions ?? []) {
      const question = questionById.get(questionId);
      if (!question) {
        violation(
          violations,
          "unknown_page_question",
          `Plan item ${item.id} refers to unknown maintenance question ${questionId}.`
        );
      } else if (!(question.pageIds ?? []).includes(item.id)) {
        violation(
          violations,
          "page_question_not_bidirectional",
          `Plan item ${item.id} maps to ${questionId}, but that question does not map back.`
        );
      }
    }
  }
  for (const item of completeItems) {
    if (!passingPageIds.has(item.id)) {
      violation(
        violations,
        "untested_complete_page",
        `Complete context page ${item.id} is not used by any latest passing critic result.`
      );
    }
    if (!documentByPath.has(normalizeRelativePath(item.path))) {
      violation(
        violations,
        "missing_complete_document",
        `Complete plan item ${item.id} has no output document at ${item.path}.`
      );
    }
  }
  if (completeItems.length === 0) {
    violation(violations, "no_complete_pages", "A complete context plan must contain at least one complete page.");
  }
  for (const document of current.documents) {
    const item = itemByPath.get(document.relativePath);
    if (!item) {
      violation(
        violations,
        "unplanned_document",
        `Output document ${document.relativePath} is not represented by a plan item.`
      );
    } else if (item.status !== "complete") {
      violation(
        violations,
        "noncomplete_output_document",
        `Output document ${document.relativePath} belongs to a ${item.status} plan item.`
      );
    }
    if (document.exactSourceLinks.length === 0) {
      violation(
        violations,
        "ungrounded_document",
        `Output document ${document.relativePath} has no exact line-anchored source link.`
      );
    }
    for (const section of markdownEvidenceSections(
      document.bodyMarkdown,
      documentPathFromFile(document.relativePath)
    )) {
      if (section.substantiveClaimCount === 0 || section.citationIds.length > 0) continue;
      violation(
        violations,
        "ungrounded_substantive_section",
        `${document.relativePath} has no core evidence binding in section ${section.heading}.`
      );
    }
    const groundedSummaryClaims = document.materialClaims.filter(
      (claim) => claim.summary && claim.classification === "material" && claim.citationIds.length > 0
    );
    if (groundedSummaryClaims.length === 0) {
      violation(
        violations,
        "uncited_summary",
        `${document.relativePath} has no directly grounded material claim in its lead summary.`
      );
    }
    for (const link of document.overbroadSourceLinks) {
      violation(
        violations,
        "overbroad_source_link",
        `${document.relativePath} uses a source range wider than 120 lines: ${link}.`
      );
    }
    for (const brokenLink of document.brokenDocumentLinks) {
      violation(
        violations,
        "broken_context_link",
        `${document.relativePath} links to missing context document ${brokenLink}.`
      );
    }
  }

  const openBlockingGaps = (current.plan.gaps ?? []).filter(
    (gap) => gap.severity === "blocking" && gap.status === "open"
  );
  for (const gap of openBlockingGaps) {
    violation(violations, "open_blocking_gap", `Blocking coverage gap ${gap.id} remains open.`);
  }
  if (current.plan.version !== SUPPORTED_PLAN_VERSION) {
    violation(
      violations,
      "unsupported_plan_version",
      `Expected orchestration version ${SUPPORTED_PLAN_VERSION}, received ${String(current.plan.version)}.`
    );
  }
  if (current.plan.phase !== "complete") {
    violation(violations, "incomplete_plan", `Orchestration phase is ${String(current.plan.phase)}, not complete.`);
  }
  if (!current.plan.completionReason?.trim()) {
    violation(violations, "missing_completion_reason", "A complete context plan must record why it is complete.");
  }

  const sourcePaths = new Set(current.documents.flatMap((document) => document.exactSourcePaths));
  const architecture = documentByPath.get("architecture.md");
  if (!architecture) {
    violation(violations, "missing_architecture", "The public context tree has no architecture.md overview.");
  } else {
    const reachable = reachableDocuments("architecture.md", documentByPath);
    for (const document of current.documents) {
      if (!reachable.has(document.relativePath)) {
        violation(
          violations,
          "unreachable_document",
          `${document.relativePath} is not reachable from architecture.md through context links.`
        );
      }
    }
  }
  const providerSignals = (current.plan.subjects ?? [])
    .flatMap((subject) => subject.signals ?? [])
    .filter((signal) => ["commit", "pull_request", "issue", "observation"].includes(signal.source));
  const providerRequiredItems = completeItems.filter((item) => item.requiredEvidence?.includes("provider"));
  const providerCoveredItems = providerRequiredItems.filter(
    (item) => documentByPath.get(normalizeRelativePath(item.path))?.providerLinks.length
  );
  for (const item of providerRequiredItems) {
    if (!documentByPath.get(normalizeRelativePath(item.path))?.providerLinks.length) {
      violation(
        violations,
        "missing_required_provider_evidence",
        `Plan item ${item.id} requires provider evidence but its document has no provider-history link.`
      );
    }
  }

  const historyRequiredItems = completeItems.filter((item) => item.requiredEvidence?.includes("history"));
  const historyCoveredItems = historyRequiredItems.filter(
    (item) =>
      documentByPath.get(normalizeRelativePath(item.path))?.providerLinks.length ||
      (current.plan.subjects ?? []).some(
        (subject) =>
          subject.kind === "history" &&
          (subject.pageIds ?? []).includes(item.id) &&
          (subject.signals ?? []).some((signal) =>
            ["commit", "pull_request", "issue", "observation"].includes(signal.source)
          )
      )
  );
  for (const item of historyRequiredItems) {
    if (!historyCoveredItems.includes(item)) {
      violation(
        violations,
        "missing_required_history_evidence",
        `Plan item ${item.id} requires history evidence but its document is not connected to captured history.`
      );
    }
  }
  const providerSignalSubjects = (current.plan.subjects ?? []).filter(
    (subject) =>
      subject.status === "covered" &&
      (subject.signals ?? []).some((signal) =>
        ["commit", "pull_request", "issue", "observation"].includes(signal.source)
      )
  );
  for (const subject of providerSignalSubjects) {
    const cited = (subject.pageIds ?? []).some((pageId) => {
      const item = itemById.get(pageId);
      return item && documentByPath.get(normalizeRelativePath(item.path))?.providerLinks.length;
    });
    if (!cited) {
      violation(
        violations,
        "uncited_provider_subject",
        `Covered subject ${subject.id} uses provider/history signals but none of its pages links that evidence.`
      );
    }
  }

  const citationAudit = analyzeCitationAudit(current, violations);

  const currentHashes = new Map(current.documents.map((document) => [document.relativePath, document.sha256]));
  const previousHashes = previous
    ? new Map(previous.documents.map((document) => [document.relativePath, document.sha256]))
    : undefined;
  const addedDocuments = previousHashes
    ? [...currentHashes.keys()].filter((relativePath) => !previousHashes.has(relativePath))
    : [];
  const removedDocuments = previousHashes
    ? [...previousHashes.keys()].filter((relativePath) => !currentHashes.has(relativePath))
    : [];
  const changedDocuments = previousHashes
    ? [...currentHashes].filter(
        ([relativePath, sha256]) => previousHashes.has(relativePath) && previousHashes.get(relativePath) !== sha256
      )
    : [];
  const unchangedDocuments = previousHashes
    ? [...currentHashes].filter(
        ([relativePath, sha256]) => previousHashes.has(relativePath) && previousHashes.get(relativePath) === sha256
      )
    : [];

  const previousProviderReferences = new Set(
    (previous?.plan.subjects ?? [])
      .flatMap((subject) => subject.signals ?? [])
      .filter((signal) => ["commit", "pull_request", "issue", "observation"].includes(signal.source))
      .map((signal) => `${signal.source}\0${signal.reference}`)
  );
  const providerEvidenceAdvanced = previous
    ? providerSignals.some((signal) => !previousProviderReferences.has(`${signal.source}\0${signal.reference}`))
    : false;
  if (previous) {
    if (current.plan.mode !== "incremental") {
      violation(
        violations,
        "incremental_mode_missing",
        "A previous artifact was supplied, but the current plan is not incremental."
      );
    }
    if (current.plan.commitSha === previous.plan.commitSha && !providerEvidenceAdvanced) {
      violation(
        violations,
        "frontier_not_advanced",
        "Neither the repository commit nor captured provider evidence advanced from the previous artifact."
      );
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    benchmarkBasis: {
      comparison: "DeepWiki and Code Wiki documentation/context quality",
      parityUnit: "repository-specific maintenance-task answerability",
      excludedMetric: "word-count parity",
      queryBoundary: "Context retrieval returns cited context, not an LLM-generated answer"
    },
    input: {
      artifactPath: current.artifactPath,
      outputPath: current.outputPath,
      planPath: current.planPath,
      ...(previous
        ? {
            previousArtifactPath: previous.artifactPath,
            previousOutputPath: previous.outputPath,
            previousPlanPath: previous.planPath
          }
        : {})
    },
    repository: {
      name: current.plan.repository,
      ref: current.plan.ref,
      commitSha: current.plan.commitSha,
      mode: current.plan.mode
    },
    result: violations.length === 0 ? "pass" : "fail",
    hardContractPass: violations.length === 0,
    metrics: {
      orchestration: {
        version: current.plan.version,
        phase: current.plan.phase,
        durablePlanPresent: true,
        planItems: current.plan.items?.length ?? 0,
        completeItems: completeItems.length,
        outputDocuments: current.documents.length,
        openBlockingGaps: openBlockingGaps.length
      },
      taskAnswerability: {
        questions: questions.length,
        requiredQuestions: requiredQuestions.length,
        requiredLatestPasses: requiredLatestPasses.length,
        requiredLatestPassRate: ratio(requiredLatestPasses.length, requiredQuestions.length),
        completedCriticResults: completedResults.length,
        latestVerdicts: Object.fromEntries(
          questions.map((question) => [question.id, latestResultByQuestion.get(question.id)?.verdict ?? "not_reviewed"])
        ),
        completePagesUsedByLatestPass: completeItems.filter((item) => passingPageIds.has(item.id)).length,
        completePagePassCoverage: ratio(
          completeItems.filter((item) => passingPageIds.has(item.id)).length,
          completeItems.length
        )
      },
      grounding: {
        exactSourceLinks: current.documents.reduce((total, document) => total + document.exactSourceLinks.length, 0),
        overbroadSourceLinks: current.documents.reduce(
          (total, document) => total + document.overbroadSourceLinks.length,
          0
        ),
        distinctExactSourcePaths: sourcePaths.size,
        documentsWithExactSourceLinks: current.documents.filter((document) => document.exactSourceLinks.length > 0)
          .length,
        exactSourceCoverage: ratio(
          current.documents.filter((document) => document.exactSourceLinks.length > 0).length,
          current.documents.length
        )
      },
      citationAudit,
      hierarchy: {
        headings: current.documents.reduce((total, document) => total + document.headings.length, 0),
        nestedHeadings: current.documents.reduce(
          (total, document) => total + document.headings.filter((heading) => heading.level > 1).length,
          0
        ),
        contextCrosslinks: current.documents.reduce((total, document) => total + document.documentLinks.length, 0),
        documentsWithCrosslinks: current.documents.filter((document) => document.documentLinks.length > 0).length,
        brokenContextCrosslinks: current.documents.reduce(
          (total, document) => total + document.brokenDocumentLinks.length,
          0
        )
      },
      diagrams: {
        mermaidBlocks: current.documents.reduce((total, document) => total + document.mermaidBlocks, 0),
        documentsWithMermaid: current.documents.filter((document) => document.mermaidBlocks > 0).length,
        note: "Diagram usefulness is judged by critic task results; a decorative diagram count is not a parity gate."
      },
      providerAndHistory: {
        applicable: providerSignals.length > 0 || providerRequiredItems.length > 0 || historyRequiredItems.length > 0,
        providerSignals: providerSignals.length,
        providerLinks: current.documents.reduce((total, document) => total + document.providerLinks.length, 0),
        providerRequiredItems: providerRequiredItems.length,
        providerCoveredItems: providerCoveredItems.length,
        providerSignalSubjects: providerSignalSubjects.length,
        historyRequiredItems: historyRequiredItems.length,
        historyCoveredItems: historyCoveredItems.length
      },
      incrementalFreshness: {
        evaluated: Boolean(previous),
        ...(previous
          ? {
              previousCommitSha: previous.plan.commitSha,
              currentCommitSha: current.plan.commitSha,
              commitAdvanced: current.plan.commitSha !== previous.plan.commitSha,
              providerEvidenceAdvanced,
              addedDocuments,
              removedDocuments,
              changedDocuments: changedDocuments.map(([relativePath]) => relativePath),
              unchangedDocuments: unchangedDocuments.map(([relativePath]) => relativePath)
            }
          : {
              note: "Supply a previous artifact to test commit advancement and incremental mode."
            }),
        checkpointEvidence: {
          durablePlan: true,
          retainedCompletedDocuments: completeItems.filter((item) =>
            documentByPath.has(normalizeRelativePath(item.path))
          ).length,
          resumeExecutionVerified: false,
          note: "Artifact inspection proves durable state exists; interrupted-run reuse must be verified by an end-to-end resume test."
        }
      }
    },
    violations
  };
}

async function loadArtifact(inputPath, explicitPlanPath) {
  const artifactPath = path.resolve(inputPath);
  const inputStat = await stat(artifactPath);
  if (!inputStat.isDirectory()) throw new Error(`Benchmark input is not a directory: ${artifactPath}`);
  const outputPath =
    path.basename(artifactPath) === "derive-output"
      ? artifactPath
      : (await isDirectory(path.join(artifactPath, "derive-output")))
        ? path.join(artifactPath, "derive-output")
        : artifactPath;
  const planCandidates = [
    explicitPlanPath && path.resolve(explicitPlanPath),
    path.join(outputPath, ".context-plan.json"),
    path.join(artifactPath, ".context-plan.json"),
    path.join(path.dirname(outputPath), "derive-state", "plan.json")
  ].filter(Boolean);
  let planPath;
  for (const candidate of planCandidates) {
    if (await isFile(candidate)) {
      planPath = candidate;
      break;
    }
  }
  if (!planPath) {
    throw new Error(
      `No context plan found. Checked ${planCandidates.join(", ")}; set CONTEXT_BENCHMARK_PLAN to override.`
    );
  }
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const markdownPaths = await listMarkdownFiles(outputPath);
  const relativePaths = new Set(
    markdownPaths.map((filePath) => normalizeRelativePath(path.relative(outputPath, filePath)))
  );
  const documents = await Promise.all(
    markdownPaths.map(async (filePath) => {
      const relativePath = normalizeRelativePath(path.relative(outputPath, filePath));
      const markdown = await readFile(filePath, "utf8");
      return analyzeMarkdown(relativePath, markdown, relativePaths);
    })
  );
  const statePath = path.join(path.dirname(outputPath), "derive-state");
  const agentStagesPath = path.join(statePath, "agent-stages");
  const auditArtifacts = {
    input: await readJsonArtifact(path.join(agentStagesPath, "citation-audit-input.json")),
    result: await readJsonArtifact(path.join(agentStagesPath, "citation-audit.json")),
    checkpoint: await readJsonArtifact(path.join(agentStagesPath, "citation-audit.checkpoint.json")),
    certification: await readJsonArtifact(path.join(agentStagesPath, "certification.json"))
  };
  return {
    artifactPath,
    outputPath,
    statePath,
    planPath,
    plan,
    documents,
    auditArtifacts,
    retainedRun: await isDirectory(statePath)
  };
}

async function readJsonArtifact(filePath) {
  if (!(await isFile(filePath))) return { present: false };
  const raw = await readFile(filePath, "utf8");
  try {
    return { present: true, raw, value: JSON.parse(raw) };
  } catch (error) {
    return {
      present: true,
      raw,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function analyzeCitationAudit(current, violations) {
  const citations = current.documents.flatMap((document) => document.evidenceCitations);
  const citationIds = citations.map((citation) => citation.citationId);
  const currentCitationIds = new Set(citationIds);
  const duplicatePublicCitationIds = duplicates(citationIds);
  for (const citationId of duplicatePublicCitationIds) {
    violation(
      violations,
      "duplicate_public_citation_id",
      `Stable public citation identity ${citationId} occurs more than once.`
    );
  }
  for (const citation of citations) {
    if (!CITATION_ID_PATTERN.test(citation.citationId)) {
      violation(
        violations,
        "unstable_public_citation_id",
        `${citation.documentPath} contains an evidence link without a stable citation identity.`
      );
    }
  }

  const artifacts = current.auditArtifacts;
  const requiredArtifacts = [
    ["input", "missing_citation_audit_input", "citation-audit input"],
    ["result", "missing_citation_audit_result", "citation-audit result"],
    ["checkpoint", "missing_citation_audit_checkpoint", "citation-audit checkpoint"],
    ["certification", "missing_citation_audit_certification", "critic certification"]
  ];
  for (const [key, code, label] of requiredArtifacts) {
    const artifact = artifacts[key];
    if (!artifact.present) {
      violation(
        violations,
        code,
        `Parity requires the retained private ${label}; a direct output snapshot alone cannot prove source-aware audit.`
      );
    } else if (artifact.error) {
      violation(violations, `invalid_${key}_json`, `The retained private ${label} is not valid JSON.`);
    }
  }
  const privateArtifactsPresent = requiredArtifacts.every(([key]) => artifacts[key].present);

  const input = recordOrUndefined(artifacts.input.value);
  const audit = recordOrUndefined(artifacts.result.value);
  const checkpoint = recordOrUndefined(artifacts.checkpoint.value);
  const certification = recordOrUndefined(artifacts.certification.value);
  // Runtime intentionally binds two different views. The context-only critic
  // sees only plan-addressable pages with page IDs and trimmed bodies, while the
  // citation auditor binds every public Markdown file and its exact bytes. Do
  // not collapse these digests: doing so makes every real retained run fail the
  // benchmark even though both runtime certificates are valid.
  const currentAuditSnapshot = publicDocumentSnapshot(current);
  const currentSnapshotDigest = sha256(currentAuditSnapshot);
  const currentCriticSnapshotDigest = sha256(publicContextSnapshot(current));
  const pageCounters = new Map(
    current.documents.map((document) => [
      document.relativePath,
      {
        path: document.relativePath,
        total: document.evidenceCitations.length,
        inputBound: 0,
        audited: 0,
        supported: 0,
        unsupported: 0
      }
    ])
  );

  if (!input || !audit || !checkpoint || !certification) {
    return citationAuditMetrics({
      retainedRun: current.retainedRun,
      privateArtifactsPresent,
      available: false,
      citations,
      pageCounters,
      currentSnapshotDigest,
      inputBound: 0,
      audited: 0,
      supported: 0,
      unsupported: 0
    });
  }

  const declaredInputDigest = typeof input.inputDigest === "string" ? input.inputDigest : "";
  const inputPayload = { ...input };
  delete inputPayload.inputDigest;
  const computedInputDigest = sha256(JSON.stringify(inputPayload));
  if (!SHA256_PATTERN.test(declaredInputDigest) || declaredInputDigest !== computedInputDigest) {
    violation(
      violations,
      "citation_audit_input_digest_mismatch",
      "The citation-audit input digest does not bind the persisted input payload."
    );
  }
  if (input.version !== 1) {
    violation(violations, "unsupported_citation_audit_version", "The citation-audit input version is not 1.");
  }
  if (input.publicSnapshotDigest !== currentSnapshotDigest) {
    violation(
      violations,
      "citation_audit_public_snapshot_mismatch",
      "The citation-audit input does not bind the current exact public Markdown snapshot."
    );
  }
  validateAuditRepositoryCheckpoint(input.checkpoint, current.plan, "input", violations);

  const references = Array.isArray(input.references) ? input.references : [];
  if (!Array.isArray(input.references)) {
    violation(
      violations,
      "invalid_citation_audit_references",
      "The citation-audit input does not contain a references array."
    );
  }
  if (references.length !== citations.length) {
    violation(
      violations,
      "citation_audit_reference_count_mismatch",
      `The citation-audit input contains ${references.length} references for ${citations.length} current public citations.`
    );
  }
  const referencesById = groupRecordsByString(references, "citationId");
  let inputBound = 0;
  for (const citation of citations) {
    const candidates = referencesById.get(citation.citationId) ?? [];
    if (candidates.length === 0) {
      violation(
        violations,
        "citation_audit_reference_missing",
        `The citation-audit input omits ${citation.citationId} from ${citation.documentPath}.`
      );
      continue;
    }
    if (candidates.length > 1) {
      violation(
        violations,
        "citation_audit_reference_duplicate",
        `The citation-audit input includes ${citation.citationId} more than once.`
      );
      continue;
    }
    if (!citationReferenceMatches(candidates[0], citation)) {
      violation(
        violations,
        "citation_audit_reference_mismatch",
        `The citation-audit input reference for ${citation.citationId} does not match the current public claim and target.`
      );
      continue;
    }
    inputBound += 1;
    pageCounters.get(citation.documentPath).inputBound += 1;
  }
  for (const [citationId] of referencesById) {
    if (!currentCitationIds.has(citationId)) {
      violation(
        violations,
        "citation_audit_reference_stale",
        `The citation-audit input contains stale or invented citation ${citationId}.`
      );
    }
  }

  if (audit.version !== 1) {
    violation(violations, "unsupported_citation_audit_result_version", "The citation-audit result version is not 1.");
  }
  if (
    audit.inputDigest !== declaredInputDigest ||
    audit.publicSnapshotDigest !== currentSnapshotDigest ||
    recordOrUndefined(audit.worker)?.id !== "citation-audit"
  ) {
    violation(
      violations,
      "citation_audit_result_binding_mismatch",
      "The citation-audit result does not bind the current input digest, public snapshot, and audit worker."
    );
  }
  const results = Array.isArray(audit.results) ? audit.results : [];
  if (!Array.isArray(audit.results)) {
    violation(
      violations,
      "invalid_citation_audit_results",
      "The citation-audit result does not contain a results array."
    );
  }
  if (results.length !== citations.length) {
    violation(
      violations,
      "citation_audit_result_count_mismatch",
      `The citation-audit result contains ${results.length} results for ${citations.length} current public citations.`
    );
  }
  const resultsById = groupRecordsByString(results, "citationId");
  let audited = 0;
  let supported = 0;
  let unsupported = 0;
  for (const citation of citations) {
    const candidates = resultsById.get(citation.citationId) ?? [];
    if (candidates.length === 0) {
      violation(
        violations,
        "citation_audit_result_missing",
        `The citation-audit result omits ${citation.citationId} from ${citation.documentPath}.`
      );
      continue;
    }
    if (candidates.length > 1) {
      violation(
        violations,
        "citation_audit_result_duplicate",
        `The citation-audit result covers ${citation.citationId} more than once.`
      );
      continue;
    }
    const result = candidates[0];
    audited += 1;
    const counters = pageCounters.get(citation.documentPath);
    counters.audited += 1;
    if (result.verdict === "supported") {
      supported += 1;
      counters.supported += 1;
      if (result.correction !== null) {
        violation(
          violations,
          "supported_citation_has_correction",
          `Supported citation ${citation.citationId} unexpectedly carries a correction.`
        );
      }
    } else if (result.verdict === "unsupported") {
      unsupported += 1;
      counters.unsupported += 1;
      violation(
        violations,
        "unsupported_public_citation",
        `Source-aware audit rejected public citation ${citation.citationId} in ${citation.documentPath}.`
      );
    } else {
      violation(
        violations,
        "invalid_citation_audit_verdict",
        `Citation ${citation.citationId} has invalid audit verdict ${String(result.verdict)}.`
      );
    }
    if (typeof result.rationale !== "string" || !result.rationale.trim()) {
      violation(
        violations,
        "missing_citation_audit_rationale",
        `Citation ${citation.citationId} has no source-aware audit rationale.`
      );
    }
  }
  for (const [citationId] of resultsById) {
    if (!currentCitationIds.has(citationId)) {
      violation(
        violations,
        "citation_audit_result_stale",
        `The citation-audit result contains stale or invented citation ${citationId}.`
      );
    }
  }

  const auditOutputDigest = sha256(artifacts.result.raw);
  const checkpointCitationIds = Array.isArray(checkpoint.citationIds)
    ? checkpoint.citationIds.filter((value) => typeof value === "string")
    : [];
  if (
    checkpoint.version !== 1 ||
    checkpoint.stage !== "citation-audit" ||
    checkpoint.inputDigest !== declaredInputDigest ||
    checkpoint.publicSnapshotDigest !== currentSnapshotDigest
  ) {
    violation(
      violations,
      "citation_audit_checkpoint_binding_mismatch",
      "The citation-audit checkpoint does not bind the current input and exact public snapshot."
    );
  }
  validateAuditRepositoryCheckpoint(checkpoint, current.plan, "checkpoint", violations);
  if (checkpoint.outputDigest !== auditOutputDigest) {
    violation(
      violations,
      "citation_audit_output_digest_mismatch",
      "The citation-audit checkpoint output digest does not bind the exact persisted result bytes."
    );
  }
  if (
    checkpointCitationIds.length !== citationIds.length ||
    duplicates(checkpointCitationIds).size > 0 ||
    checkpointCitationIds.some((citationId, index) => citationId !== citationIds[index])
  ) {
    violation(
      violations,
      "citation_audit_checkpoint_coverage_mismatch",
      "The citation-audit checkpoint citation catalog is not the exact ordered current public citation catalog."
    );
  }

  if (certification.citationAuditDigest !== auditOutputDigest) {
    violation(
      violations,
      "certification_citation_audit_digest_mismatch",
      "The final critic certification does not bind the exact persisted citation-audit result bytes."
    );
  }
  if (certification.snapshotDigest !== currentCriticSnapshotDigest) {
    violation(
      violations,
      "certification_public_snapshot_mismatch",
      "The final critic certification does not bind the current exact public Markdown snapshot."
    );
  }

  return citationAuditMetrics({
    retainedRun: current.retainedRun,
    privateArtifactsPresent,
    available: true,
    citations,
    pageCounters,
    currentSnapshotDigest,
    inputBound,
    audited,
    supported,
    unsupported
  });
}

function citationAuditMetrics({
  retainedRun,
  privateArtifactsPresent,
  available,
  citations,
  pageCounters,
  currentSnapshotDigest,
  inputBound,
  audited,
  supported,
  unsupported
}) {
  return {
    applicable: true,
    retainedRun,
    privateArtifactsPresent,
    privateArtifactsParsed: available,
    parityCapable: available,
    currentPublicSnapshotDigest: currentSnapshotDigest,
    totalCitations: citations.length,
    stableCitationIds: citations.filter((citation) => CITATION_ID_PATTERN.test(citation.citationId)).length,
    inputBoundCitations: inputBound,
    auditedCitations: audited,
    supportedCitations: supported,
    unsupportedCitations: unsupported,
    inputCoverage: ratio(inputBound, citations.length),
    auditCoverage: ratio(audited, citations.length),
    supportedCoverage: ratio(supported, citations.length),
    perPageCoverage: [...pageCounters.values()]
      .map((page) => ({
        ...page,
        inputCoverage: ratio(page.inputBound, page.total),
        auditCoverage: ratio(page.audited, page.total),
        supportedCoverage: ratio(page.supported, page.total)
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    note: available
      ? "Metrics expose coverage and digests only; private orchestration artifacts are not copied into public context."
      : "A public output folder can be inspected, but parity fails without its sibling retained derive-state audit artifacts."
  };
}

function publicContextSnapshot(current) {
  const bodyByPath = new Map(
    current.documents.map((document) => [normalizeRelativePath(document.relativePath), document.bodyMarkdown])
  );
  const pages = [];
  for (const item of current.plan.items ?? []) {
    const relativePath = normalizeRelativePath(item.path ?? "");
    const body = bodyByPath.get(relativePath) ?? "";
    if (!body.trim()) continue;
    pages.push(`===== PAGE ${item.id} (${item.path}) =====\n${body.trim()}`);
  }
  return pages.join("\n\n");
}

function publicDocumentSnapshot(current) {
  return [...current.documents]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((document) => `===== DOCUMENT ${document.relativePath} =====\n${document.bodyMarkdown}`)
    .join("\n\n");
}

function validateAuditRepositoryCheckpoint(value, plan, label, violations) {
  const checkpoint = recordOrUndefined(value);
  if (
    !checkpoint ||
    checkpoint.repository !== plan.repository ||
    checkpoint.ref !== plan.ref ||
    checkpoint.commitSha !== plan.commitSha
  ) {
    violation(
      violations,
      "citation_audit_repository_checkpoint_mismatch",
      `The citation-audit ${label} does not bind the plan repository, ref, and commit.`
    );
  }
}

function citationReferenceMatches(reference, citation) {
  if (
    reference.documentPath !== citation.documentPath ||
    reference.label !== citation.claim ||
    reference.claimSpan !== citation.claimSpan ||
    reference.target !== citation.target ||
    typeof reference.sourceId !== "string" ||
    !reference.sourceId ||
    !SHA256_PATTERN.test(reference.contentDigest ?? "") ||
    typeof reference.excerpt !== "string" ||
    !reference.excerpt
  ) {
    return false;
  }
  if (citation.providerUrl) {
    const target = normalizedProviderUrl(citation.providerUrl);
    const observed = typeof reference.pathOrUrl === "string" ? normalizedProviderUrl(reference.pathOrUrl) : undefined;
    const commitIdentityMatch =
      reference.sourceType === "commit" &&
      typeof reference.sourceId === "string" &&
      target?.endsWith(`/commit/${reference.sourceId}`);
    return (
      ["commit", "pull_request", "issue", "observation"].includes(reference.sourceType) &&
      Boolean(target) &&
      (observed === target || commitIdentityMatch) &&
      reference.jsonPointer === "" &&
      sha256(reference.excerpt) === reference.contentDigest
    );
  }
  return (
    reference.sourceType === "blob" &&
    reference.pathOrUrl === citation.path &&
    reference.startLine === citation.startLine &&
    reference.endLine === citation.endLine
  );
}

function normalizedProviderUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function groupRecordsByString(values, key) {
  const groups = new Map();
  for (const value of values) {
    const record = recordOrUndefined(value);
    const id = record && typeof record[key] === "string" ? record[key] : "";
    if (!id) continue;
    const group = groups.get(id) ?? [];
    group.push(record);
    groups.set(id, group);
  }
  return groups;
}

function duplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates;
}

function recordOrUndefined(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

export function publicEvidenceCitations(relativePath, source) {
  const documentPath = documentPathFromFile(relativePath);
  return parseMarkdownDocument(documentPath, source).evidenceLinks.map((citation) => {
    if (citation.providerUrl) {
      return {
        citationId: citation.citationId,
        documentPath: relativePath,
        claim: citation.claim,
        claimSpan: citation.claimSpan,
        target: citation.providerUrl,
        providerUrl: citation.providerUrl
      };
    }

    const target = `${citation.path}#L${citation.startLine}${
      citation.endLine === citation.startLine ? "" : `-L${citation.endLine}`
    }`;
    return {
      citationId: citation.citationId,
      documentPath: relativePath,
      claim: citation.claim,
      claimSpan: citation.claimSpan,
      target,
      path: citation.path,
      startLine: citation.startLine,
      endLine: citation.endLine
    };
  });
}

function analyzeMarkdown(relativePath, markdown, relativePaths) {
  const links = markdownLinks(markdown);
  const evidenceCitations = publicEvidenceCitations(relativePath, markdown);
  const materialClaims = parseMarkdownDocument(documentPathFromFile(relativePath), markdown).materialClaims;
  const exactSourceLinks = links.filter((target) => isExactSourceLink(target));
  const overbroadSourceLinks = exactSourceLinks.filter((target) => {
    const range = /#L(\d+)(?:-L(\d+))?$/i.exec(target);
    if (!range) return false;
    const start = Number(range[1]);
    const end = Number(range[2] ?? range[1]);
    return end - start + 1 > 120;
  });
  const exactSourcePaths = exactSourceLinks.map((target) => stripLineAnchor(target));
  const documentLinks = [];
  const resolvedDocumentLinks = [];
  const brokenDocumentLinks = [];
  for (const target of links) {
    if (isExactSourceLink(target) || isExternalLink(target) || target.startsWith("#")) continue;
    const targetPath = target.split("#", 1)[0];
    if (!targetPath.toLowerCase().endsWith(".md")) continue;
    const resolved = normalizeRelativePath(path.posix.join(path.posix.dirname(relativePath), targetPath));
    documentLinks.push(target);
    if (!relativePaths.has(resolved)) brokenDocumentLinks.push(target);
    else resolvedDocumentLinks.push(resolved);
  }
  return {
    relativePath,
    bodyMarkdown: markdown,
    sha256: createHash("sha256").update(markdown).digest("hex"),
    headings: [...markdown.matchAll(/^(#{1,6})[ \t]+(.+?)\s*$/gm)].map((match) => ({
      level: match[1].length,
      title: match[2]
    })),
    exactSourceLinks,
    overbroadSourceLinks,
    exactSourcePaths,
    documentLinks,
    resolvedDocumentLinks,
    brokenDocumentLinks,
    providerLinks: links.filter((target) => isProviderHistoryLink(target)),
    evidenceCitations,
    materialClaims,
    mermaidBlocks: [...markdown.matchAll(/^```mermaid[ \t]*\r?\n[\s\S]*?^```[ \t]*$/gm)].length
  };
}

function markdownLinks(markdown) {
  return [...markdown.matchAll(/(?<!!)\[[^\]]+\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((match) => match[1]);
}

function isExactSourceLink(target) {
  return /#L\d+(?:-L\d+)?$/i.test(target);
}

function stripLineAnchor(target) {
  return target.replace(/#L\d+(?:-L\d+)?$/i, "");
}

function isExternalLink(target) {
  return /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith("//");
}

function isProviderHistoryLink(target) {
  return /^https?:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pull|commit)\/[^/?#]+/i.test(target);
}

function reachableDocuments(root, documentByPath) {
  const reachable = new Set();
  const pending = [root];
  while (pending.length > 0) {
    const relativePath = pending.pop();
    if (!relativePath || reachable.has(relativePath)) continue;
    reachable.add(relativePath);
    const document = documentByPath.get(relativePath);
    if (!document) continue;
    for (const linked of document.resolvedDocumentLinks) {
      if (!reachable.has(linked)) pending.push(linked);
    }
  }
  return reachable;
}

async function listMarkdownFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await listMarkdownFiles(entryPath)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) output.push(entryPath);
  }
  return output.sort();
}

async function isDirectory(candidate) {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(candidate) {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function normalizeRelativePath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 1 : Math.round((numerator / denominator) * 10_000) / 10_000;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function violation(violations, code, message) {
  violations.push({ code, message });
}

async function main() {
  const inputPath = process.argv[2] || process.env.CONTEXT_BENCHMARK_DIR?.trim();
  if (!inputPath) {
    throw new Error("Provide a run or derive-output directory as argv[2] or CONTEXT_BENCHMARK_DIR.");
  }
  const report = await analyzeContextQuality(inputPath, {
    planPath: process.env.CONTEXT_BENCHMARK_PLAN?.trim(),
    previousPath: process.argv[3] || process.env.CONTEXT_BENCHMARK_PREVIOUS_DIR?.trim(),
    previousPlanPath: process.env.CONTEXT_BENCHMARK_PREVIOUS_PLAN?.trim()
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.hardContractPass) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
