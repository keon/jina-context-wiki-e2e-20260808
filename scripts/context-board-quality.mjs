#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA_VERSION = "context-board-quality-v2";
const SHA256 = /^[a-f0-9]{64}$/;
const BUILD_MARKER = `${path.sep}builds${path.sep}`;
const MAX_CITATION_LINES = 120;
const PRIVATE_LINK_PATTERN =
  /(?:^|\/)(?:\.context-plan\.json|\.workers(?:\/.*)?|derive-state(?:\/.*)?|agent-stages(?:\/.*)?|citation-audit(?:-input|-result)?(?:\.[a-z0-9-]+)?\.json|source-challenge-\d+\.json|task-evaluation-\d+\.json|publication-plan\.json|certification\.json|context-draft-\d+\.json)$/i;

let domainPromise;

export async function evaluateBoardContextQuality(input) {
  const artifactRoot = path.resolve(requiredText(input?.artifactRoot, "artifactRoot"));
  const buildId = requiredText(input?.buildId, "buildId");
  const domain = await loadDomain();
  const violations = [];
  const current = await loadBuild(artifactRoot, buildId, domain, violations);
  let previous;
  if (input.previousBuildId) {
    const previousViolations = [];
    previous = await loadBuild(
      artifactRoot,
      requiredText(input.previousBuildId, "previousBuildId"),
      domain,
      previousViolations
    );
    for (const entry of previousViolations) {
      violation(violations, `previous_${entry.code}`, `Previous build ${input.previousBuildId}: ${entry.message}`);
    }
  }

  const metrics = current ? analyzeBuild(current, domain, violations) : emptyMetrics(Boolean(input.previousBuildId));
  if (current && previous) {
    metrics.incrementalFreshness = analyzeIncremental(current, previous, violations);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    result: violations.length === 0 ? "pass" : "fail",
    hardContractPass: violations.length === 0,
    artifactRoot,
    buildId,
    ...(input.previousBuildId ? { previousBuildId: input.previousBuildId } : {}),
    scope: current
      ? {
          buildDirectory: current.relativeBuildDirectory,
          artifactFiles: current.files.size,
          tenantId: current.release?.release.tenantId,
          repository: current.release?.release.repository,
          ref: current.release?.release.ref,
          refSequence: current.release?.release.refSequence,
          commitSha: current.release?.release.commitSha,
          releaseId: current.release?.release.releaseId
        }
      : undefined,
    metrics,
    violations: violations.sort(
      (left, right) => left.code.localeCompare(right.code) || left.message.localeCompare(right.message)
    )
  };
}

async function loadBuild(artifactRoot, buildId, domain, violations) {
  let root;
  try {
    root = await realpath(artifactRoot);
  } catch {
    violation(violations, "artifact_root_missing", `Artifact root does not exist: ${artifactRoot}`);
    return undefined;
  }
  const candidates = await findBuildDirectories(root, encodeURIComponent(buildId));
  if (candidates.length === 0) {
    violation(violations, "build_not_found", `No immutable artifact subtree was found for build ${buildId}.`);
    return undefined;
  }
  if (candidates.length > 1) {
    violation(
      violations,
      "ambiguous_build",
      `Build ${buildId} occurs in ${candidates.length} tenant/repository scopes.`
    );
    return undefined;
  }
  const buildDirectory = candidates[0];
  const files = await readBuildFiles(root, buildDirectory, violations);
  const relativeBuildDirectory = slash(path.relative(root, buildDirectory));
  const expectedSuffix = `/builds/${encodeURIComponent(buildId)}`;
  if (!`/${relativeBuildDirectory}`.endsWith(expectedSuffix)) {
    violation(violations, "invalid_build_scope", "Resolved build directory does not match the requested build ID.");
  }
  const artifacts = classifyArtifacts(files, violations);
  const releaseCandidate = exactlyOne(artifacts.get("context-release"), "context_release", violations);
  let release;
  if (releaseCandidate) {
    try {
      release = domain.parseCertifiedContextReleaseArtifact(releaseCandidate.json);
    } catch (error) {
      violation(violations, "invalid_context_release", errorMessage(error));
    }
  }
  if (release && release.release.buildId !== buildId) {
    violation(
      violations,
      "release_build_mismatch",
      `Release names build ${release.release.buildId}, not requested build ${buildId}.`
    );
  }
  const loaded = {
    artifactRoot: root,
    buildId,
    buildDirectory,
    relativeBuildDirectory,
    files,
    artifacts,
    release,
    domain
  };
  if (release) validateReleaseArtifactRefs(loaded, violations);
  return loaded;
}

function analyzeBuild(build, domain, violations) {
  const release = build.release;
  const publicationPlanFile = artifactFromRef(build, release?.publicationPlanArtifact, "publication plan", violations);
  const certificationFile = artifactFromRef(build, release?.certificationArtifact, "certification", violations);
  const publication = publicationPlanFile?.json;
  const certification = certificationFile?.json;
  const planMetrics = validatePublicationPlan(publication, release, violations);
  const snapshotFile = artifactFromRef(build, publication?.snapshotArtifact, "evidence snapshot", violations);
  const snapshot = snapshotFile?.json;
  validateSnapshot(snapshot, release, violations);

  const sourceChallenges = gateFiles(build, "source-challenge", violations);
  const taskEvaluations = gateFiles(build, "task-evaluation", violations);
  const latestChallenge = sourceChallenges.at(-1);
  const latestEvaluation = taskEvaluations.at(-1);
  validateFinalGates({
    build,
    release,
    publicationPlanFile,
    certificationFile,
    certification,
    latestChallenge,
    latestEvaluation,
    violations
  });

  const publicMetrics = validatePublicPages({
    build,
    release,
    publication,
    snapshot,
    domain,
    violations
  });
  const taskMetrics = validateMaintenanceTasks({
    release,
    publication,
    sourceChallenges,
    latestEvaluation,
    violations
  });
  const auditMetrics = validateCitationAudits({
    build,
    release,
    snapshot,
    certification,
    domain,
    violations
  });
  const pageIndexMetrics = validatePageIndex(build, release, domain, violations);
  const providerMetrics = validateProviderAndHistory({
    release,
    publication,
    snapshot,
    sourceChallenges,
    violations
  });

  return {
    release: {
      present: Boolean(release),
      pageCount: release?.pages.length ?? 0,
      publicSnapshotDigest: release?.publicSnapshotDigest,
      publicationInputDigest: release?.publicationInputDigest
    },
    publicationPlan: planMetrics,
    gates: {
      sourceChallengePasses: sourceChallenges.length,
      taskEvaluationPasses: taskEvaluations.length,
      latestSourceChallengePass: latestChallenge?.pass,
      latestSourceChallengeVerdict: latestChallenge?.json.verdict,
      latestTaskEvaluationPass: latestEvaluation?.pass,
      latestTaskEvaluationVerdict: latestEvaluation?.json.verdict,
      certified: certification?.verdict === "certified"
    },
    publicPages: publicMetrics,
    maintenanceTasks: taskMetrics,
    citationAudits: auditMetrics,
    pageIndex: pageIndexMetrics,
    providerAndHistory: providerMetrics,
    incrementalFreshness: {
      evaluated: false,
      note: "Supply --previous-build to verify an incremental publication frontier."
    }
  };
}

function validatePublicationPlan(publication, release, violations) {
  const plan = record(publication?.plan);
  const pages = Array.isArray(plan?.pages) ? plan.pages.map(record).filter(Boolean) : [];
  if (publication?.version !== 1 || !plan) {
    violation(violations, "invalid_publication_plan", "Publication plan artifact is missing or invalid.");
  }
  if (pages.length === 0) {
    violation(violations, "publication_plan_without_pages", "Publication plan has no public pages.");
  }
  const pageIds = new Set();
  const pagePaths = new Set();
  let maintenanceQuestionCount = 0;
  for (const [index, page] of pages.entries()) {
    const id = text(page.id);
    const documentPath = text(page.path);
    if (!id || pageIds.has(id)) {
      violation(violations, "invalid_plan_page_id", `Publication page ${index} has an empty or duplicate ID.`);
    }
    if (!safePublicPath(documentPath) || pagePaths.has(documentPath)) {
      violation(
        violations,
        "invalid_plan_page_path",
        `Publication page ${id || index} has an unsafe or duplicate path.`
      );
    }
    pageIds.add(id);
    pagePaths.add(documentPath);
    const questions = stringArray(page.maintenanceQuestions);
    maintenanceQuestionCount += questions.length;
    if (questions.length === 0) {
      violation(
        violations,
        "plan_page_without_maintenance_task",
        `Publication page ${id || index} has no maintenance question.`
      );
    }
  }
  if (!pagePaths.has("architecture.md")) {
    violation(violations, "missing_architecture_plan", "Publication plan has no architecture.md root.");
  }
  const releasePaths = new Set(release?.pages.map((page) => page.documentPath) ?? []);
  if (!sameSet(pagePaths, releasePaths)) {
    violation(
      violations,
      "publication_plan_release_mismatch",
      "Published document paths do not exactly match the publication plan."
    );
  }
  return {
    present: Boolean(plan),
    pageCount: pages.length,
    maintenanceQuestionCount,
    architecturePresent: pagePaths.has("architecture.md")
  };
}

function validateSnapshot(snapshot, release, violations) {
  if (!record(snapshot) || !Array.isArray(snapshot.files) || !Array.isArray(snapshot.observations)) {
    violation(violations, "invalid_evidence_snapshot", "Evidence snapshot artifact is missing or incomplete.");
    return;
  }
  for (const field of ["tenantId", "repository", "ref", "commitSha"]) {
    if (snapshot[field] !== release?.release[field]) {
      violation(
        violations,
        "snapshot_release_scope_mismatch",
        `Evidence snapshot ${field} does not match the published release.`
      );
    }
  }
  if (snapshot.refSequence !== release?.release.refSequence) {
    violation(
      violations,
      "snapshot_release_sequence_mismatch",
      "Evidence snapshot refSequence does not match the published release."
    );
  }
}

function validateFinalGates(input) {
  const {
    build,
    release,
    publicationPlanFile,
    certificationFile,
    certification,
    latestChallenge,
    latestEvaluation,
    violations
  } = input;
  if (!record(certification) || certification.version !== 1) {
    violation(violations, "invalid_certification", "Certification artifact is missing or invalid.");
    return;
  }
  if (certification.verdict !== "certified") {
    violation(violations, "release_not_certified", "Final certification verdict is not certified.");
  }
  if (certification.publicSnapshotDigest !== release?.publicSnapshotDigest) {
    violation(
      violations,
      "certification_snapshot_mismatch",
      "Certification does not bind the published public snapshot."
    );
  }
  for (const [field, expected] of [
    ["publicationPlanArtifact", publicationPlanFile],
    ["sourceChallengeArtifact", latestChallenge],
    ["taskEvaluationArtifact", latestEvaluation]
  ]) {
    const referenced = artifactFromRef(build, certification[field], `certification ${field}`, violations);
    const expectedFile = expected?.file ?? expected;
    if (referenced && expectedFile && referenced.relativePath !== expectedFile.relativePath) {
      violation(
        violations,
        "certification_not_latest",
        `Certification ${field} does not reference the latest immutable artifact.`
      );
    }
  }
  if (!certificationFile || !release?.certificationArtifact) return;
  if (certificationFile.relativePath !== relativeKey(build, release.certificationArtifact.key)) {
    violation(
      violations,
      "release_certification_mismatch",
      "Release does not reference the evaluated certification artifact."
    );
  }
  for (const gate of [latestChallenge, latestEvaluation]) {
    if (!gate) continue;
    if (gate.json.verdict !== "pass" || gate.json.blockingGapCount !== 0) {
      violation(
        violations,
        `${gate.kind.replace("-", "_")}_not_passed`,
        `Latest ${gate.kind} gate did not pass with zero blocking gaps.`
      );
    }
    if (gate.json.publicSnapshotDigest !== release?.publicSnapshotDigest) {
      violation(
        violations,
        `${gate.kind.replace("-", "_")}_snapshot_mismatch`,
        `Latest ${gate.kind} gate does not bind the published snapshot.`
      );
    }
    const certifiedPageKeys = new Set(
      (Array.isArray(certification.pageArtifacts) ? certification.pageArtifacts : [])
        .map((artifact) => artifact?.key)
        .filter(Boolean)
    );
    const gatePageKeys = new Set(
      (Array.isArray(gate.json.pageArtifacts) ? gate.json.pageArtifacts : [])
        .map((artifact) => artifact?.key)
        .filter(Boolean)
    );
    if (!sameSet(certifiedPageKeys, gatePageKeys)) {
      violation(
        violations,
        `${gate.kind.replace("-", "_")}_page_manifest_mismatch`,
        `Latest ${gate.kind} gate and certification bind different page artifacts.`
      );
    }
    const gatePlan = artifactFromRef(build, gate.json.publicationPlanArtifact, `${gate.kind} plan`, violations);
    if (gatePlan && publicationPlanFile && gatePlan.relativePath !== publicationPlanFile.relativePath) {
      violation(
        violations,
        `${gate.kind.replace("-", "_")}_plan_mismatch`,
        `Latest ${gate.kind} gate does not bind the published plan.`
      );
    }
  }
}

function validatePublicPages(input) {
  const { release, publication, snapshot, domain, violations } = input;
  const pages = release?.pages ?? [];
  const parsedByPath = new Map();
  let evidenceLinks = 0;
  let materialClaims = 0;
  let citedMaterialClaims = 0;
  let sourcePaths = new Set();
  let contextLinks = 0;
  let brokenLinks = 0;
  let privateLinks = 0;
  for (const page of pages) {
    const document = domain.parseMarkdownDocument(page.documentPath.replace(/\.md$/i, ""), page.bodyMarkdown);
    parsedByPath.set(page.documentPath, document);
    if (document.title !== page.title) {
      violation(violations, "release_page_title_mismatch", `${page.documentPath} title does not match its H1.`);
    }
    const h1Count = (page.bodyMarkdown.match(/^#\s+.+$/gm) ?? []).length;
    if (h1Count !== 1) {
      violation(violations, "invalid_page_h1", `${page.documentPath} must contain exactly one H1.`);
    }
    if (page.bodyMarkdown.includes("<!-- context-page:")) {
      violation(
        violations,
        "internal_marker_in_public_page",
        `${page.documentPath} exposes a private context snapshot marker.`
      );
    }
    for (const target of rawMarkdownTargets(page.bodyMarkdown)) {
      if (PRIVATE_LINK_PATTERN.test(normalizeLinkTarget(target))) {
        privateLinks += 1;
        violation(
          violations,
          "private_artifact_link",
          `${page.documentPath} links to private orchestration artifact ${target}.`
        );
      }
    }
    for (const claim of document.materialClaims) {
      if (claim.classification !== "material") continue;
      materialClaims += 1;
      if (claim.citationIds.length > 0) {
        citedMaterialClaims += 1;
      }
    }
    const groundedSummary = document.materialClaims.some(
      (claim) => claim.summary && claim.classification === "material" && claim.citationIds.length > 0
    );
    if (!groundedSummary) {
      violation(violations, "uncited_summary", `${page.documentPath} has no grounded lead summary.`);
    }
    for (const section of domain.markdownEvidenceSections(page.bodyMarkdown, page.documentPath.replace(/\.md$/i, ""))) {
      if (section.substantiveClaimCount === 0 || section.citationIds.length > 0) continue;
      violation(
        violations,
        "ungrounded_substantive_section",
        `${page.documentPath} has no core evidence binding in section ${section.heading}.`
      );
    }
    const citationByPublicId = new Map(
      page.citations.filter((citation) => citation.citationId).map((citation) => [citation.citationId, citation])
    );
    if (citationByPublicId.size !== page.citations.length) {
      violation(
        violations,
        "unassociated_release_citation",
        `${page.documentPath} has a certified citation without a public citation identity.`
      );
    }
    if (document.evidenceLinks.length === 0) {
      violation(violations, "ungrounded_public_page", `${page.documentPath} has no public evidence links.`);
    }
    if (!document.evidenceLinks.some((link) => link.path)) {
      violation(
        violations,
        "page_without_exact_source_range",
        `${page.documentPath} has no repository path with an exact line range.`
      );
    }
    evidenceLinks += document.evidenceLinks.length;
    for (const link of document.evidenceLinks) {
      const citation = citationByPublicId.get(link.citationId);
      if (!citation) {
        violation(
          violations,
          "public_citation_not_certified",
          `${page.documentPath} citation ${link.citationId} is absent from the release.`
        );
        continue;
      }
      if (citation.claimSpan !== link.claimSpan) {
        violation(
          violations,
          "citation_claim_span_mismatch",
          `${page.documentPath} citation ${link.citationId} does not bind its rendered assertion.`
        );
      }
      validateCitationTarget({ page, link, citation, snapshot, violations });
      if (link.path) sourcePaths.add(link.path);
    }
    for (const citationId of citationByPublicId.keys()) {
      if (!document.evidenceLinks.some((link) => link.citationId === citationId)) {
        violation(
          violations,
          "stale_release_citation",
          `${page.documentPath} release contains citation ${citationId} that is absent from the public Markdown.`
        );
      }
    }
  }

  const pagePaths = new Set(pages.map((page) => page.documentPath));
  const edges = new Map();
  for (const page of pages) {
    const targets = [];
    for (const link of parsedByPath.get(page.documentPath)?.documentLinks ?? []) {
      contextLinks += 1;
      const resolved = resolveDocumentLink(page.documentPath, link.target);
      if (!resolved || !pagePaths.has(resolved)) {
        brokenLinks += 1;
        violation(
          violations,
          "broken_context_link",
          `${page.documentPath} has an unresolved context link: ${link.target}`
        );
      } else {
        targets.push(resolved);
      }
    }
    edges.set(page.documentPath, targets);
  }
  if (!pagePaths.has("architecture.md")) {
    violation(violations, "missing_architecture_page", "Published pages have no architecture.md root.");
  } else {
    const reachable = reachableFrom("architecture.md", edges);
    for (const pagePath of pagePaths) {
      if (!reachable.has(pagePath)) {
        violation(
          violations,
          "unreachable_public_page",
          `${pagePath} is not reachable from architecture.md through public document links.`
        );
      }
    }
  }

  const plannedPaths = new Set(
    (Array.isArray(publication?.plan?.pages) ? publication.plan.pages : [])
      .map((page) => text(page?.path))
      .filter(Boolean)
  );
  if (!sameSet(pagePaths, plannedPaths)) {
    violation(violations, "unplanned_public_page", "Public pages differ from the planned page manifest.");
  }
  return {
    pageCount: pages.length,
    evidenceLinks,
    distinctSourcePaths: sourcePaths.size,
    materialClaims,
    citedMaterialClaims,
    materialClaimCoverage: ratio(citedMaterialClaims, materialClaims),
    contextLinks,
    brokenLinks,
    privateArtifactLinks: privateLinks,
    architectureReachablePages: pagePaths.has("architecture.md") ? reachableFrom("architecture.md", edges).size : 0
  };
}

function validateCitationTarget({ page, link, citation, snapshot, violations }) {
  const anchor = citation.anchor;
  if (link.path) {
    if (
      anchor.sourceType !== "blob" ||
      anchor.pathOrUrl !== link.path ||
      anchor.startLine !== link.startLine ||
      anchor.endLine !== link.endLine
    ) {
      violation(
        violations,
        "citation_source_binding_mismatch",
        `${page.documentPath} citation ${link.citationId} does not bind its exact source target.`
      );
      return;
    }
    const width = link.endLine - link.startLine + 1;
    if (width > MAX_CITATION_LINES) {
      violation(
        violations,
        "overbroad_source_range",
        `${page.documentPath} citation ${link.citationId} spans ${width} lines.`
      );
    }
    const file = snapshot?.files?.find((candidate) => candidate.path === link.path);
    if (!file || file.contentOmitted) {
      violation(
        violations,
        "citation_source_unavailable",
        `${page.documentPath} cites unavailable source ${link.path}.`
      );
      return;
    }
    const lineCount = String(file.body).split(/\r?\n/).length;
    if (link.endLine > lineCount) {
      violation(
        violations,
        "citation_range_out_of_bounds",
        `${page.documentPath} citation ${link.citationId} exceeds ${link.path}.`
      );
    }
    if (
      anchor.sourceId !== file.blobSha ||
      anchor.contentDigest !== sha256(String(file.body)) ||
      anchor.commitSha !== snapshot.commitSha
    ) {
      violation(
        violations,
        "citation_snapshot_mismatch",
        `${page.documentPath} citation ${link.citationId} is not bound to the current source snapshot.`
      );
    }
    return;
  }
  if (link.providerUrl) {
    const matches = (snapshot?.observations ?? []).filter(
      (observation) => normalizedUrl(observation.pathOrUrl) === normalizedUrl(link.providerUrl)
    );
    if (
      matches.length !== 1 ||
      anchor.sourceType !== matches[0]?.sourceType ||
      anchor.sourceId !== matches[0]?.sourceId ||
      normalizedUrl(anchor.pathOrUrl) !== normalizedUrl(link.providerUrl)
    ) {
      violation(
        violations,
        "provider_citation_snapshot_mismatch",
        `${page.documentPath} provider citation ${link.citationId} does not bind one captured observation.`
      );
    }
  }
}

function validateMaintenanceTasks(input) {
  const { release, publication, sourceChallenges, latestEvaluation, violations } = input;
  const pages = Array.isArray(publication?.plan?.pages) ? publication.plan.pages.map(record).filter(Boolean) : [];
  const pageById = new Map(pages.map((page) => [text(page.id), page]));
  const taskById = new Map();
  for (const page of pages) {
    for (const question of stringArray(page.maintenanceQuestions)) {
      const normalized = normalizeQuestion(question);
      const id = `task-${sha256(normalized).slice(0, 20)}`;
      const current = taskById.get(id) ?? { id, question, pageIds: new Set(), requiredAnswerParts: [] };
      current.pageIds.add(text(page.id));
      taskById.set(id, current);
    }
  }
  for (const gate of sourceChallenges) {
    for (const task of Array.isArray(gate.json.result?.addedTasks) ? gate.json.result.addedTasks : []) {
      if (!task?.material) continue;
      const current = taskById.get(task.id) ?? {
        id: task.id,
        question: task.question,
        pageIds: new Set(),
        requiredAnswerParts: stringArray(task.requiredAnswerParts)
      };
      taskById.set(task.id, current);
    }
  }
  if (taskById.size === 0) {
    violation(violations, "no_maintenance_tasks", "Publication has no required maintenance tasks.");
  }
  const result = record(latestEvaluation?.json.result);
  const latestChallenge = sourceChallenges.at(-1);
  const challengeResult = record(latestChallenge?.json.result);
  const acceptedTaskIds = new Set(stringArray(challengeResult?.acceptedTaskIds));
  if (
    challengeResult?.version !== 1 ||
    challengeResult?.publicSnapshotDigest !== release?.publicSnapshotDigest ||
    challengeResult?.worker?.id !== `source-challenge-${latestChallenge?.pass}` ||
    !SHA256.test(String(challengeResult?.inputDigest))
  ) {
    violation(
      violations,
      "invalid_latest_source_challenge",
      "Latest source challenge result is not bound to its pass and published snapshot."
    );
  }
  const materialAddedTasks = Array.isArray(challengeResult?.addedTasks)
    ? challengeResult.addedTasks.filter((task) => task?.material)
    : [];
  const materialOmissions = Array.isArray(challengeResult?.omittedSubjects)
    ? challengeResult.omittedSubjects.filter((subject) => subject?.material)
    : [];
  if (materialAddedTasks.length > 0 || materialOmissions.length > 0) {
    violation(
      violations,
      "latest_source_challenge_has_material_gaps",
      "Latest source challenge still reports material tasks or omitted subjects."
    );
  }
  for (const taskId of taskById.keys()) {
    if (!acceptedTaskIds.has(taskId)) {
      violation(
        violations,
        "source_challenge_omitted_task",
        `Latest source challenge did not accept required maintenance task ${taskId}.`
      );
    }
  }
  for (const taskId of acceptedTaskIds) {
    if (!taskById.has(taskId)) {
      violation(
        violations,
        "source_challenge_invented_task",
        `Latest source challenge accepted unknown maintenance task ${taskId}.`
      );
    }
  }
  const review = record(result?.review);
  const results = Array.isArray(review?.results) ? review.results.map(record).filter(Boolean) : [];
  const attempts = Array.isArray(result?.attempts) ? result.attempts.map(record).filter(Boolean) : [];
  const resultByQuestion = new Map(results.map((entry) => [text(entry.questionId), entry]));
  const attemptByQuestion = new Map(attempts.map((entry) => [text(entry.questionId), entry]));
  const taskCatalog = [...taskById.values()]
    .map((task) => ({
      id: task.id,
      question: task.question,
      priority: "required",
      ...(task.requiredAnswerParts.length > 0 ? { requiredAnswerParts: task.requiredAnswerParts } : {})
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const taskCatalogDigest = sha256(JSON.stringify(taskCatalog, null, 2));
  if (
    result?.snapshotDigest !== release?.publicSnapshotDigest ||
    result?.taskCatalogDigest !== taskCatalogDigest ||
    result?.worker?.id !== `critic-context-${latestEvaluation?.pass}` ||
    review?.workerId !== result?.worker?.id ||
    review?.kind !== "context_only" ||
    review?.status !== "complete" ||
    review?.reviewer !== "subagent"
  ) {
    violation(
      violations,
      "invalid_latest_task_evaluation",
      "Latest task evaluation does not bind the exact task catalog, public snapshot, and context-only critic."
    );
  }
  if (resultByQuestion.size !== results.length) {
    violation(violations, "duplicate_task_result", "Latest task evaluation contains duplicate question results.");
  }
  if (attemptByQuestion.size !== attempts.length) {
    violation(violations, "duplicate_task_attempt", "Latest task evaluation contains duplicate attempts.");
  }
  const usedPageIds = new Set();
  let passedTasks = 0;
  for (const task of taskById.values()) {
    const evaluation = resultByQuestion.get(task.id);
    const attempt = attemptByQuestion.get(task.id);
    if (!evaluation || evaluation.verdict !== "pass") {
      violation(violations, "maintenance_task_not_passed", `Required maintenance task ${task.id} has no latest pass.`);
      continue;
    }
    passedTasks += 1;
    const pageIds = stringArray(evaluation.pageIds);
    if (pageIds.length === 0) {
      violation(
        violations,
        "maintenance_task_without_pages",
        `Passing maintenance task ${task.id} records no pages used.`
      );
    }
    for (const pageId of pageIds) {
      if (!pageById.has(pageId)) {
        violation(
          violations,
          "maintenance_task_unknown_page",
          `Maintenance task ${task.id} used unknown page ${pageId}.`
        );
      }
      usedPageIds.add(pageId);
    }
    if (!attempt) {
      violation(
        violations,
        "maintenance_task_without_attempt",
        `Passing maintenance task ${task.id} has no context-only attempt.`
      );
      continue;
    }
    if (!sameSet(new Set(pageIds), new Set(stringArray(attempt.pageIds)))) {
      violation(
        violations,
        "maintenance_task_attempt_page_mismatch",
        `Maintenance task ${task.id} attempt and result use different pages.`
      );
    }
    for (const field of ["headings", "entrypoints", "changePlan", "verification"]) {
      if (stringArray(attempt[field]).length === 0) {
        violation(
          violations,
          "shallow_maintenance_task_attempt",
          `Passing maintenance task ${task.id} has no ${field}.`
        );
      }
    }
    if (stringArray(attempt.importantSymbols).length === 0 && stringArray(attempt.invariants).length === 0) {
      violation(
        violations,
        "shallow_maintenance_task_attempt",
        `Passing maintenance task ${task.id} has neither important symbols nor invariants.`
      );
    }
    if (stringArray(attempt.blockingUnknowns).length > 0) {
      violation(
        violations,
        "passing_task_has_unknowns",
        `Passing maintenance task ${task.id} still has blocking unknowns.`
      );
    }
    for (const requiredPart of task.requiredAnswerParts) {
      const field = {
        entrypoints: "entrypoints",
        important_symbols: "importantSymbols",
        control_flow: "controlFlow",
        state: "state",
        invariants: "invariants",
        failure_triage: "failureTriage",
        configuration: "configuration",
        verification: "verification"
      }[requiredPart];
      if (field && stringArray(attempt[field]).length === 0) {
        violation(
          violations,
          "challenge_task_answer_incomplete",
          `Passing challenge task ${task.id} has no required ${requiredPart}.`
        );
      }
    }
  }
  for (const questionId of resultByQuestion.keys()) {
    if (!taskById.has(questionId)) {
      violation(
        violations,
        "invented_maintenance_task_result",
        `Latest task evaluation contains unknown question ${questionId}.`
      );
    }
  }
  for (const [pageId, page] of pageById) {
    if (!usedPageIds.has(pageId)) {
      violation(
        violations,
        "public_page_not_used_by_task",
        `Published page ${text(page.path)} is not used by any latest passing task.`
      );
    }
  }
  return {
    requiredTasks: taskById.size,
    passedTasks,
    latestPassRate: ratio(passedTasks, taskById.size),
    pagesUsedByPassingTasks: usedPageIds.size,
    publishedPages: release?.pages.length ?? 0,
    pageUsageCoverage: ratio(usedPageIds.size, release?.pages.length ?? 0)
  };
}

function validateCitationAudits(input) {
  const { build, release, snapshot, certification, domain, violations } = input;
  const certifiedRefs = Array.isArray(certification?.pageArtifacts) ? certification.pageArtifacts : [];
  const certifiedFiles = certifiedRefs
    .map((ref, index) => artifactFromRef(build, ref, `certification page ${index}`, violations))
    .filter(Boolean);
  const uniqueFiles = [...new Map(certifiedFiles.map((file) => [file.relativePath, file])).values()];
  const draftFiles = uniqueFiles.filter((file) => file.kind === "context-draft");
  if (draftFiles.length > 0) {
    if (draftFiles.length !== 1 || uniqueFiles.length !== 1) {
      violation(
        violations,
        "ambiguous_certified_draft",
        "Certification mixes a repaired draft with other page artifact identities."
      );
    }
    return validateDraftAudit(draftFiles[0], release, snapshot, domain, violations);
  }

  const pageFiles = uniqueFiles.filter((file) => file.kind === "context-page");
  const audits = build.artifacts.get("citation-audit") ?? [];
  let supported = 0;
  let total = 0;
  for (const pageFile of pageFiles) {
    const page = pageFile.json;
    const publishedPage = release?.pages.find((candidate) => candidate.documentPath === page.documentPath);
    if (!publishedPage || publishedPage.title !== page.title || publishedPage.bodyMarkdown !== page.bodyMarkdown) {
      violation(
        violations,
        "certified_page_release_mismatch",
        `Certified page artifact ${page.documentPath ?? pageFile.relativePath} does not match the published bytes.`
      );
    }
    const expected = pageAuditInventory(page.documentPath, page.bodyMarkdown, snapshot, domain);
    total += expected.references.length;
    const matching = audits.filter((auditFile) => auditFile.json?.pageArtifact?.key === keyFor(build, pageFile));
    if (matching.length !== 1) {
      violation(
        violations,
        "missing_final_page_audit",
        `Certified page ${page.documentPath} has ${matching.length} matching citation audits.`
      );
      continue;
    }
    const auditArtifact = matching[0].json;
    artifactFromRef(build, auditArtifact.snapshotArtifact, `${page.documentPath} audit snapshot`, violations);
    const publicSnapshotDigest = sha256(`${page.documentPath}\0${page.bodyMarkdown}`);
    const inputPayload = {
      version: 1,
      checkpoint: {
        repository: snapshot?.repository,
        ref: snapshot?.ref,
        commitSha: snapshot?.commitSha
      },
      publicSnapshotDigest,
      references: expected.references,
      structuralProblems: expected.structuralProblems
    };
    const inputDigest = sha256(JSON.stringify(inputPayload));
    if (
      auditArtifact.publicSnapshotDigest !== publicSnapshotDigest ||
      auditArtifact.inputDigest !== inputDigest ||
      JSON.stringify(auditArtifact.references) !== JSON.stringify(expected.references)
    ) {
      violation(
        violations,
        "page_audit_input_mismatch",
        `Citation audit for ${page.documentPath} does not bind the current page and source snapshot.`
      );
    }
    if (
      expected.structuralProblems.length > 0 ||
      !Array.isArray(auditArtifact.structuralProblems) ||
      auditArtifact.structuralProblems.length > 0
    ) {
      violation(
        violations,
        "page_audit_structural_failure",
        `Citation audit for ${page.documentPath} contains structural citation failures.`
      );
    }
    const results = Array.isArray(auditArtifact.audit?.results) ? auditArtifact.audit.results : [];
    const expectedIds = new Set(expected.references.map((reference) => reference.citationId));
    const actualIds = new Set(results.map((result) => result?.citationId));
    if (
      auditArtifact.audit?.inputDigest !== inputDigest ||
      auditArtifact.audit?.publicSnapshotDigest !== publicSnapshotDigest ||
      !text(auditArtifact.audit?.worker?.id).startsWith("citation-audit") ||
      !sameSet(expectedIds, actualIds) ||
      results.length !== expectedIds.size
    ) {
      violation(
        violations,
        "page_audit_result_mismatch",
        `Citation audit result for ${page.documentPath} does not cover the exact current citations.`
      );
    }
    const supportedResults = results.filter((result) => result?.verdict === "supported").length;
    supported += supportedResults;
    if (supportedResults !== results.length) {
      violation(
        violations,
        "unsupported_public_citation",
        `Citation audit for ${page.documentPath} contains unsupported citations.`
      );
    }
  }
  if (pageFiles.length !== release?.pages.length) {
    violation(
      violations,
      "certified_page_manifest_mismatch",
      "Certification page artifact manifest does not represent every published page."
    );
  }
  return {
    mode: "per-page",
    auditedPages: pageFiles.length,
    totalCitations: total,
    supportedCitations: supported,
    supportedCoverage: ratio(supported, total)
  };
}

function validateDraftAudit(draftFile, release, snapshot, domain, violations) {
  const draft = draftFile.json;
  const pages = Array.isArray(draft?.pages) ? [...draft.pages] : [];
  pages.sort((left, right) => String(left.documentPath).localeCompare(String(right.documentPath)));
  const releasePages = [...(release?.pages ?? [])].sort((left, right) =>
    left.documentPath.localeCompare(right.documentPath)
  );
  if (
    pages.length !== releasePages.length ||
    pages.some(
      (page, index) =>
        page.documentPath !== releasePages[index]?.documentPath ||
        page.bodyMarkdown !== releasePages[index]?.bodyMarkdown
    )
  ) {
    violation(
      violations,
      "certified_draft_release_mismatch",
      "Certified repaired draft does not contain the exact published pages."
    );
  }
  const references = pages.flatMap(
    (page) => pageAuditInventory(page.documentPath, page.bodyMarkdown, snapshot, domain).references
  );
  const structuralProblems = pages.flatMap(
    (page) => pageAuditInventory(page.documentPath, page.bodyMarkdown, snapshot, domain).structuralProblems
  );
  if (structuralProblems.length > 0) {
    violation(
      violations,
      "draft_audit_structural_failure",
      `Certified repaired draft has ${structuralProblems.length} structural citation failures.`
    );
  }
  const publicSnapshotDigest = release?.publicSnapshotDigest;
  const inputPayload = {
    version: 1,
    checkpoint: {
      repository: snapshot?.repository,
      ref: snapshot?.ref,
      commitSha: snapshot?.commitSha
    },
    publicSnapshotDigest,
    references
  };
  const inputDigest = sha256(JSON.stringify(inputPayload));
  const result = draft?.citationAudit;
  const results = Array.isArray(result?.results) ? result.results : [];
  if (
    draft?.citationAuditInput?.inputDigest !== inputDigest ||
    draft?.citationAuditInput?.publicSnapshotDigest !== publicSnapshotDigest ||
    JSON.stringify(draft?.citationAuditInput?.references) !== JSON.stringify(references) ||
    result?.inputDigest !== inputDigest ||
    result?.publicSnapshotDigest !== publicSnapshotDigest ||
    draft?.citationAuditDigest !== sha256(JSON.stringify(result))
  ) {
    violation(
      violations,
      "draft_citation_audit_mismatch",
      "Certified repaired draft citation audit does not bind the current pages and evidence."
    );
  }
  const expectedIds = new Set(references.map((reference) => reference.citationId));
  const actualIds = new Set(results.map((entry) => entry?.citationId));
  const supported = results.filter((entry) => entry?.verdict === "supported").length;
  if (!sameSet(expectedIds, actualIds) || results.length !== expectedIds.size || supported !== results.length) {
    violation(
      violations,
      "unsupported_public_citation",
      "Certified repaired draft does not have one supported audit result per current citation."
    );
  }
  return {
    mode: "combined-draft",
    auditedPages: pages.length,
    totalCitations: references.length,
    supportedCitations: supported,
    supportedCoverage: ratio(supported, references.length)
  };
}

function validatePageIndex(build, release, domain, violations) {
  const file = exactlyOne(build.artifacts.get("pageindex-tree"), "pageindex_tree", violations);
  const tree = file?.json;
  if (!record(tree) || tree.version !== 1) {
    violation(violations, "invalid_pageindex_tree", "PageIndex tree artifact is missing or invalid.");
    return {
      present: false,
      documentCount: 0,
      nodeCount: 0,
      sourcePinned: false
    };
  }
  const expectedSource = {
    adapterName: domain.PAGEINDEX_OSS_ADAPTER_NAME,
    adapterVersion: domain.PAGEINDEX_OSS_SOURCE_PIN,
    sourcePin: domain.PAGEINDEX_OSS_SOURCE_PIN,
    sourceDigest: domain.PAGEINDEX_OSS_SOURCE_DIGEST
  };
  const sourcePinned = Object.entries(expectedSource).every(([key, value]) => tree.source?.[key] === value);
  if (!sourcePinned) {
    violation(
      violations,
      "pageindex_source_not_pinned",
      "PageIndex tree does not attest the configured open-source source pin and digest."
    );
  }
  for (const field of [
    "releaseId",
    "tenantId",
    "repository",
    "ref",
    "refSequence",
    "commitSha",
    "checkpointId",
    "buildId",
    "publishedAt"
  ]) {
    if (tree.release?.[field] !== release?.release[field]) {
      violation(
        violations,
        "pageindex_release_mismatch",
        `PageIndex release ${field} does not match the published release.`
      );
    }
  }
  if (
    tree.release?.publicSnapshotDigest !== release?.publicSnapshotDigest ||
    tree.release?.publicationInputDigest !== release?.publicationInputDigest
  ) {
    violation(
      violations,
      "pageindex_release_digest_mismatch",
      "PageIndex tree does not bind the published snapshot and publication digest."
    );
  }
  const nodes = Array.isArray(tree.nodes) ? tree.nodes.map(record).filter(Boolean) : [];
  const represented = Array.isArray(tree.representedDocuments)
    ? tree.representedDocuments.map(record).filter(Boolean)
    : [];
  const pageByRevision = new Map((release?.pages ?? []).map((page) => [page.revisionId, page]));
  if (nodes.length === 0) violation(violations, "empty_pageindex_tree", "PageIndex tree contains no nodes.");
  if (represented.length !== pageByRevision.size) {
    violation(
      violations,
      "pageindex_incomplete_documents",
      "PageIndex represented-document manifest does not cover every release page."
    );
  }
  const nodeIds = new Set();
  for (const node of nodes) {
    if (!text(node.externalId) || nodeIds.has(node.externalId)) {
      violation(violations, "invalid_pageindex_node_id", "PageIndex contains an empty or duplicate node ID.");
    }
    nodeIds.add(node.externalId);
    const page = pageByRevision.get(node.documentId);
    if (!page) {
      violation(
        violations,
        "pageindex_unknown_document",
        `PageIndex node ${node.externalId} references an unknown document.`
      );
      continue;
    }
    const allowedAnchors = new Set(page.citations.map((citation) => domain.fingerprint(citation.anchor)));
    const nodeAnchors = Array.isArray(node.anchors) ? node.anchors : [];
    if (nodeAnchors.length === 0 || !sameSet(new Set(nodeAnchors.map(domain.fingerprint)), allowedAnchors)) {
      violation(
        violations,
        "pageindex_anchor_mismatch",
        `PageIndex node ${node.externalId} does not carry the exact certified document anchors.`
      );
    }
  }
  for (const page of release?.pages ?? []) {
    const documentNodes = nodes
      .filter((node) => node.documentId === page.revisionId)
      .sort((left, right) => left.preorderStart - right.preorderStart);
    const manifest = represented.find((entry) => entry.documentId === page.revisionId);
    const rootCount = documentNodes.filter((node) => node.parentExternalId === undefined).length;
    const maxDepth = documentNodes.length ? Math.max(...documentNodes.map((node) => Number(node.depth) || 0)) : 0;
    if (
      !manifest ||
      manifest.documentPath !== page.documentPath ||
      manifest.title !== page.title ||
      manifest.nodeCount !== documentNodes.length ||
      manifest.rootCount !== rootCount ||
      manifest.maxDepth !== maxDepth
    ) {
      violation(
        violations,
        "pageindex_document_manifest_mismatch",
        `PageIndex manifest for ${page.documentPath} is missing or inconsistent.`
      );
    }
    validateDocumentTree(page.documentPath, documentNodes, violations);
  }
  const normalizedNodes = normalizeTreeNodes(nodes, release?.pages ?? [], domain);
  const treeDigest = domain.fingerprint(normalizedNodes);
  const buildDigest = domain.fingerprint({
    version: 1,
    releaseId: release?.release.releaseId,
    publicSnapshotDigest: release?.publicSnapshotDigest,
    inputDigest: tree.metrics?.inputDigest,
    treeDigest,
    adapterName: domain.PAGEINDEX_OSS_ADAPTER_NAME,
    adapterVersion: domain.PAGEINDEX_OSS_SOURCE_PIN,
    sourcePin: domain.PAGEINDEX_OSS_SOURCE_PIN,
    sourceDigest: domain.PAGEINDEX_OSS_SOURCE_DIGEST
  });
  if (tree.metrics?.treeDigest !== treeDigest || tree.metrics?.buildDigest !== buildDigest) {
    violation(
      violations,
      "pageindex_digest_mismatch",
      "PageIndex tree or build digest does not bind the persisted normalized nodes."
    );
  }
  const roots = nodes.filter((node) => node.parentExternalId === undefined).length;
  const maxDepth = nodes.length ? Math.max(...nodes.map((node) => Number(node.depth) || 0)) : 0;
  if (
    tree.metrics?.documentCount !== (release?.pages.length ?? 0) ||
    tree.metrics?.representedDocumentCount !== represented.length ||
    tree.metrics?.nodeCount !== nodes.length ||
    tree.metrics?.rootCount !== roots ||
    tree.metrics?.maxDepth !== maxDepth ||
    tree.metrics?.documentCharacters !==
      (release?.pages ?? []).reduce((total, page) => total + page.bodyMarkdown.length, 0)
  ) {
    violation(
      violations,
      "pageindex_metrics_mismatch",
      "PageIndex metrics do not match the persisted release and tree."
    );
  }
  return {
    present: true,
    documentCount: represented.length,
    nodeCount: nodes.length,
    rootCount: roots,
    maxDepth,
    sourcePinned
  };
}

function validateDocumentTree(documentPath, nodes, violations) {
  if (nodes.length === 0) {
    violation(violations, "pageindex_document_missing", `PageIndex omitted ${documentPath}.`);
    return;
  }
  const byId = new Map(nodes.map((node) => [node.externalId, node]));
  const starts = nodes.map((node) => node.preorderStart).sort((left, right) => left - right);
  if (starts.some((start, index) => start !== index + 1)) {
    violation(
      violations,
      "pageindex_preorder_not_contiguous",
      `PageIndex preorder for ${documentPath} is not contiguous.`
    );
  }
  for (const node of nodes) {
    if (
      !Number.isSafeInteger(node.depth) ||
      node.depth < 1 ||
      !Number.isSafeInteger(node.preorderStart) ||
      node.preorderStart < 1 ||
      !Number.isSafeInteger(node.preorderEnd) ||
      node.preorderEnd < node.preorderStart
    ) {
      violation(violations, "invalid_pageindex_node", `PageIndex node in ${documentPath} is malformed.`);
      continue;
    }
    if (node.parentExternalId === undefined) {
      if (node.depth !== 1) {
        violation(
          violations,
          "invalid_pageindex_root_depth",
          `PageIndex root ${node.externalId} in ${documentPath} is not depth 1.`
        );
      }
      continue;
    }
    const parent = byId.get(node.parentExternalId);
    if (
      !parent ||
      node.depth !== parent.depth + 1 ||
      node.preorderStart <= parent.preorderStart ||
      node.preorderEnd > parent.preorderEnd
    ) {
      violation(
        violations,
        "invalid_pageindex_parent",
        `PageIndex parent interval for ${node.externalId} in ${documentPath} is invalid.`
      );
    }
  }
  const activeAncestors = [];
  for (const node of nodes) {
    while (activeAncestors.length > 0 && node.preorderStart > activeAncestors.at(-1).preorderEnd) {
      activeAncestors.pop();
    }
    const expectedParent = activeAncestors.at(-1);
    if (
      (expectedParent === undefined && node.parentExternalId !== undefined) ||
      (expectedParent !== undefined && node.parentExternalId !== expectedParent.externalId)
    ) {
      violation(
        violations,
        "pageindex_preorder_parent_mismatch",
        `PageIndex preorder and parent graph differ for ${node.externalId} in ${documentPath}.`
      );
    }
    const descendantStarts = nodes
      .filter(
        (candidate) => candidate.preorderStart >= node.preorderStart && candidate.preorderStart <= node.preorderEnd
      )
      .map((candidate) => candidate.preorderStart);
    if (node.preorderEnd !== Math.max(...descendantStarts)) {
      violation(
        violations,
        "pageindex_preorder_interval_mismatch",
        `PageIndex interval for ${node.externalId} in ${documentPath} is not exact.`
      );
    }
    activeAncestors.push(node);
  }
}

function normalizeTreeNodes(nodes, pages, domain) {
  const order = new Map(pages.map((page, index) => [page.revisionId, index]));
  return nodes
    .map((node) => ({
      externalId: node.externalId,
      documentId: node.documentId,
      ...(node.parentExternalId === undefined ? {} : { parentExternalId: node.parentExternalId }),
      title: node.title,
      summary: node.summary,
      depth: node.depth,
      preorderStart: node.preorderStart,
      preorderEnd: node.preorderEnd,
      anchors: [...(node.anchors ?? [])].sort((left, right) =>
        domain.fingerprint(left).localeCompare(domain.fingerprint(right))
      )
    }))
    .sort(
      (left, right) =>
        (order.get(left.documentId) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right.documentId) ?? Number.MAX_SAFE_INTEGER) ||
        left.preorderStart - right.preorderStart ||
        String(left.externalId).localeCompare(String(right.externalId))
    );
}

function validateProviderAndHistory(input) {
  const { release, publication, snapshot, sourceChallenges, violations } = input;
  const observations = Array.isArray(snapshot?.observations) ? snapshot.observations : [];
  const providerSignals = observations.filter((observation) =>
    ["pull_request", "issue"].includes(observation.sourceType)
  );
  const historyCommits = Array.isArray(snapshot?.git?.history) ? snapshot.git.history : [];
  const planText = JSON.stringify(publication?.plan ?? {}).toLowerCase();
  const challengeEvidence = sourceChallenges.flatMap((gate) => [
    ...(Array.isArray(gate.json.result?.addedTasks) ? gate.json.result.addedTasks : []),
    ...(Array.isArray(gate.json.result?.omittedSubjects) ? gate.json.result.omittedSubjects : [])
  ]);
  const challengeHistoryApplicable = challengeEvidence.some((entry) => {
    if (!entry?.material) return false;
    if (entry.subjectKind === "history" || entry.intent === "explain_decision") return true;
    return (entry.evidence ?? []).some((evidence) =>
      ["commit", "pull_request", "issue", "observation"].includes(evidence?.source)
    );
  });
  const planHistoryApplicable =
    /\b(history|historical|decision|migration|incident|regression|issue|pull request|commit)\b/.test(planText);
  const applicable = challengeHistoryApplicable || planHistoryApplicable;
  const providerCitations = (release?.pages ?? [])
    .flatMap((page) => page.citations)
    .filter((citation) => ["commit", "pull_request", "issue", "observation"].includes(citation.anchor.sourceType));
  if (applicable && providerCitations.length === 0) {
    violation(
      violations,
      "missing_applicable_provider_history",
      "Plan or source challenge makes provider/history evidence material, but no public page cites it."
    );
  }
  return {
    applicable,
    capturedPullRequestsAndIssues: providerSignals.length,
    capturedHistoryCommits: historyCommits.length,
    publicProviderHistoryCitations: providerCitations.length,
    covered: !applicable || providerCitations.length > 0
  };
}

function analyzeIncremental(current, previous, violations) {
  const currentRelease = current.release;
  const previousRelease = previous.release;
  if (!currentRelease || !previousRelease) {
    violation(
      violations,
      "incremental_release_missing",
      "Both current and previous builds need valid certified releases."
    );
    return { evaluated: true, frontierAdvanced: false };
  }
  if (
    currentRelease.release.tenantId !== previousRelease.release.tenantId ||
    currentRelease.release.repository !== previousRelease.release.repository ||
    currentRelease.release.ref !== previousRelease.release.ref
  ) {
    violation(
      violations,
      "incremental_scope_mismatch",
      "Current and previous builds are not from the same tenant/repository/ref."
    );
  }
  if (currentRelease.release.refSequence <= previousRelease.release.refSequence) {
    violation(
      violations,
      "incremental_sequence_not_advanced",
      "Current build refSequence did not advance beyond the previous build."
    );
  }
  if (currentRelease.release.buildId === previousRelease.release.buildId) {
    violation(violations, "incremental_build_reused", "Incremental comparison reused the same build ID.");
  }
  const currentSnapshot = snapshotFor(current, violations, "current");
  const previousSnapshot = snapshotFor(previous, violations, "previous");
  const commitAdvanced = currentRelease.release.commitSha !== previousRelease.release.commitSha;
  const providerFrontierAdvanced =
    currentSnapshot &&
    previousSnapshot &&
    (currentSnapshot.observationFrontier !== previousSnapshot.observationFrontier ||
      observationIdentity(currentSnapshot) !== observationIdentity(previousSnapshot));
  const frontierAdvanced = Boolean(commitAdvanced || providerFrontierAdvanced);
  if (!frontierAdvanced) {
    violation(
      violations,
      "incremental_frontier_not_advanced",
      "Neither commit nor captured provider frontier advanced."
    );
  }
  const previousBodies = new Map(previousRelease.pages.map((page) => [page.documentPath, page.bodySha256]));
  const currentBodies = new Map(currentRelease.pages.map((page) => [page.documentPath, page.bodySha256]));
  const added = [...currentBodies.keys()].filter((documentPath) => !previousBodies.has(documentPath)).sort();
  const removed = [...previousBodies.keys()].filter((documentPath) => !currentBodies.has(documentPath)).sort();
  const changed = [...currentBodies.entries()]
    .filter(([documentPath, digest]) => previousBodies.has(documentPath) && previousBodies.get(documentPath) !== digest)
    .map(([documentPath]) => documentPath)
    .sort();
  const unchanged = [...currentBodies.entries()]
    .filter(([documentPath, digest]) => previousBodies.has(documentPath) && previousBodies.get(documentPath) === digest)
    .map(([documentPath]) => documentPath)
    .sort();
  return {
    evaluated: true,
    previousBuildId: previous.buildId,
    currentBuildId: current.buildId,
    previousRefSequence: previousRelease.release.refSequence,
    currentRefSequence: currentRelease.release.refSequence,
    previousCommitSha: previousRelease.release.commitSha,
    currentCommitSha: currentRelease.release.commitSha,
    commitAdvanced,
    providerFrontierAdvanced: Boolean(providerFrontierAdvanced),
    frontierAdvanced,
    addedDocuments: added,
    removedDocuments: removed,
    changedDocuments: changed,
    unchangedDocuments: unchanged
  };
}

function snapshotFor(build, violations, label) {
  const publication = artifactFromRef(
    build,
    build.release?.publicationPlanArtifact,
    `${label} publication plan`,
    violations
  )?.json;
  return artifactFromRef(build, publication?.snapshotArtifact, `${label} evidence snapshot`, violations)?.json;
}

function pageAuditInventory(documentPath, bodyMarkdown, snapshot, domain) {
  const document = domain.parseMarkdownDocument(documentPath.replace(/\.md$/i, ""), bodyMarkdown);
  const structuralProblems = [];
  const knownIds = new Set(document.evidenceLinks.map((link) => link.citationId));
  const auditableIds = new Set(
    document.materialClaims.filter((claim) => claim.classification === "material").flatMap((claim) => claim.citationIds)
  );
  const groundedSummary = document.materialClaims
    .filter((claim) => claim.summary && claim.classification === "material")
    .flatMap((claim) => claim.citationIds)
    .some((citationId) => knownIds.has(citationId));
  if (!groundedSummary) structuralProblems.push(`ungrounded lead summary in ${documentPath}`);
  for (const section of domain.markdownEvidenceSections(bodyMarkdown, documentPath.replace(/\.md$/i, ""))) {
    if (section.substantiveClaimCount === 0) continue;
    if (section.citationIds.some((citationId) => knownIds.has(citationId))) continue;
    structuralProblems.push(`ungrounded substantive section in ${documentPath}: ${section.heading}`);
  }
  const files = new Map((snapshot?.files ?? []).map((file) => [file.path, file]));
  const observationsByUrl = new Map();
  for (const observation of snapshot?.observations ?? []) {
    const url = normalizedUrl(observation.pathOrUrl);
    if (!url) continue;
    observationsByUrl.set(url, [...(observationsByUrl.get(url) ?? []), observation]);
  }
  const references = [];
  for (const link of document.evidenceLinks) {
    if (!auditableIds.has(link.citationId)) continue;
    if (link.providerUrl) {
      const matches = observationsByUrl.get(normalizedUrl(link.providerUrl)) ?? [];
      if (matches.length !== 1) {
        structuralProblems.push(`provider citation does not bind to exactly one observation: ${link.providerUrl}`);
        continue;
      }
      const observation = matches[0];
      const body = JSON.stringify(observation.payload);
      references.push({
        citationId: link.citationId,
        documentPath,
        label: link.claim,
        claimSpan: link.claimSpan,
        target: link.providerUrl,
        sourceType: observation.sourceType,
        sourceId: observation.sourceId,
        contentDigest: sha256(body),
        ...(observation.pathOrUrl ? { pathOrUrl: observation.pathOrUrl } : {}),
        jsonPointer: "",
        excerpt: body
      });
      continue;
    }
    const file = files.get(link.path);
    if (
      !file ||
      file.contentOmitted ||
      link.startLine < 1 ||
      link.endLine < link.startLine ||
      link.endLine - link.startLine + 1 > MAX_CITATION_LINES
    ) {
      structuralProblems.push(`repository citation is invalid or unavailable: ${link.path}`);
      continue;
    }
    const lines = String(file.body).split(/\r?\n/);
    if (link.endLine > lines.length) {
      structuralProblems.push(`repository citation range exceeds source: ${link.path}#L${link.endLine}`);
      continue;
    }
    references.push({
      citationId: link.citationId,
      documentPath,
      label: link.claim,
      claimSpan: link.claimSpan,
      target: `${link.path}#L${link.startLine}${link.endLine === link.startLine ? "" : `-L${link.endLine}`}`,
      sourceType: "blob",
      sourceId: file.blobSha,
      contentDigest: sha256(String(file.body)),
      pathOrUrl: link.path,
      startLine: link.startLine,
      endLine: link.endLine,
      excerpt: lines.slice(link.startLine - 1, link.endLine).join("\n")
    });
  }
  if (references.length === 0) structuralProblems.push("page has no source-bound public evidence links");
  return { references, structuralProblems };
}

function gateFiles(build, kind, violations) {
  const pattern = new RegExp(`^${kind}-(\\d+)\\.json$`);
  const output = [];
  for (const file of build.artifacts.get("gate-evaluation") ?? []) {
    const match = pattern.exec(path.posix.basename(file.relativePath));
    if (!match) continue;
    if (file.json?.gate !== kind) {
      violation(violations, "gate_filename_payload_mismatch", `${file.relativePath} does not contain a ${kind} gate.`);
      continue;
    }
    output.push({ kind, pass: Number(match[1]), file, json: file.json });
  }
  output.sort((left, right) => left.pass - right.pass);
  if (output.length === 0) {
    violation(violations, `missing_${kind.replace("-", "_")}`, `Build has no ${kind} gate artifacts.`);
  }
  for (let index = 1; index < output.length; index += 1) {
    if (output[index].pass === output[index - 1].pass) {
      violation(violations, "duplicate_gate_pass", `${kind} pass ${output[index].pass} occurs more than once.`);
    }
  }
  return output;
}

function validateReleaseArtifactRefs(build, violations) {
  artifactFromRef(build, build.release.certificationArtifact, "release certification", violations);
  artifactFromRef(build, build.release.publicationPlanArtifact, "release publication plan", violations);
}

function artifactFromRef(build, value, label, violations) {
  const ref = record(value);
  if (!ref) {
    violation(violations, "missing_artifact_reference", `${label} reference is missing.`);
    return undefined;
  }
  const relativePath = relativeKey(build, ref.key);
  if (!relativePath) {
    violation(
      violations,
      "cross_build_artifact_reference",
      `${label} references an artifact outside build ${build.buildId}.`
    );
    return undefined;
  }
  const file = build.files.get(relativePath);
  if (!file) {
    violation(violations, "referenced_artifact_missing", `${label} artifact does not exist: ${ref.key}`);
    return undefined;
  }
  if (ref.bytes !== file.bytes.length || ref.sha256 !== file.sha256 || !SHA256.test(String(ref.sha256))) {
    violation(
      violations,
      "artifact_reference_digest_mismatch",
      `${label} reference does not bind the exact immutable bytes at ${ref.key}.`
    );
  }
  return file;
}

function relativeKey(build, key) {
  if (typeof key !== "string") return undefined;
  const prefix = `${build.relativeBuildDirectory}/`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
}

function keyFor(build, file) {
  return `${build.relativeBuildDirectory}/${file.relativePath}`;
}

function exactlyOne(files, label, violations) {
  const values = files ?? [];
  if (values.length !== 1) {
    violation(
      violations,
      `invalid_${label}_count`,
      `Expected exactly one ${label.replaceAll("_", " ")} artifact; found ${values.length}.`
    );
    return undefined;
  }
  return values[0];
}

function classifyArtifacts(files, violations) {
  const output = new Map();
  for (const file of files.values()) {
    const [kind] = file.relativePath.split("/");
    if (!kind || !file.relativePath.includes("/")) {
      violation(
        violations,
        "artifact_outside_kind_directory",
        `Artifact is not stored under a kind directory: ${file.relativePath}`
      );
      continue;
    }
    file.kind = kind;
    output.set(kind, [...(output.get(kind) ?? []), file]);
  }
  for (const values of output.values()) {
    values.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }
  return output;
}

async function readBuildFiles(root, buildDirectory, violations) {
  const output = new Map();
  const pending = [buildDirectory];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        violation(
          violations,
          "symbolic_link_in_artifact_subtree",
          `Immutable artifact subtree contains a symbolic link: ${slash(path.relative(buildDirectory, absolute))}`
        );
        continue;
      }
      if (info.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!info.isFile()) {
        violation(
          violations,
          "unsupported_artifact_entry",
          `Immutable artifact subtree contains an unsupported entry: ${entry.name}`
        );
        continue;
      }
      const resolved = await realpath(absolute);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        violation(violations, "artifact_escapes_root", `Artifact resolves outside the configured root: ${absolute}`);
        continue;
      }
      const bytes = await readFile(absolute);
      const relativePath = slash(path.relative(buildDirectory, absolute));
      let json;
      try {
        json = JSON.parse(bytes.toString("utf8"));
      } catch {
        violation(violations, "artifact_invalid_json", `${relativePath} is not valid JSON.`);
      }
      output.set(relativePath, {
        absolutePath: absolute,
        relativePath,
        bytes,
        sha256: sha256(bytes),
        json
      });
    }
  }
  if (output.size === 0) {
    violation(violations, "empty_build_subtree", "Build artifact subtree is empty.");
  }
  return output;
}

async function findBuildDirectories(root, encodedBuildId) {
  const output = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.name === encodedBuildId && directory.endsWith(`${path.sep}builds`) && absolute.includes(BUILD_MARKER)) {
        output.push(absolute);
        continue;
      }
      pending.push(absolute);
    }
  }
  return output.sort();
}

function rawMarkdownTargets(markdown) {
  return [...String(markdown).matchAll(/(?<!!)\[[^\]\n]+\]\(\s*<?([^\s)>]+)>?/g)].map((match) => match[1]);
}

function normalizeLinkTarget(target) {
  const withoutFragment = String(target).split("#", 1)[0];
  try {
    return decodeURIComponent(withoutFragment).replaceAll("\\", "/");
  } catch {
    return withoutFragment.replaceAll("\\", "/");
  }
}

function resolveDocumentLink(from, target) {
  const clean = normalizeLinkTarget(target);
  if (!clean.toLowerCase().endsWith(".md") || /^[a-z][a-z\d+.-]*:/i.test(clean)) return undefined;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), clean));
  if (resolved.startsWith("../") || resolved.startsWith("/") || resolved === "..") return undefined;
  return resolved;
}

function reachableFrom(root, edges) {
  const seen = new Set();
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    for (const next of edges.get(current) ?? []) pending.push(next);
  }
  return seen;
}

function observationIdentity(snapshot) {
  return sha256(
    JSON.stringify(
      (snapshot?.observations ?? [])
        .map((observation) => ({
          sourceType: observation.sourceType,
          sourceId: observation.sourceId,
          observedAt: observation.observedAt,
          payload: observation.payload
        }))
        .sort((left, right) =>
          `${left.sourceType}:${left.sourceId}`.localeCompare(`${right.sourceType}:${right.sourceId}`)
        )
    )
  );
}

function safePublicPath(value) {
  return typeof value === "string" && /^(?:[a-z0-9][a-z0-9-]*\/)*[a-z0-9][a-z0-9-]*\.md$/.test(value);
}

function emptyMetrics(incremental) {
  return {
    release: { present: false, pageCount: 0 },
    publicationPlan: { present: false, pageCount: 0, maintenanceQuestionCount: 0 },
    gates: {
      sourceChallengePasses: 0,
      taskEvaluationPasses: 0,
      certified: false
    },
    publicPages: {
      pageCount: 0,
      evidenceLinks: 0,
      materialClaims: 0,
      citedMaterialClaims: 0,
      materialClaimCoverage: 0
    },
    maintenanceTasks: {
      requiredTasks: 0,
      passedTasks: 0,
      latestPassRate: 0,
      pageUsageCoverage: 0
    },
    citationAudits: {
      auditedPages: 0,
      totalCitations: 0,
      supportedCitations: 0,
      supportedCoverage: 0
    },
    pageIndex: { present: false, documentCount: 0, nodeCount: 0, sourcePinned: false },
    providerAndHistory: {
      applicable: false,
      publicProviderHistoryCitations: 0,
      covered: true
    },
    incrementalFreshness: { evaluated: incremental, frontierAdvanced: false }
  };
}

async function loadDomain() {
  domainPromise ??= import("../packages/context-engine/dist/index.js");
  try {
    return await domainPromise;
  } catch (error) {
    throw new Error(
      "Context Engine build output is unavailable. Run `pnpm --filter @jina/context-engine build` first.",
      { cause: error }
    );
  }
}

function normalizeQuestion(value) {
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizedUrl(value) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function ratio(numerator, denominator) {
  if (denominator === 0) return 1;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value : "";
}

function requiredText(value, label) {
  const result = text(value);
  if (!result || result === "." || result === ".." || result.includes("\0")) {
    throw new Error(`${label} is required and must be a safe non-empty value.`);
  }
  return result;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : [];
}

function slash(value) {
  return value.replaceAll(path.sep, "/");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function violation(violations, code, message) {
  violations.push({ code, message });
}

function help() {
  return `Usage:
  node scripts/context-board-quality.mjs --artifact-root PATH --build BUILD_ID [--previous-build BUILD_ID]
  pnpm evaluate:context-board-quality -- --artifact-root PATH --build BUILD_ID [--previous-build BUILD_ID]

Evaluates exactly one immutable local Context Board artifact subtree. The JSON
report is written to stdout; hard quality deficits set exit status 1.

Options:
  --artifact-root PATH       Local Context artifact store root (for example .jina/context-artifacts).
  --build BUILD_ID           Current Board context-build ID.
  --previous-build BUILD_ID  Optional previous build in the same artifact root.
  --help                     Show this help.

Environment equivalents:
  CONTEXT_BOARD_ARTIFACT_ROOT
  CONTEXT_BOARD_BUILD_ID
  CONTEXT_BOARD_PREVIOUS_BUILD_ID
`;
}

function cliArguments(argv) {
  const options = {
    artifactRoot: process.env.CONTEXT_BOARD_ARTIFACT_ROOT?.trim(),
    buildId: process.env.CONTEXT_BOARD_BUILD_ID?.trim(),
    previousBuildId: process.env.CONTEXT_BOARD_PREVIOUS_BUILD_ID?.trim()
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") return { help: true };
    const field = {
      "--artifact-root": "artifactRoot",
      "--build": "buildId",
      "--previous-build": "previousBuildId"
    }[argument];
    if (!field) throw new Error(`Unknown option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    options[field] = value;
    index += 1;
  }
  return options;
}

async function main() {
  const options = cliArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(help());
    return;
  }
  if (!options.artifactRoot || !options.buildId) {
    process.stderr.write(help());
    process.exitCode = 2;
    return;
  }
  const report = await evaluateBoardContextQuality(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.hardContractPass) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
