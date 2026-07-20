import type { OntologyNodeKind } from "./model.js";

export interface GitHubWorkItemObservation {
  readonly tenantId: string;
  readonly repository: string;
  readonly kind: "pull_request" | "issue";
  readonly number: number;
  readonly title: string;
  readonly body?: string;
  readonly state: string;
  readonly url: string;
  readonly authorLogin?: string;
  readonly occurredAt?: string;
  readonly recordedAt: string;
  readonly commitShas?: readonly string[];
  readonly resolvesIssueNumbers?: readonly number[];
  readonly referencesIssueNumbers?: readonly number[];
}

export interface GitHubOwnershipObservation {
  readonly tenantId: string;
  readonly repository: string;
  readonly kind: "codeowners";
  readonly commitSha: string;
  readonly path: string;
  readonly entries: readonly { readonly pattern: string; readonly owners: readonly string[] }[];
  readonly recordedAt: string;
}

export type GitHubSourceObservation = GitHubWorkItemObservation | GitHubOwnershipObservation;

export interface SourceEntityIntent {
  readonly kind: OntologyNodeKind;
  readonly key: string;
  readonly displayName: string;
}

export interface SourceAssertionIntent {
  readonly subject: SourceEntityIntent;
  readonly predicate: "AUTHORED_BY" | "INCLUDES" | "RESOLVES" | "REFERENCES" | "OWNED_BY";
  readonly object: SourceEntityIntent;
  readonly qualifiers?: Readonly<Record<string, string | number | boolean>>;
}

export function normalizeGitHubSourceObservation(observation: GitHubSourceObservation): NormalizedGitHubObservation {
  return observation.kind === "codeowners" ? normalizeGitHubOwnership(observation) : normalizeGitHubWorkItem(observation);
}

export interface NormalizedGitHubObservation {
  readonly entities: readonly SourceEntityIntent[];
  readonly assertions: readonly SourceAssertionIntent[];
  readonly githubIdentity?: { readonly externalId: string; readonly entity: SourceEntityIntent };
}

/** Pure GitHub normalizer. It converts raw source records into idempotent intents and performs no I/O. */
export function normalizeGitHubWorkItem(observation: GitHubWorkItemObservation): NormalizedGitHubObservation {
  const subject: SourceEntityIntent = observation.kind === "pull_request"
    ? { kind: "PullRequest", key: `github:pr:${observation.repository}#${observation.number}`, displayName: `#${observation.number} ${observation.title}` }
    : { kind: "Issue", key: `github:issue:${observation.repository}#${observation.number}`, displayName: `#${observation.number} ${observation.title}` };
  const entities: SourceEntityIntent[] = [subject];
  const assertions: SourceAssertionIntent[] = [];
  let githubIdentity: NormalizedGitHubObservation["githubIdentity"];
  if (observation.authorLogin) {
    const engineer: SourceEntityIntent = { kind: "Engineer", key: `github:user:${observation.authorLogin}`, displayName: observation.authorLogin };
    entities.push(engineer);
    assertions.push({ subject, predicate: "AUTHORED_BY", object: engineer });
    githubIdentity = { externalId: observation.authorLogin, entity: engineer };
  }
  if (observation.kind === "pull_request") {
    for (const sha of new Set(observation.commitShas ?? [])) {
      const commit: SourceEntityIntent = { kind: "Commit", key: `repo:${observation.repository}:sha:${sha}`, displayName: sha.slice(0, 12) };
      entities.push(commit);
      assertions.push({ subject, predicate: "INCLUDES", object: commit });
    }
    const resolved = new Set(observation.resolvesIssueNumbers ?? []);
    for (const number of new Set([...(observation.referencesIssueNumbers ?? []), ...resolved])) {
      const issue: SourceEntityIntent = { kind: "Issue", key: `github:issue:${observation.repository}#${number}`, displayName: `Issue #${number}` };
      entities.push(issue);
      assertions.push({ subject, predicate: resolved.has(number) ? "RESOLVES" : "REFERENCES", object: issue });
    }
  }
  return { entities: dedupe(entities, (entity) => `${entity.kind}:${entity.key}`), assertions: dedupe(assertions, (item) => `${item.subject.key}:${item.predicate}:${item.object.key}`), ...(githubIdentity ? { githubIdentity } : {}) };
}

function normalizeGitHubOwnership(observation: GitHubOwnershipObservation): NormalizedGitHubObservation {
  const repository: SourceEntityIntent = {
    kind: "Repository", key: `github:repo:${observation.repository}`, displayName: observation.repository
  };
  const entities: SourceEntityIntent[] = [repository];
  const assertions: SourceAssertionIntent[] = [];
  for (const entry of observation.entries) {
    for (const owner of entry.owners) {
      const normalized = owner.replace(/^@/, "");
      const team = owner.startsWith("@") && normalized.includes("/");
      const entity: SourceEntityIntent = team
        ? { kind: "Team", key: `github:team:${normalized}`, displayName: owner }
        : owner.startsWith("@")
          ? { kind: "Engineer", key: `github:user:${normalized}`, displayName: owner }
          : { kind: "Engineer", key: `email:${normalized.toLowerCase()}`, displayName: owner };
      entities.push(entity);
      assertions.push({ subject: repository, predicate: "OWNED_BY", object: entity, qualifiers: { pattern: entry.pattern } });
    }
  }
  return {
    entities: dedupe(entities, (entity) => `${entity.kind}:${entity.key}`),
    assertions: dedupe(assertions, (item) => `${item.subject.key}:${item.predicate}:${item.object.key}:${JSON.stringify(item.qualifiers ?? {})}`)
  };
}

export function linkedIssueNumbers(text: string): { readonly resolves: readonly number[]; readonly references: readonly number[] } {
  const resolves = new Set<number>();
  const references = new Set<number>();
  for (const match of text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#(\d+)/gi)) {
    if (match[1]) resolves.add(Number.parseInt(match[1], 10));
  }
  for (const match of text.matchAll(/(?:^|[^\w/])#(\d+)\b/g)) {
    if (match[1]) references.add(Number.parseInt(match[1], 10));
  }
  return { resolves: [...resolves], references: [...references].filter((number) => !resolves.has(number)) };
}

function dedupe<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => seen.has(key(value)) ? false : (seen.add(key(value)), true));
}
