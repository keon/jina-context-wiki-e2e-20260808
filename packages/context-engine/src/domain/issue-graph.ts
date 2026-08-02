import { fingerprint, isFullCommitSha, normalizeIsoTime, normalizeRepository, stableId } from "./fingerprint.js";

export const issueEvidenceRoles = ["introduced", "observed", "resolved"] as const;
export type IssueEvidenceRole = (typeof issueEvidenceRoles)[number];

export const issueCausalityPredicates = ["INTRODUCED_BY", "RESOLVED_BY", "CAUSED_BY", "CONTRIBUTES_TO"] as const;
export type IssueCausalityPredicate = (typeof issueCausalityPredicates)[number];

export interface IssueHistoryCommit {
  readonly sha: string;
  readonly parentShas: readonly string[];
  readonly message: string;
  readonly committedAt?: string;
}

export interface IssueCommitEvidence {
  readonly commitSha: string;
  readonly role: IssueEvidenceRole;
  readonly messageStartLine: number;
  readonly messageEndLine: number;
  readonly excerpt: string;
}

export interface DerivedIssue {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly state: "active" | "resolved";
  readonly evidence: readonly IssueCommitEvidence[];
}

export interface IssueCausality {
  readonly id: string;
  readonly subjectIssueId: string;
  readonly predicate: IssueCausalityPredicate;
  readonly object: {
    readonly kind: "issue" | "commit";
    readonly id: string;
  };
  readonly why: string;
  readonly confidence: "explicit" | "inferred";
  readonly evidence: readonly IssueCommitEvidence[];
}

export interface IssueGraphArtifactV1 {
  readonly version: 1;
  readonly id: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly refSequence: number;
  readonly commitSha: string;
  readonly generatedAt: string;
  readonly summary: string;
  readonly coverage: {
    readonly observedCommitCount: number;
    readonly complete: boolean;
    readonly oldestObservedCommit: string;
  };
  readonly generator: {
    readonly name: string;
    readonly version: string;
    readonly model: string;
    readonly promptVersion: string;
    readonly schemaVersion: "issue-causality-v1";
  };
  readonly issues: readonly DerivedIssue[];
  readonly causalities: readonly IssueCausality[];
  readonly contentDigest: string;
}

export interface IssueGraphCandidate {
  readonly version: 1;
  readonly summary: string;
  readonly issues: readonly {
    readonly key: string;
    readonly existingIssueId?: string;
    readonly title: string;
    readonly summary: string;
    readonly evidence: readonly Omit<IssueCommitEvidence, "excerpt">[];
  }[];
  readonly causalities: readonly {
    readonly subjectKey: string;
    readonly predicate: IssueCausalityPredicate;
    readonly objectKind: "issue" | "commit";
    readonly objectRef: string;
    readonly why: string;
    readonly confidence: "explicit" | "inferred";
    readonly evidence: readonly Omit<IssueCommitEvidence, "excerpt">[];
  }[];
}

export interface MaterializeIssueGraphInput {
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly refSequence: number;
  readonly commitSha: string;
  readonly generatedAt: string;
  readonly history: readonly IssueHistoryCommit[];
  readonly historyComplete: boolean;
  readonly candidate: unknown;
  readonly prior?: IssueGraphArtifactV1;
  readonly generator: Omit<IssueGraphArtifactV1["generator"], "schemaVersion">;
}

const MAX_ISSUES = 2_000;
const MAX_CAUSALITIES = 5_000;
const ISSUE_ID_PATTERN = /^issue_[0-9a-f]{32}$/;

/**
 * Converts one model-authored candidate into a deterministic, immutable graph.
 * The model chooses semantics; the host owns identity, evidence bounds, state,
 * endpoint types, ordering, and the release digest.
 */
export function materializeIssueGraph(input: MaterializeIssueGraphInput): IssueGraphArtifactV1 {
  const tenantId = boundedString(input.tenantId, "tenantId", 240);
  const repository = normalizeRepository(input.repository);
  const ref = boundedString(input.ref, "ref", 1_000);
  if (!Number.isSafeInteger(input.refSequence) || input.refSequence <= 0) {
    throw new Error("issue graph refSequence must be a positive safe integer");
  }
  const commitSha = fullCommitSha(input.commitSha, "commitSha");
  const generatedAt = normalizeIsoTime(input.generatedAt);
  if (input.history.length === 0 || input.history.length > 50_000) {
    throw new Error("issue graph history must contain between 1 and 50000 commits");
  }
  const history = validatedHistory(input.history);
  if (!history.has(commitSha)) throw new Error("issue graph history does not contain its target commit");
  const candidate = parseIssueGraphCandidate(input.candidate);
  const priorIssues = validatedPrior(input.prior, tenantId, repository, ref);
  const issuesByKey = new Map<string, DerivedIssue>();
  const usedIds = new Set<string>();

  for (const issue of candidate.issues) {
    const evidence = issue.evidence.map((item) => materializeEvidence(item, history));
    const first = evidence[0]!;
    const existing = issue.existingIssueId ? priorIssues.get(issue.existingIssueId) : undefined;
    if (issue.existingIssueId && !existing) {
      throw new Error(`issue graph references unknown prior issue ${issue.existingIssueId}`);
    }
    const id =
      existing?.id ??
      stableId("issue", {
        repository,
        commitSha: first.commitSha,
        messageStartLine: first.messageStartLine,
        messageEndLine: first.messageEndLine,
        title: normalizedIdentityTitle(issue.title)
      });
    if (usedIds.has(id)) throw new Error(`issue graph produces duplicate issue identity ${id}`);
    usedIds.add(id);
    issuesByKey.set(issue.key, {
      id,
      title: issue.title,
      summary: issue.summary,
      state: issueState(evidence, history),
      evidence
    });
  }

  const causalities = candidate.causalities.map((causality) => {
    const subject = issuesByKey.get(causality.subjectKey);
    if (!subject) throw new Error(`causality references unknown subject issue key ${causality.subjectKey}`);
    const expectedKind = causalityObjectKind(causality.predicate);
    if (causality.objectKind !== expectedKind) {
      throw new Error(`${causality.predicate} requires a ${expectedKind} object`);
    }
    const objectId =
      causality.objectKind === "commit"
        ? fullCommitSha(causality.objectRef, "causality commit")
        : requiredIssueKey(issuesByKey, causality.objectRef).id;
    if (causality.objectKind === "commit" && !history.has(objectId)) {
      throw new Error(`causality references commit outside the observed history: ${objectId}`);
    }
    if (causality.objectKind === "issue" && objectId === subject.id) {
      throw new Error("an issue cannot causally reference itself");
    }
    const evidence = causality.evidence.map((item) => materializeEvidence(item, history));
    return {
      id: stableId("cause", {
        subjectIssueId: subject.id,
        predicate: causality.predicate,
        objectKind: causality.objectKind,
        objectId
      }),
      subjectIssueId: subject.id,
      predicate: causality.predicate,
      object: { kind: causality.objectKind, id: objectId },
      why: causality.why,
      confidence: causality.confidence,
      evidence
    } satisfies IssueCausality;
  });
  const uniqueCausalities = new Map(causalities.map((causality) => [causality.id, causality]));
  if (uniqueCausalities.size !== causalities.length) throw new Error("issue graph contains duplicate causalities");
  assertAcyclicIssueCausality([...issuesByKey.values()], causalities);

  const issues = [...issuesByKey.values()].sort((left, right) => left.id.localeCompare(right.id));
  const orderedCausalities = [...uniqueCausalities.values()].sort((left, right) => left.id.localeCompare(right.id));
  const content = {
    version: 1 as const,
    tenantId,
    repository,
    ref,
    refSequence: input.refSequence,
    commitSha,
    generatedAt,
    summary: candidate.summary,
    coverage: {
      observedCommitCount: history.size,
      complete: input.historyComplete,
      oldestObservedCommit: [...history.keys()].at(-1)!
    },
    generator: { ...input.generator, schemaVersion: "issue-causality-v1" as const },
    issues,
    causalities: orderedCausalities
  };
  const contentDigest = fingerprint(content);
  return { ...content, id: `cir_${contentDigest.slice(0, 32)}`, contentDigest };
}

export function parseIssueGraphArtifact(value: unknown): IssueGraphArtifactV1 {
  const root = record(value, "issue graph artifact");
  if (root.version !== 1) throw new Error("issue graph artifact version must be 1");
  const artifact = root as unknown as IssueGraphArtifactV1;
  if (!/^cir_[0-9a-f]{32}$/.test(artifact.id ?? "")) throw new Error("issue graph artifact id is invalid");
  if (fingerprint(withoutArtifactIdentity(artifact)) !== artifact.contentDigest) {
    throw new Error("issue graph artifact content digest is invalid");
  }
  if (artifact.id !== `cir_${artifact.contentDigest.slice(0, 32)}`) {
    throw new Error("issue graph artifact id does not match its content digest");
  }
  return artifact;
}

export function searchIssueGraph(graph: IssueGraphArtifactV1, query: string, limit = 25): readonly DerivedIssue[] {
  const terms = normalizedTerms(query).slice(0, 32);
  const maximum = Math.max(1, Math.min(limit, 100));
  return graph.issues
    .map((issue) => {
      const haystack = `${issue.title}\n${issue.summary}`.toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { issue, score };
    })
    .filter(({ score }) => terms.length === 0 || score > 0)
    .sort((left, right) => right.score - left.score || left.issue.title.localeCompare(right.issue.title))
    .slice(0, maximum)
    .map(({ issue }) => issue);
}

export function issueGraphTrace(
  graph: IssueGraphArtifactV1,
  rootIssueId: string,
  options: { readonly depth?: number; readonly maxIssues?: number; readonly maxCausalities?: number } = {}
): { readonly issues: readonly DerivedIssue[]; readonly causalities: readonly IssueCausality[] } {
  const root = graph.issues.find((issue) => issue.id === rootIssueId);
  if (!root) throw new Error("issue graph root issue was not found");
  const maximumDepth = Math.max(0, Math.min(options.depth ?? 2, 4));
  const maximumIssues = Math.max(1, Math.min(options.maxIssues ?? 100, 200));
  const maximumCausalities = Math.max(1, Math.min(options.maxCausalities ?? 200, 500));
  const byId = new Map(graph.issues.map((issue) => [issue.id, issue]));
  const selected = new Map([[root.id, root]]);
  const selectedEdges = new Map<string, IssueCausality>();
  let frontier = [root.id];
  for (let depth = 0; depth < maximumDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of graph.causalities) {
        const neighbor =
          edge.subjectIssueId === id && edge.object.kind === "issue"
            ? edge.object.id
            : edge.object.kind === "issue" && edge.object.id === id
              ? edge.subjectIssueId
              : undefined;
        if (!neighbor) continue;
        if (selectedEdges.size < maximumCausalities) selectedEdges.set(edge.id, edge);
        if (selected.size >= maximumIssues || selected.has(neighbor)) continue;
        const issue = byId.get(neighbor);
        if (issue) {
          selected.set(issue.id, issue);
          next.push(issue.id);
        }
      }
    }
    frontier = next;
  }
  for (const edge of graph.causalities) {
    if (edge.subjectIssueId === root.id && edge.object.kind === "commit" && selectedEdges.size < maximumCausalities) {
      selectedEdges.set(edge.id, edge);
    }
  }
  return { issues: [...selected.values()], causalities: [...selectedEdges.values()] };
}

function parseIssueGraphCandidate(value: unknown): IssueGraphCandidate {
  const root = exactRecord(value, ["version", "summary", "issues", "causalities"], "issue graph candidate");
  if (root.version !== 1) throw new Error("issue graph candidate version must be 1");
  const summary = boundedString(root.summary, "issue graph summary", 4_000);
  if (!Array.isArray(root.issues) || root.issues.length > MAX_ISSUES) {
    throw new Error(`issue graph candidate may contain at most ${MAX_ISSUES} issues`);
  }
  if (!Array.isArray(root.causalities) || root.causalities.length > MAX_CAUSALITIES) {
    throw new Error(`issue graph candidate may contain at most ${MAX_CAUSALITIES} causalities`);
  }
  const keys = new Set<string>();
  const issues = root.issues.map((value, index) => {
    const issue = record(value, `issue ${index}`);
    const allowed = ["key", "existingIssueId", "title", "summary", "evidence"];
    assertOptionalKeys(issue, allowed, ["key", "title", "summary", "evidence"], `issue ${index}`);
    const key = boundedString(issue.key, `issue ${index} key`, 120);
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(key)) throw new Error(`issue ${index} key is invalid`);
    if (keys.has(key)) throw new Error(`duplicate issue key ${key}`);
    keys.add(key);
    const existingIssueId =
      issue.existingIssueId === undefined
        ? undefined
        : boundedString(issue.existingIssueId, `issue ${index} existingIssueId`, 64);
    if (existingIssueId && !ISSUE_ID_PATTERN.test(existingIssueId)) {
      throw new Error(`issue ${index} existingIssueId is invalid`);
    }
    return {
      key,
      ...(existingIssueId ? { existingIssueId } : {}),
      title: boundedString(issue.title, `issue ${index} title`, 200, 4),
      summary: boundedString(issue.summary, `issue ${index} summary`, 4_000, 12),
      evidence: parseEvidenceArray(issue.evidence, `issue ${index}`)
    };
  });
  const causalities = root.causalities.map((value, index) => {
    const edge = exactRecord(
      value,
      ["subjectKey", "predicate", "objectKind", "objectRef", "why", "confidence", "evidence"],
      `causality ${index}`
    );
    const predicate = enumValue(edge.predicate, issueCausalityPredicates, `causality ${index} predicate`);
    return {
      subjectKey: boundedString(edge.subjectKey, `causality ${index} subjectKey`, 120),
      predicate,
      objectKind: enumValue(edge.objectKind, ["issue", "commit"] as const, `causality ${index} objectKind`),
      objectRef: boundedString(edge.objectRef, `causality ${index} objectRef`, 120),
      why: boundedString(edge.why, `causality ${index} why`, 2_000, 12),
      confidence: enumValue(edge.confidence, ["explicit", "inferred"] as const, `causality ${index} confidence`),
      evidence: parseEvidenceArray(edge.evidence, `causality ${index}`)
    };
  });
  return { version: 1, summary, issues, causalities };
}

function parseEvidenceArray(value: unknown, name: string): Omit<IssueCommitEvidence, "excerpt">[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error(`${name} must contain between 1 and 100 evidence anchors`);
  }
  return value.map((item, index) => {
    const evidence = exactRecord(
      item,
      ["commitSha", "role", "messageStartLine", "messageEndLine"],
      `${name} evidence ${index}`
    );
    return {
      commitSha: fullCommitSha(evidence.commitSha, `${name} evidence commitSha`),
      role: enumValue(evidence.role, issueEvidenceRoles, `${name} evidence role`),
      messageStartLine: positiveInteger(evidence.messageStartLine, `${name} evidence messageStartLine`),
      messageEndLine: positiveInteger(evidence.messageEndLine, `${name} evidence messageEndLine`)
    };
  });
}

function validatedHistory(history: readonly IssueHistoryCommit[]): Map<string, IssueHistoryCommit> {
  const values = new Map<string, IssueHistoryCommit>();
  for (const [index, commit] of history.entries()) {
    const sha = fullCommitSha(commit.sha, `history commit ${index} sha`);
    if (values.has(sha)) throw new Error(`issue graph history contains duplicate commit ${sha}`);
    const parentShas = commit.parentShas.map((parent) => fullCommitSha(parent, `history commit ${sha} parent`));
    const message = boundedString(commit.message, `history commit ${sha} message`, 256 * 1024);
    values.set(sha, {
      sha,
      parentShas,
      message,
      ...(commit.committedAt ? { committedAt: normalizeIsoTime(commit.committedAt) } : {})
    });
  }
  return values;
}

function validatedPrior(
  prior: IssueGraphArtifactV1 | undefined,
  tenantId: string,
  repository: string,
  ref: string
): Map<string, DerivedIssue> {
  if (!prior) return new Map();
  const parsed = parseIssueGraphArtifact(prior);
  if (parsed.tenantId !== tenantId || parsed.repository !== repository || parsed.ref !== ref) {
    throw new Error("prior issue graph escapes the requested scope");
  }
  return new Map(parsed.issues.map((issue) => [issue.id, issue]));
}

function materializeEvidence(
  evidence: Omit<IssueCommitEvidence, "excerpt">,
  history: ReadonlyMap<string, IssueHistoryCommit>
): IssueCommitEvidence {
  const commit = history.get(evidence.commitSha);
  if (!commit) throw new Error(`issue evidence commit is outside the observed history: ${evidence.commitSha}`);
  const lines = commit.message.split(/\r?\n/);
  if (evidence.messageEndLine < evidence.messageStartLine || evidence.messageEndLine > lines.length) {
    throw new Error(`issue evidence range is outside commit ${evidence.commitSha}`);
  }
  const excerpt = lines
    .slice(evidence.messageStartLine - 1, evidence.messageEndLine)
    .join("\n")
    .trim();
  if (!excerpt) throw new Error(`issue evidence excerpt is empty for commit ${evidence.commitSha}`);
  return { ...evidence, excerpt };
}

function issueState(
  evidence: readonly IssueCommitEvidence[],
  history: ReadonlyMap<string, IssueHistoryCommit>
): DerivedIssue["state"] {
  const newest = [...evidence].sort((left, right) => {
    const leftAt = history.get(left.commitSha)?.committedAt ?? "";
    const rightAt = history.get(right.commitSha)?.committedAt ?? "";
    return rightAt.localeCompare(leftAt) || left.commitSha.localeCompare(right.commitSha);
  })[0]!;
  return newest.role === "resolved" ? "resolved" : "active";
}

function assertAcyclicIssueCausality(issues: readonly DerivedIssue[], causalities: readonly IssueCausality[]): void {
  const outgoing = new Map(issues.map((issue) => [issue.id, [] as string[]]));
  for (const edge of causalities) {
    if (edge.object.kind === "issue" && ["CAUSED_BY", "CONTRIBUTES_TO"].includes(edge.predicate)) {
      outgoing.get(edge.subjectIssueId)?.push(edge.object.id);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("issue causality must be acyclic");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of outgoing.get(id) ?? []) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const issue of issues) visit(issue.id);
}

function causalityObjectKind(predicate: IssueCausalityPredicate): "issue" | "commit" {
  return predicate === "INTRODUCED_BY" || predicate === "RESOLVED_BY" ? "commit" : "issue";
}

function requiredIssueKey(issues: ReadonlyMap<string, DerivedIssue>, key: string): DerivedIssue {
  const issue = issues.get(key);
  if (!issue) throw new Error(`causality references unknown object issue key ${key}`);
  return issue;
}

function withoutArtifactIdentity(artifact: IssueGraphArtifactV1) {
  const { id: _id, contentDigest: _contentDigest, ...content } = artifact;
  return content;
}

function normalizedIdentityTitle(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizedTerms(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9_.-]+/)
        .filter((term) => term.length > 1)
    )
  ];
}

function exactRecord(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  const result = record(value, name);
  assertKeys(result, keys, name);
  return result;
}

function assertKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} has unexpected fields`);
  }
}

function assertOptionalKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  name: string
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !(key in value))) {
    throw new Error(`${name} has unexpected fields`);
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, name: string, maximum: number, minimum = 1): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < minimum || Buffer.byteLength(normalized, "utf8") > maximum) {
    throw new Error(`${name} must contain between ${minimum} and ${maximum} bytes`);
  }
  return normalized;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

function fullCommitSha(value: unknown, name: string): string {
  if (typeof value !== "string" || !isFullCommitSha(value)) throw new Error(`${name} must be a full Git SHA`);
  return value.toLowerCase();
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, name: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}
