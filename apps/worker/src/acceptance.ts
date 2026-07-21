import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const TERMINAL_FAILURES = new Set(["blocked", "failed", "canceled", "superseded"]);

export interface ProductionAcceptanceConfig {
  readonly apiUrl: string;
  readonly token: string;
  readonly requestKey: string;
  readonly repository?: string;
  readonly ref?: string;
  readonly principalId?: string;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly expectedIssueNumber?: number;
  readonly expectedResolutionPullRequestNumber?: number;
  /** Enables the complete v5.1 causal fixture contract on omxyz/jina-ontology-e2e. */
  readonly verifyV51Fixture?: boolean;
  readonly causality?: {
    readonly causingCommitSha: string;
    readonly causingPullRequestNumber?: number;
    readonly reasonIncludes?: string;
  };
  readonly log?: (message: string) => void;
}

export interface ProductionAcceptanceSummary {
  readonly taskId: string;
  readonly repository: string;
  readonly commitSha: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly citationCount: number;
}

/**
 * Cloud Run exposes a job's numeric exit code to the deployer, but not the
 * container termination message. Keep these codes coarse and stable so CI can
 * identify the failed acceptance boundary without gaining access to private
 * repository logs.
 */
export function productionAcceptanceExitCode(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/ended as|timed out|missing from the board|retains blocked ontology tasks/.test(message)) return 20;
  if (/latest ontology graph|ontology\.latest/.test(message)) return 21;
  if (message.includes("ontology graph is empty")) return 22;
  if (message.includes("ontology graph contains uncited")) return 23;
  if (/context retrieval|causal context|causality assertion|INTRODUCED_BY|v5\.1/.test(message)) return 24;
  if (message.includes("ontology backlog")) return 25;
  return 26;
}

/** Runs inside Cloud Run so Secret Manager never exposes the service credential to CI. */
export async function runProductionOntologyAcceptance(
  config: ProductionAcceptanceConfig,
  fetchImpl: typeof fetch = fetch
): Promise<ProductionAcceptanceSummary> {
  const apiUrl = config.apiUrl.replace(/\/$/, "");
  const repository = config.repository ?? "omxyz/jina-ontology-e2e";
  const ref = config.ref ?? "main";
  const principalId = config.principalId ?? "user:keon@omlabs.xyz";
  const pollIntervalMs = positiveInteger(config.pollIntervalMs ?? 10_000, "pollIntervalMs");
  // Daytona setup plus the Codex run may legitimately consume the worker's
  // 30-minute execution budget. Keep acceptance outside that envelope so it
  // observes the durable task's terminal state instead of killing itself first.
  const timeoutMs = positiveInteger(config.timeoutMs ?? 35 * 60_000, "timeoutMs");
  const expectedIssueNumber = positiveInteger(config.expectedIssueNumber ?? 1, "expectedIssueNumber");
  const expectedResolutionPullRequestNumber = positiveInteger(
    config.expectedResolutionPullRequestNumber ?? 2,
    "expectedResolutionPullRequestNumber"
  );
  const log = config.log ?? console.log;
  const headers = {
    authorization: `Bearer ${config.token}`,
    "x-jina-principal-id": principalId
  };

  const created = await apiJson(fetchImpl, `${apiUrl}/ontology/build`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ repository, ref, requestKey: config.requestKey })
  });
  const taskId = requiredNestedString(created, "task", "id");
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  let lastTaskSummary = "";
  let completedBoardTasks: unknown[] | undefined;

  while (Date.now() < deadline) {
    const board = await apiJson(fetchImpl, `${apiUrl}/board`, { headers });
    const tasks = requiredArray(board.tasks, "board.tasks");
    const task = tasks.find((value) => isRecord(value) && value.id === taskId);
    if (!isRecord(task)) throw new Error(`acceptance task ${taskId} is missing from the board`);
    const status = requiredString(task.status, "task.status");
    const taskSummary = summarizeWorkflowTasks(tasks, taskId);
    if (taskSummary !== lastTaskSummary) {
      log(`Production ontology task ${taskId}: ${taskSummary}`);
      lastTaskSummary = taskSummary;
    }
    if (status !== lastStatus) {
      lastStatus = status;
    }
    if (status === "done") {
      completedBoardTasks = tasks;
      break;
    }
    if (TERMINAL_FAILURES.has(status)) {
      const failureSummary = await workflowFailureSummary(fetchImpl, apiUrl, headers, tasks, taskId);
      throw new Error(`production ontology task ${taskId} ended as ${status} (${taskSummary}${failureSummary})`);
    }
    await delay(pollIntervalMs);
  }
  if (lastStatus !== "done") {
    const board = await apiJson(fetchImpl, `${apiUrl}/board`, { headers });
    const tasks = requiredArray(board.tasks, "board.tasks");
    const failureSummary = await workflowFailureSummary(fetchImpl, apiUrl, headers, tasks, taskId);
    throw new Error(
      `production ontology task ${taskId} timed out as ${lastStatus || "unknown"} (${lastTaskSummary || "no task details"}${failureSummary})`
    );
  }
  const blockedTaskIds = blockedOntologyTaskIds(completedBoardTasks ?? [], repository, ref);
  if (blockedTaskIds.length > 0) {
    throw new Error(
      `production board retains blocked ontology tasks for ${repository}@${ref}: ${blockedTaskIds.join(", ")}`
    );
  }

  const ontology = await apiJson(fetchImpl, `${apiUrl}/ontology`, { headers });
  let latest = requiredRecord(ontology.latest, "ontology.latest");
  if (latest.repository !== repository || latest.ref !== ref) {
    throw new Error("latest ontology graph does not match the acceptance repository and ref");
  }
  let nodes = requiredArray(latest.nodes, "ontology.latest.nodes");
  let edges = requiredArray(latest.edges, "ontology.latest.edges");
  if (nodes.length === 0 || edges.length === 0) throw new Error("production ontology graph is empty");
  if (![...nodes, ...edges].every(hasEvidence)) throw new Error("production ontology graph contains uncited items");

  const context = await apiJson(fetchImpl, `${apiUrl}/ontology/ask`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      repository,
      ref,
      question: "What changed, why, and who owns the access policy?"
    })
  });
  const calls = requiredArray(context.calls, "context.calls");
  const citations = requiredArray(context.citations, "context.citations");
  if (calls.length < 3 || citations.length === 0 || !calls.every(hasCitedItems)) {
    throw new Error("production context retrieval did not return cited change, intent, and ownership results");
  }
  const issueContext = await apiJson(fetchImpl, `${apiUrl}/ontology/ask`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ repository, ref, question: `Which PR and commit resolved issue #${expectedIssueNumber}?` })
  });
  const issueCalls = requiredArray(issueContext.calls, "issue context.calls");
  const issueTrace = issueCalls.find((call) => isRecord(call) && call.template === "issue_trace");
  const issueItems = isRecord(issueTrace) ? requiredArray(issueTrace.items, "issue trace.items") : [];
  const firstIssueItem = issueItems[0];
  const issueData = isRecord(firstIssueItem) ? requiredRecord(firstIssueItem.data, "issue trace.data") : {};
  const issue = requiredRecord(issueData.issue, "issue trace.issue");
  const expectedIssueTitle = requiredString(issue.title, "issue trace.issue.title");
  const resolutions = requiredArray(issueData.resolutions, "issue trace.resolutions");
  const expectedResolution = resolutions.find(
    (value) => isRecord(value) && value.pullRequestNumber === expectedResolutionPullRequestNumber
  );
  const commits = isRecord(expectedResolution) ? requiredArray(expectedResolution.commits, "issue trace.commits") : [];
  if (
    !isRecord(expectedResolution) ||
    commits.length === 0 ||
    !commits.every((commit) => isRecord(commit) && typeof commit.sha === "string" && commit.sha.length === 40) ||
    !isRecord(firstIssueItem) ||
    !Array.isArray(firstIssueItem.citations) ||
    firstIssueItem.citations.length === 0
  ) {
    throw new Error(
      `production context retrieval did not project issue #${expectedIssueNumber} to PR #${expectedResolutionPullRequestNumber} and its commits`
    );
  }

  if (config.causality) {
    const causingCommitSha = requiredFullGitSha(config.causality.causingCommitSha, "causality.causingCommitSha");
    const assertionResponse = await apiJson(
      fetchImpl,
      `${apiUrl}/ontology/assertions?repository=${encodeURIComponent(repository)}&predicate=INTRODUCED_BY`,
      { headers }
    );
    const assertions = requiredArray(assertionResponse.assertions, "ontology assertions");
    const causalAssertion = assertions.find(
      (value) =>
        isRecord(value) &&
        value.subjectNaturalKey === `github:issue:${repository}#${expectedIssueNumber}` &&
        value.objectNaturalKey === `repo:${repository}:sha:${causingCommitSha}`
    );
    if (!isRecord(causalAssertion)) {
      throw new Error(
        `production causality assertion is missing for issue #${expectedIssueNumber} and commit ${causingCommitSha}`
      );
    }
    if (config.verifyV51Fixture) {
      await reviewFixtureProposals(
        fetchImpl,
        apiUrl,
        headers,
        assertions,
        new Set([requiredString(causalAssertion.id, "causality assertion id")])
      );
    }
    const causalEvidence = requiredArray(causalAssertion.evidence, "causality assertion evidence");
    const causalQualifiers = requiredRecord(causalAssertion.qualifiers, "causality assertion qualifiers");
    const causalReason = requiredString(causalQualifiers.reason, "causality assertion reason");
    if (
      causalEvidence.length === 0 ||
      (config.causality.reasonIncludes &&
        !causalReason.toLowerCase().includes(config.causality.reasonIncludes.toLowerCase()))
    ) {
      throw new Error("production causality assertion is missing its expected reason or evidence");
    }
    if (causalAssertion.status === "proposed") {
      await apiJson(fetchImpl, `${apiUrl}/ontology/commands`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          type: "review_assertion",
          assertionId: requiredString(causalAssertion.id, "causality assertion id"),
          decision: "accept",
          reason: "production fixture causal evidence verified"
        })
      });
    } else if (causalAssertion.status !== "active") {
      throw new Error(`production causality assertion is ${String(causalAssertion.status)}, not reviewable`);
    }

    const questions = [
      `Which PR or commit caused issue #${expectedIssueNumber}, and why?`,
      `Which PR or commit caused "${expectedIssueTitle}", and why?`,
      `Which issue did commit ${causingCommitSha} cause, and why?`,
      ...(config.causality.causingPullRequestNumber
        ? [`Which issue did PR #${config.causality.causingPullRequestNumber} cause, and why?`]
        : [])
    ];
    for (const question of questions) {
      await waitForCausalTrace(fetchImpl, apiUrl, headers, repository, ref, question, {
        issueNumber: expectedIssueNumber,
        causingCommitSha,
        ...(config.causality.causingPullRequestNumber === undefined
          ? {}
          : { causingPullRequestNumber: config.causality.causingPullRequestNumber }),
        ...(config.causality.reasonIncludes === undefined ? {} : { reasonIncludes: config.causality.reasonIncludes }),
        deadline,
        pollIntervalMs
      });
    }
    if (config.causality.causingPullRequestNumber) {
      await verifyCounterfactualAnswer(
        fetchImpl,
        apiUrl,
        headers,
        repository,
        ref,
        `If PR #${config.causality.causingPullRequestNumber} had not merged, would issue #${expectedIssueNumber} exist?`,
        config.verifyV51Fixture === true
      );
      await verifyCounterfactualAnswer(
        fetchImpl,
        apiUrl,
        headers,
        repository,
        ref,
        `If PR #${expectedResolutionPullRequestNumber} had not merged, would issue #${expectedIssueNumber} remain?`,
        config.verifyV51Fixture === true
      );
    }

    await runFollowupOntologyBuild(
      fetchImpl,
      apiUrl,
      headers,
      repository,
      ref,
      `${config.requestKey}:causal`,
      deadline,
      pollIntervalMs,
      log
    );
    const causalOntology = await apiJson(fetchImpl, `${apiUrl}/ontology`, { headers });
    latest = requiredRecord(causalOntology.latest, "causal ontology.latest");
    if (latest.repository !== repository || latest.ref !== ref) {
      throw new Error("latest causal ontology graph does not match the acceptance repository and ref");
    }
    nodes = requiredArray(latest.nodes, "causal ontology.latest.nodes");
    edges = requiredArray(latest.edges, "causal ontology.latest.edges");
    const nodeById = new Map(
      nodes.flatMap((node) => (isRecord(node) && typeof node.id === "string" ? [[node.id, node] as const] : []))
    );
    const causalEdge = edges.find((edge) => {
      if (
        !isRecord(edge) ||
        edge.predicate !== "INTRODUCED_BY" ||
        typeof edge.source !== "string" ||
        typeof edge.target !== "string"
      )
        return false;
      const issueNode = nodeById.get(edge.source);
      const commitNode = nodeById.get(edge.target);
      return (
        issueNode?.kind === "Issue" &&
        issueNode.description === `github:issue:${repository}#${expectedIssueNumber}` &&
        commitNode?.kind === "Commit" &&
        commitNode.description === `repo:${repository}:sha:${causingCommitSha}` &&
        typeof edge.why === "string" &&
        edge.why.trim().length > 0 &&
        (!config.causality?.reasonIncludes ||
          edge.why.toLowerCase().includes(config.causality.reasonIncludes.toLowerCase())) &&
        hasEvidence(edge)
      );
    });
    if (!causalEdge)
      throw new Error(
        "production ontology graph does not embed the exact cited Issue → Commit INTRODUCED_BY edge and reason"
      );
    if (config.verifyV51Fixture) {
      await verifyV51FixtureQueries(fetchImpl, apiUrl, headers, repository, ref);
    }
  }

  const metrics = await apiJson(fetchImpl, `${apiUrl}/ontology/metrics`, { headers });
  const outboxDepth = requiredRecord(metrics.outboxDepth, "metrics.outboxDepth");
  const pendingEvents = Object.values(outboxDepth).reduce<number>(
    (sum, value) => sum + requiredNonNegativeNumber(value, "outbox depth"),
    0
  );
  if (pendingEvents !== 0 || metrics.unparsedBlobCount !== 0) {
    throw new Error(
      `production ontology backlog is not empty (outbox=${pendingEvents}, unparsed=${String(metrics.unparsedBlobCount)})`
    );
  }

  return {
    taskId,
    repository,
    commitSha: requiredString(latest.commitSha, "ontology.latest.commitSha"),
    nodeCount: nodes.length,
    edgeCount: edges.length,
    citationCount: citations.length
  };
}

async function verifyCounterfactualAnswer(
  fetchImpl: typeof fetch,
  apiUrl: string,
  headers: Record<string, string>,
  repository: string,
  ref: string,
  question: string,
  expectRemainingPaths: boolean
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const context = await apiJson(fetchImpl, `${apiUrl}/ontology/ask`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ repository, ref, operation: "counterfactual", question })
    });
    const answer = requiredString(context.answer, "counterfactual context.answer");
    const calls = requiredArray(context.calls, "counterfactual context.calls");
    const claims = requiredArray(context.citedClaims, "counterfactual context.citedClaims");
    const everyClaimIsCited = claims.every(
      (claim) => isRecord(claim) && requiredArray(claim.citations, "counterfactual claim.citations").length > 0
    );
    const evaluation = isRecord(context.counterfactual) ? context.counterfactual : undefined;
    const remainingPaths = evaluation && Array.isArray(evaluation.remainingPaths) ? evaluation.remainingPaths : [];
    const remainingMatches = expectRemainingPaths ? remainingPaths.length > 0 : remainingPaths.length === 0;
    const honestLanguage = expectRemainingPaths
      ? /alternative|remain/i.test(answer)
      : /every currently known reviewed path|no known path/i.test(answer);
    if (
      context.operation === "counterfactual" &&
      honestLanguage &&
      remainingMatches &&
      claims.length > 0 &&
      everyClaimIsCited &&
      calls.length === 1 &&
      isRecord(calls[0]) &&
      calls[0].template === "counterfactual" &&
      evaluation?.basis === "graph-derived" &&
      Array.isArray(evaluation.removedPaths) &&
      evaluation.removedPaths.length > 0
    )
      return;
    if (attempt < 29) await delay(2_000);
  }
  throw new Error(`production counterfactual context is unsupported or uncited for: ${question}`);
}

async function reviewFixtureProposals(
  fetchImpl: typeof fetch,
  apiUrl: string,
  headers: Record<string, string>,
  assertions: readonly unknown[],
  excludedIds: ReadonlySet<string>
): Promise<void> {
  const reviewablePredicates = new Set([
    "IMPLEMENTS",
    "DOCUMENTED_BY",
    "REFERENCES",
    "OWNED_BY",
    "MOVED_FROM",
    "LIKELY_AFFECTS",
    "INTRODUCED_BY",
    "RESOLVED_BY",
    "INCIDENT_IMPACTS"
  ]);
  for (const value of assertions) {
    if (
      !isRecord(value) ||
      value.status !== "proposed" ||
      typeof value.id !== "string" ||
      excludedIds.has(value.id) ||
      typeof value.predicate !== "string" ||
      !reviewablePredicates.has(value.predicate)
    )
      continue;
    if (!Array.isArray(value.evidence) || value.evidence.length === 0) {
      throw new Error(`production v5.1 proposal ${value.id} has no review evidence`);
    }
    await apiJson(fetchImpl, `${apiUrl}/ontology/commands`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        type: "review_assertion",
        assertionId: value.id,
        decision: "accept",
        reason: "production v5.1 fixture evidence verified"
      })
    });
  }
}

async function verifyV51FixtureQueries(
  fetchImpl: typeof fetch,
  apiUrl: string,
  headers: Record<string, string>,
  repository: string,
  ref: string
): Promise<void> {
  const ask = (question: string, operation?: "counterfactual") =>
    apiJson(fetchImpl, `${apiUrl}/ontology/ask`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ repository, ref, question, ...(operation ? { operation } : {}) })
    });

  const implementationContext = await ask("Which symbols implement feature named Administrator resource deletion?");
  const featureItems = itemsForTemplate(implementationContext, "feature_trace");
  const implementations = featureItems.filter(
    (item) =>
      isRecord(item) &&
      isRecord(item.data) &&
      item.data.predicate === "IMPLEMENTS" &&
      isRecord(item.data.related) &&
      (item.data.related.kind === "File" || item.data.related.kind === "Symbol")
  );
  if (implementations.length < 2 || !implementations.every(hasCitations)) {
    throw new Error(
      "production v5.1 context did not return both cited Administrator resource deletion implementations"
    );
  }

  const packageContext = await ask("What package does the Administrator resource deletion implementation depend on?");
  const packageTrace = causalTraceFor(packageContext, "package dependency");
  if (!tracePaths(packageTrace.dependencies).some((path) => pathHasNode(path, "Package", "zod"))) {
    throw new Error("production v5.1 context did not traverse the implementation to its direct zod package");
  }

  const packageCounterfactual = await ask(
    "If package zod were excluded, which Administrator resource deletion implementation paths disappear?",
    "counterfactual"
  );
  const packageEvaluation = requiredRecord(packageCounterfactual.counterfactual, "v5.1 package counterfactual");
  const removedPackagePaths = requiredArray(packageEvaluation.removedPaths, "v5.1 package removedPaths");
  if (
    packageEvaluation.basis !== "graph-derived" ||
    removedPackagePaths.length === 0 ||
    !removedPackagePaths.some((path) => pathHasNode(path, "Package", "zod"))
  ) {
    throw new Error("production v5.1 package counterfactual did not remove a graph-derived implementation path");
  }

  const moveContext = await ask(
    "Did the renamed symbol previously implement the same Administrator resource deletion feature?"
  );
  const moveTrace = causalTraceFor(moveContext, "renamed implementation");
  if (
    !tracePaths(moveTrace.movedFrom).some(
      (path) =>
        pathHasNode(path, "File", "legacy-admin-deletion") ||
        pathHasNode(path, "Symbol", "canAdministratorDeleteViaLegacy")
    )
  )
    throw new Error("production v5.1 context did not preserve reviewed MOVED_FROM continuity");

  const incidentCauseContext = await ask("Which deployment introduced incident INC-2026-42, and why?");
  const incidentCauseTrace = causalTraceFor(incidentCauseContext, "incident cause");
  if (
    !tracePaths(incidentCauseTrace.causes).some(
      (path) => pathHasNode(path, "Deployment", "5535506368") && hasPathWhy(path)
    )
  ) {
    throw new Error("production v5.1 context did not return the cited deployment that introduced INC-2026-42");
  }

  const incidentImpactContext = await ask("Which service and feature did incident INC-2026-42 impact?");
  const incidentImpactTrace = causalTraceFor(incidentImpactContext, "incident impact");
  const impacts = tracePaths(incidentImpactTrace.affectedEntities);
  if (
    !impacts.some((path) => pathHasNode(path, "Service", "atlas-access-api")) ||
    !impacts.some((path) => pathHasNode(path, "Feature", "Administrator resource deletion"))
  ) {
    throw new Error("production v5.1 context did not return both the impacted service and feature");
  }

  const incidentResolutionContext = await ask("Which later deployment or PR resolved incident INC-2026-42?");
  const incidentResolutionTrace = causalTraceFor(incidentResolutionContext, "incident resolution");
  if (
    !tracePaths(incidentResolutionTrace.resolutions).some(
      (path) => pathHasNode(path, "Deployment", "5535522601") || pathHasNode(path, "PullRequest", "#16")
    )
  )
    throw new Error("production v5.1 context did not return the later incident resolution");

  const derivedContext = await ask("What issue was derived for the unlinked fixing PR #11?");
  const derivedTrace = causalTraceFor(derivedContext, "derived issue");
  const derivedRoot = requiredRecord(derivedTrace.root, "v5.1 derived issue root");
  if (
    derivedRoot.kind !== "Issue" ||
    !tracePaths(derivedTrace.resolutions).some((path) => pathHasNode(path, "PullRequest", "#11"))
  ) {
    throw new Error("production v5.1 context did not resolve PR #11 through a cited derived Issue");
  }
}

function itemsForTemplate(context: Record<string, unknown>, template: string): unknown[] {
  const call = requiredArray(context.calls, "v5.1 context.calls").find(
    (value) => isRecord(value) && value.template === template
  );
  return isRecord(call) ? requiredArray(call.items, `v5.1 ${template}.items`) : [];
}

function causalTraceFor(context: Record<string, unknown>, capability: string): Record<string, unknown> {
  const item = itemsForTemplate(context, "causal_trace")[0];
  if (!isRecord(item) || !hasCitations(item))
    throw new Error(`production v5.1 ${capability} has no cited causal trace`);
  return requiredRecord(item.data, `v5.1 ${capability}.data`);
}

function tracePaths(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function pathHasNode(path: unknown, kind: string, text: string): boolean {
  if (!isRecord(path) || !Array.isArray(path.nodes)) return false;
  return path.nodes.some(
    (node) =>
      isRecord(node) &&
      node.kind === kind &&
      `${stringValue(node.label)} ${stringValue(node.description)} ${stringValue(node.id)}`
        .toLowerCase()
        .includes(text.toLowerCase())
  );
}

function hasPathWhy(path: unknown): boolean {
  return isRecord(path) && typeof path.why === "string" && path.why.trim().length > 0;
}

function hasCitations(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.citations) && value.citations.length > 0;
}

export function blockedOntologyTaskIds(tasks: readonly unknown[], repository: string, ref: string): string[] {
  return tasks.flatMap((task) => {
    if (
      !isRecord(task) ||
      task.status !== "blocked" ||
      typeof task.type !== "string" ||
      !task.type.startsWith("ontology_")
    )
      return [];
    const metadata = isRecord(task.metadata) ? task.metadata : {};
    return metadata.repository === repository && metadata.ref === ref && typeof task.id === "string" ? [task.id] : [];
  });
}

async function waitForCausalTrace(
  fetchImpl: typeof fetch,
  apiUrl: string,
  headers: Record<string, string>,
  repository: string,
  ref: string,
  question: string,
  expected: {
    readonly issueNumber: number;
    readonly causingCommitSha: string;
    readonly causingPullRequestNumber?: number;
    readonly reasonIncludes?: string;
    readonly deadline: number;
    readonly pollIntervalMs: number;
  }
): Promise<void> {
  while (Date.now() < expected.deadline) {
    const context = await apiJson(fetchImpl, `${apiUrl}/ontology/ask`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ repository, ref, question })
    });
    const calls = requiredArray(context.calls, "causal context.calls");
    const traceCall = calls.find((call) => isRecord(call) && call.template === "issue_trace");
    const items = isRecord(traceCall) ? requiredArray(traceCall.items, "causal trace.items") : [];
    const matched = items.some((item) => {
      if (!isRecord(item) || !isRecord(item.data)) return false;
      const issue = isRecord(item.data.issue) ? item.data.issue : {};
      if (issue.number !== expected.issueNumber) return false;
      const causes = Array.isArray(item.data.introducedBy) ? item.data.introducedBy.filter(isRecord) : [];
      const cause = causes.find((value) => value.sha === expected.causingCommitSha);
      if (!isRecord(cause)) return false;
      if (typeof cause.why !== "string" || !cause.why.trim()) return false;
      if (expected.reasonIncludes && !cause.why.toLowerCase().includes(expected.reasonIncludes.toLowerCase()))
        return false;
      if (!Array.isArray(cause.evidence) || cause.evidence.length === 0) return false;
      if (typeof cause.evidenceCommitSha !== "string" || !/^[a-f0-9]{40}$/i.test(cause.evidenceCommitSha)) return false;
      if (expected.causingPullRequestNumber) {
        const pullRequests = Array.isArray(cause.pullRequests) ? cause.pullRequests : [];
        if (
          !pullRequests.some(
            (pullRequest) => isRecord(pullRequest) && pullRequest.number === expected.causingPullRequestNumber
          )
        )
          return false;
      }
      const citations = Array.isArray(item.citations) ? item.citations : [];
      return (
        citations.some((citation) => isRecord(citation) && citation.kind === "assertion") &&
        citations.some(
          (citation) => isRecord(citation) && citation.kind === "code" && citation.commitSha === cause.evidenceCommitSha
        )
      );
    });
    if (matched) return;
    await delay(expected.pollIntervalMs);
  }
  throw new Error(`production causal context retrieval timed out for: ${question}`);
}

async function runFollowupOntologyBuild(
  fetchImpl: typeof fetch,
  apiUrl: string,
  headers: Record<string, string>,
  repository: string,
  ref: string,
  requestKey: string,
  deadline: number,
  pollIntervalMs: number,
  log: (message: string) => void
): Promise<void> {
  const created = await apiJson(fetchImpl, `${apiUrl}/ontology/build`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ repository, ref, requestKey })
  });
  const taskId = requiredNestedString(created, "task", "id");
  let lastSummary = "";
  while (Date.now() < deadline) {
    const board = await apiJson(fetchImpl, `${apiUrl}/board`, { headers });
    const tasks = requiredArray(board.tasks, "board.tasks");
    const task = tasks.find((value) => isRecord(value) && value.id === taskId);
    if (!isRecord(task)) throw new Error(`causal projection task ${taskId} is missing from the board`);
    const status = requiredString(task.status, "causal projection task.status");
    const summary = summarizeWorkflowTasks(tasks, taskId);
    if (summary !== lastSummary) {
      log(`Production causal projection task ${taskId}: ${summary}`);
      lastSummary = summary;
    }
    if (status === "done") {
      const blocked = blockedOntologyTaskIds(tasks, repository, ref);
      if (blocked.length > 0)
        throw new Error(
          `production board retains blocked ontology tasks for ${repository}@${ref}: ${blocked.join(", ")}`
        );
      return;
    }
    if (TERMINAL_FAILURES.has(status)) {
      const failureSummary = await workflowFailureSummary(fetchImpl, apiUrl, headers, tasks, taskId);
      throw new Error(`production causal projection task ${taskId} ended as ${status} (${summary}${failureSummary})`);
    }
    await delay(pollIntervalMs);
  }
  throw new Error(`production causal projection task ${taskId} timed out`);
}

async function apiJson(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  return requiredRecord(await apiValue(fetchImpl, url, init), new URL(url).pathname);
}

async function apiArray(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<unknown[]> {
  return requiredArray(await apiValue(fetchImpl, url, init), new URL(url).pathname);
}

async function apiValue(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<unknown> {
  const response = await fetchImpl(url, init);
  const body = await response.text();
  if (!response.ok) throw new Error(`${new URL(url).pathname} failed with ${response.status}: ${body.slice(0, 500)}`);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`${new URL(url).pathname} returned invalid JSON`);
  }
}

async function workflowFailureSummary(
  fetchImpl: typeof fetch,
  apiUrl: string,
  headers: Record<string, string>,
  tasks: readonly unknown[],
  rootTaskId: string
): Promise<string> {
  const taskLabels = new Map<string, string>();
  for (const task of tasks) {
    if (!isRecord(task) || typeof task.id !== "string") continue;
    if (task.id !== rootTaskId && task.parentTaskId !== rootTaskId) continue;
    taskLabels.set(
      task.id,
      task.id === rootTaskId ? "root" : typeof task.type === "string" && task.type ? task.type : "child"
    );
  }
  const events = await apiArray(fetchImpl, `${apiUrl}/events`, { headers });
  const failures = events.flatMap((event) => {
    if (!isRecord(event) || typeof event.taskId !== "string" || !taskLabels.has(event.taskId)) return [];
    if (typeof event.type !== "string" || !event.type.endsWith(".failed")) return [];
    const payload = isRecord(event.payload) ? event.payload : {};
    const reason =
      typeof payload.reason === "string" && payload.reason.trim()
        ? payload.reason.trim().replace(/\s+/g, " ").slice(0, 800)
        : event.type;
    return [`${taskLabels.get(event.taskId)}: ${reason}`];
  });
  return failures.length > 0 ? `; failures: ${failures.slice(-3).join(" | ")}` : "";
}

function hasEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.evidence) &&
    value.evidence.length > 0 &&
    value.evidence.every((item) => typeof item === "string" && item.length > 0)
  );
}

function hasCitedItems(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length === 0) return false;
  return value.items.every((item) => isRecord(item) && Array.isArray(item.citations) && item.citations.length > 0);
}

function requiredNestedString(value: Record<string, unknown>, container: string, field: string): string {
  return requiredString(requiredRecord(value[container], container)[field], `${container}.${field}`);
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function requiredArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function requiredNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(`${field} must be a non-negative number`);
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
}

function requiredFullGitSha(value: string, field: string): string {
  const sha = value.trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error(`${field} must be a full Git SHA`);
  return sha;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const configuredTimeout = optionalPositiveIntegerEnv("ACCEPTANCE_TIMEOUT_MS");
    const expectedIssueNumber = optionalPositiveIntegerEnv("ACCEPTANCE_ISSUE_NUMBER");
    const expectedResolutionPullRequestNumber = optionalPositiveIntegerEnv("ACCEPTANCE_RESOLUTION_PR_NUMBER");
    const causingCommitSha = process.env.ACCEPTANCE_CAUSING_COMMIT_SHA?.trim();
    const causingPullRequestNumber = optionalPositiveIntegerEnv("ACCEPTANCE_CAUSING_PR_NUMBER");
    const reasonIncludes = process.env.ACCEPTANCE_CAUSAL_REASON_INCLUDES?.trim();
    const verifyV51Fixture = process.env.ACCEPTANCE_V51_FIXTURE?.trim().toLowerCase() === "true";
    const summary = await runProductionOntologyAcceptance({
      apiUrl: requiredEnv("JINA_API_URL"),
      token: requiredEnv("INTERNAL_API_TOKEN"),
      requestKey: requiredEnv("ACCEPTANCE_REQUEST_KEY"),
      ...(configuredTimeout === undefined ? {} : { timeoutMs: configuredTimeout }),
      ...(expectedIssueNumber === undefined ? {} : { expectedIssueNumber }),
      ...(expectedResolutionPullRequestNumber === undefined ? {} : { expectedResolutionPullRequestNumber }),
      ...(verifyV51Fixture ? { verifyV51Fixture: true } : {}),
      ...(causingCommitSha
        ? {
            causality: {
              causingCommitSha,
              ...(causingPullRequestNumber === undefined ? {} : { causingPullRequestNumber }),
              ...(reasonIncludes ? { reasonIncludes } : {})
            }
          }
        : {})
    });
    const message = `Production ontology accepted: ${summary.nodeCount} nodes, ${summary.edgeCount} edges, ${summary.citationCount} citations, commit ${summary.commitSha}`;
    await writeTerminationMessage(message);
    console.log(message);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeTerminationMessage(message);
    console.error(message);
    process.exitCode = productionAcceptanceExitCode(error);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalPositiveIntegerEnv(name: string): number | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  return positiveInteger(parsed, name);
}

async function writeTerminationMessage(message: string): Promise<void> {
  // Cloud Run projects this file into the task status. It keeps acceptance
  // diagnostics available to the deployer without granting broad log access.
  await writeFile("/dev/termination-log", message.slice(0, 4_000), "utf8").catch(() => undefined);
}

function summarizeWorkflowTasks(tasks: readonly unknown[], rootTaskId: string): string {
  const related = tasks
    .filter(
      (value): value is Record<string, unknown> =>
        isRecord(value) && (value.id === rootTaskId || value.parentTaskId === rootTaskId)
    )
    .sort((left, right) => taskSortKey(left, rootTaskId).localeCompare(taskSortKey(right, rootTaskId)));
  if (related.length === 0) return "no related tasks";
  return related
    .map((task) => {
      const label = task.id === rootTaskId ? "root" : typeof task.type === "string" && task.type ? task.type : "child";
      const status = typeof task.status === "string" && task.status ? task.status : "unknown";
      return `${label}=${status}`;
    })
    .join(", ");
}

function taskSortKey(task: Record<string, unknown>, rootTaskId: string): string {
  if (task.id === rootTaskId) return "0-root";
  const order: Record<string, string> = {
    ontology_ingest: "1-ingest",
    ontology_assert: "2-assert",
    ontology_project: "3-project"
  };
  return typeof task.type === "string" ? (order[task.type] ?? `9-${task.type}`) : "9-child";
}
