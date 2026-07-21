import type { OntologyNodeKind } from "./model.js";

export function codeownersPatternMatches(rawPattern: string, path: string): boolean {
  const pattern = rawPattern.trim();
  if (!pattern || pattern.startsWith("!")) return false;
  const anchored = pattern.startsWith("/");
  const normalized = pattern.replace(/^\//, "").replace(/\/$/, "/**");
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\uE000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\uE000/g, ".*");
  if (!anchored && !normalized.includes("/")) return new RegExp(`(?:^|/)${escaped}$`).test(path);
  return new RegExp(`^${escaped}$`).test(path);
}

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
  /** GitHub's merge commit is authoritative only when mergedAt is present. */
  readonly mergeCommitSha?: string;
  readonly mergedAt?: string;
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

export interface PackageManifestObservation {
  readonly tenantId: string;
  readonly repository: string;
  readonly kind: "package_manifest";
  readonly commitSha: string;
  readonly path: string;
  readonly ecosystem: string;
  readonly dependencies: readonly { readonly name: string; readonly version?: string }[];
  /** A current-ref tombstone retracts facts from a manifest that was deleted. */
  readonly removed?: boolean;
  readonly recordedAt: string;
}

export interface ServiceDefinitionObservation {
  readonly tenantId: string;
  readonly repository: string;
  readonly kind: "service_definition";
  readonly commitSha: string;
  readonly path: string;
  readonly source: string;
  readonly externalId: string;
  readonly name: string;
  readonly dependsOnServices?: readonly {
    readonly source: string;
    readonly externalId: string;
    readonly name: string;
  }[];
  /** A current-ref tombstone retracts facts from a deleted service definition. */
  readonly removed?: boolean;
  readonly recordedAt: string;
}

export interface DeploymentSourceObservation {
  readonly tenantId: string;
  readonly repository: string;
  readonly kind: "deployment";
  readonly source: string;
  readonly externalId: string;
  readonly commitSha: string;
  readonly environment: string;
  readonly status: string;
  readonly service?: { readonly source: string; readonly externalId: string; readonly name: string };
  readonly occurredAt?: string;
  readonly recordedAt: string;
}

export interface IncidentSourceObservation {
  readonly tenantId: string;
  readonly repository: string;
  readonly kind: "incident";
  readonly source: string;
  readonly externalId: string;
  readonly title: string;
  readonly url?: string;
  readonly issueNumber?: number;
  readonly impactedService?: { readonly source: string; readonly externalId: string; readonly name: string };
  readonly occurredAt?: string;
  /** A current-ref tombstone retracts facts from a deleted postmortem. */
  readonly removed?: boolean;
  readonly recordedAt: string;
}

export interface MoveCandidateObservation {
  readonly tenantId: string;
  readonly repository: string;
  readonly kind: "move_candidate";
  readonly commitSha: string;
  readonly candidates: readonly {
    readonly oldPath: string;
    readonly newPath: string;
    readonly similarity: number;
    readonly matchingSignatureHashes: readonly string[];
  }[];
  readonly recordedAt: string;
}

export type RepositorySourceObservation =
  | GitHubSourceObservation
  | PackageManifestObservation
  | ServiceDefinitionObservation
  | DeploymentSourceObservation
  | IncidentSourceObservation
  | MoveCandidateObservation;

export interface SourceEntityIntent {
  readonly kind: OntologyNodeKind;
  readonly key: string;
  readonly displayName: string;
}

export interface SourceAssertionIntent {
  readonly subject: SourceEntityIntent;
  readonly predicate:
    | "AUTHORED_BY"
    | "INCLUDES"
    | "MERGED_AS"
    | "RESOLVES"
    | "REFERENCES"
    | "OWNED_BY"
    | "DEPENDS_ON"
    | "DEPLOYS"
    | "TARGETS"
    | "INCIDENT_IMPACTS";
  readonly object: SourceEntityIntent;
  readonly explanation: string;
  readonly qualifiers?: Readonly<Record<string, string | number | boolean>>;
}

export function normalizeGitHubSourceObservation(observation: GitHubSourceObservation): NormalizedGitHubObservation {
  return observation.kind === "codeowners"
    ? normalizeGitHubOwnership(observation)
    : normalizeGitHubWorkItem(observation);
}

export function normalizeSourceObservation(observation: RepositorySourceObservation): NormalizedGitHubObservation {
  if (observation.kind === "package_manifest") return normalizePackageManifest(observation);
  if (observation.kind === "service_definition") return normalizeServiceDefinition(observation);
  if (observation.kind === "deployment") return normalizeDeployment(observation);
  if (observation.kind === "incident") return normalizeIncident(observation);
  if (observation.kind === "move_candidate") return { entities: [], assertions: [] };
  return normalizeGitHubSourceObservation(observation);
}

export function sourceObservationExternalId(observation: RepositorySourceObservation): string {
  if (observation.kind === "codeowners")
    return `${observation.repository}:codeowners:${observation.commitSha}:${observation.path}`;
  if ("number" in observation) {
    return `${observation.repository}:${observation.kind}:${observation.number}:${observation.occurredAt ?? observation.recordedAt}`;
  }
  if (observation.kind === "package_manifest" || observation.kind === "service_definition") {
    return `${observation.repository}:${observation.kind}:${observation.commitSha}:${observation.path}${observation.kind === "service_definition" ? `:${observation.externalId}` : ""}`;
  }
  if (observation.kind === "move_candidate")
    return `${observation.repository}:${observation.kind}:${observation.commitSha}`;
  if (observation.kind === "deployment" || observation.kind === "incident") {
    return `${observation.repository}:${observation.kind}:${observation.source}:${observation.externalId}:${observation.occurredAt ?? observation.recordedAt}`;
  }
  throw new Error(`unsupported source observation: ${String((observation as { kind?: unknown }).kind)}`);
}

export function sourceObservationProvider(observation: RepositorySourceObservation): string {
  if (observation.kind === "codeowners") return "codeowners";
  if (observation.kind === "package_manifest") return "manifest";
  if (observation.kind === "service_definition") return observation.source;
  if (observation.kind === "deployment" || observation.kind === "incident") return observation.source;
  if (observation.kind === "move_candidate") return "git";
  return "github";
}

export function parsePackageManifest(
  input: Omit<PackageManifestObservation, "kind" | "ecosystem" | "dependencies"> & {
    readonly source: string;
  }
): PackageManifestObservation | undefined {
  const parsed = packageDependencies(input.path, input.source);
  if (!parsed) return undefined;
  return { ...input, kind: "package_manifest", ecosystem: parsed.ecosystem, dependencies: parsed.dependencies };
}

export function parseServiceDefinitions(
  input: Omit<ServiceDefinitionObservation, "kind" | "source" | "externalId" | "name"> & {
    readonly content: string;
  }
): readonly ServiceDefinitionObservation[] {
  const path = input.path.toLowerCase();
  const values: {
    source: string;
    externalId: string;
    name: string;
    dependsOnServices?: ServiceDefinitionObservation["dependsOnServices"];
  }[] = [];
  const dockerfile = /(?:^|\/)(?:dockerfile)(?:\.([A-Za-z0-9_.-]+))?$/i.exec(input.path);
  if (dockerfile) {
    const directory = input.path.includes("/")
      ? input.path.slice(0, input.path.lastIndexOf("/")).split("/").at(-1)
      : undefined;
    const name =
      dockerfile[1] ?? (directory && !/^(?:docker|deploy(?:ment)?s?)$/i.test(directory) ? directory : undefined);
    if (name) values.push({ source: "dockerfile", externalId: `${input.repository}:${name}`, name });
  }
  if (/(?:^|\/)(?:docker-)?compose(?:\.[^.]+)?\.ya?ml$/.test(path)) {
    const lines = input.content.split(/\r?\n/);
    const start = lines.findIndex((line) => /^services:\s*(?:#.*)?$/.test(line));
    const services = new Map<string, Set<string>>();
    let currentService: string | undefined;
    let readingDependencies = false;
    for (const line of start < 0 ? [] : lines.slice(start + 1)) {
      if (/^[^\s#]/.test(line)) break;
      const service = /^ {2}([A-Za-z0-9_.-]+):\s*(?:#.*)?$/.exec(line)?.[1];
      if (service) {
        currentService = service;
        readingDependencies = false;
        services.set(service, services.get(service) ?? new Set());
        continue;
      }
      if (/^ {4}depends_on:\s*(?:#.*)?$/.test(line)) {
        readingDependencies = true;
        continue;
      }
      if (/^ {4}\S/.test(line)) readingDependencies = false;
      if (!currentService || !readingDependencies) continue;
      const dependency = /^ {6}(?:-\s*)?([A-Za-z0-9_.-]+)(?::\s*(?:#.*)?)?$/.exec(line)?.[1];
      if (dependency) services.get(currentService)?.add(dependency);
    }
    for (const [name, dependencies] of services)
      values.push({
        source: "compose",
        externalId: `${input.repository}:${name}`,
        name,
        dependsOnServices: [...dependencies].map((dependency) => ({
          source: "compose",
          externalId: `${input.repository}:${dependency}`,
          name: dependency
        }))
      });
  }
  if (/\.ya?ml$/.test(path)) {
    const kind = /^kind:\s*(Service|Deployment)\s*$/im.exec(input.content)?.[1];
    const name = /^\s*name:\s*([A-Za-z0-9_.-]+)\s*$/im.exec(input.content)?.[1];
    const cloudRunName = /^\s*metadata:\s*$[\s\S]{0,500}?^\s*name:\s*([A-Za-z0-9_.-]+)\s*$/im.exec(input.content)?.[1];
    const isCloudRun = /run\.googleapis\.com|serving\.knative\.dev/i.test(input.content);
    if (isCloudRun && cloudRunName) {
      values.push({ source: "cloud-run", externalId: cloudRunName, name: cloudRunName });
    } else if (kind && name) values.push({ source: "kubernetes", externalId: `${input.repository}:${name}`, name });
  }
  if (/(?:^|\/)(?:catalog-info|service-catalog)\.ya?ml$/.test(path)) {
    const name = /^\s*name:\s*([A-Za-z0-9_.-]+)\s*$/im.exec(input.content)?.[1];
    if (name) values.push({ source: "service-catalog", externalId: `${input.repository}:${name}`, name });
  }
  if (/^\.github\/workflows\/.*\.ya?ml$/.test(path)) {
    const serviceNames = new Set<string>();
    for (const match of input.content.matchAll(/\bgcloud\s+run\s+deploy\s+([A-Za-z0-9_.-]+)/gi)) {
      if (match[1]) serviceNames.add(match[1]);
    }
    for (const match of input.content.matchAll(
      /uses:\s*google-github-actions\/deploy-cloudrun@[^\n]+[\s\S]{0,800}?^\s*service:\s*["']?([A-Za-z0-9_.-]+)["']?\s*$/gim
    )) {
      if (match[1]) serviceNames.add(match[1]);
    }
    for (const name of serviceNames) values.push({ source: "cloud-run", externalId: name, name });
  }
  return dedupe(values, (value) => `${value.source}:${value.externalId}`).map((value) => ({
    tenantId: input.tenantId,
    repository: input.repository,
    kind: "service_definition",
    commitSha: input.commitSha,
    path: input.path,
    recordedAt: input.recordedAt,
    source: value.source,
    externalId: value.externalId,
    name: value.name,
    ...(value.dependsOnServices ? { dependsOnServices: value.dependsOnServices } : {})
  }));
}

/** Parses only postmortems that carry an explicit, stable incident identifier. */
export function parseIncidentDocument(input: {
  readonly tenantId: string;
  readonly repository: string;
  readonly path: string;
  readonly content: string;
  readonly recordedAt: string;
}): IncidentSourceObservation | undefined {
  if (!/(?:^|\/)(?:incidents?|postmortems?)(?:\/|[-_.])/i.test(input.path) || !/\.md(?:own)?$/i.test(input.path))
    return undefined;
  const externalId =
    /^(?:incident[-_ ]?id|id):\s*["']?([A-Za-z0-9_.-]+)["']?\s*$/im.exec(input.content)?.[1] ??
    /\b(INC(?:IDENT)?[-_ ]?\d{2,})\b/i.exec(input.content)?.[1];
  if (!externalId) return undefined;
  const title = /^#\s+(.+)$/m.exec(input.content)?.[1]?.trim() ?? externalId;
  const serviceName = /^(?:service|impacted[-_ ]?service):\s*["']?([A-Za-z0-9_.-]+)["']?\s*$/im.exec(
    input.content
  )?.[1];
  const serviceSource =
    /^service[-_ ]?source:\s*["']?([A-Za-z0-9_.-]+)["']?\s*$/im.exec(input.content)?.[1] ?? "postmortem";
  const serviceExternalId = /^service[-_ ]?external[-_ ]?id:\s*["']?([^"'\n]+)["']?\s*$/im.exec(input.content)?.[1];
  const issueNumberText = /^(?:github[-_ ]?)?issue:\s*#?(\d+)\s*$/im.exec(input.content)?.[1];
  return {
    tenantId: input.tenantId,
    repository: input.repository,
    kind: "incident",
    source: "postmortem",
    externalId: `${input.repository}:${externalId.toLowerCase().replaceAll(" ", "-")}`,
    title,
    ...(serviceName
      ? {
          impactedService: {
            source: serviceSource,
            externalId: serviceExternalId ?? `${input.repository}:${serviceName}`,
            name: serviceName
          }
        }
      : {}),
    ...(issueNumberText ? { issueNumber: Number.parseInt(issueNumberText, 10) } : {}),
    occurredAt: input.recordedAt,
    recordedAt: input.recordedAt
  };
}

export interface NormalizedGitHubObservation {
  readonly entities: readonly SourceEntityIntent[];
  readonly assertions: readonly SourceAssertionIntent[];
  readonly githubIdentity?: { readonly externalId: string; readonly entity: SourceEntityIntent };
}

/** Pure GitHub normalizer. It converts raw source records into idempotent intents and performs no I/O. */
function normalizeGitHubWorkItem(observation: GitHubWorkItemObservation): NormalizedGitHubObservation {
  const subject: SourceEntityIntent =
    observation.kind === "pull_request"
      ? {
          kind: "PullRequest",
          key: `github:pr:${observation.repository}#${observation.number}`,
          displayName: `#${observation.number} ${observation.title}`
        }
      : {
          kind: "Issue",
          key: `github:issue:${observation.repository}#${observation.number}`,
          displayName: `#${observation.number} ${observation.title}`
        };
  const entities: SourceEntityIntent[] = [subject];
  const assertions: SourceAssertionIntent[] = [];
  let githubIdentity: NormalizedGitHubObservation["githubIdentity"];
  if (observation.authorLogin) {
    const engineer: SourceEntityIntent = {
      kind: "Engineer",
      key: `github:user:${observation.authorLogin}`,
      displayName: observation.authorLogin
    };
    entities.push(engineer);
    assertions.push({
      subject,
      predicate: "AUTHORED_BY",
      object: engineer,
      explanation: `The GitHub ${observation.kind === "pull_request" ? "pull request" : "issue"} snapshot identifies ${observation.authorLogin} as the author.`
    });
    githubIdentity = { externalId: observation.authorLogin, entity: engineer };
  }
  if (observation.kind === "pull_request") {
    for (const sha of new Set(observation.commitShas ?? [])) {
      const commit: SourceEntityIntent = {
        kind: "Commit",
        key: `repo:${observation.repository}:sha:${sha}`,
        displayName: sha.slice(0, 12)
      };
      entities.push(commit);
      assertions.push({
        subject,
        predicate: "INCLUDES",
        object: commit,
        explanation: `The GitHub pull request snapshot includes commit ${sha}.`
      });
    }
    if (observation.mergedAt && observation.mergeCommitSha) {
      const mergeCommit: SourceEntityIntent = {
        kind: "Commit",
        key: `repo:${observation.repository}:sha:${observation.mergeCommitSha}`,
        displayName: observation.mergeCommitSha.slice(0, 12)
      };
      entities.push(mergeCommit);
      assertions.push({
        subject,
        predicate: "MERGED_AS",
        object: mergeCommit,
        explanation: `The merged GitHub pull request snapshot records ${observation.mergeCommitSha} as its merge commit.`
      });
    }
    const resolved = new Set(observation.resolvesIssueNumbers ?? []);
    for (const number of new Set([...(observation.referencesIssueNumbers ?? []), ...resolved])) {
      const issue: SourceEntityIntent = {
        kind: "Issue",
        key: `github:issue:${observation.repository}#${number}`,
        displayName: `Issue #${number}`
      };
      entities.push(issue);
      assertions.push({
        subject,
        predicate: resolved.has(number) ? "RESOLVES" : "REFERENCES",
        object: issue,
        explanation: resolved.has(number)
          ? `The GitHub pull request snapshot explicitly records that it resolves issue #${number}.`
          : `The GitHub pull request snapshot explicitly references issue #${number}.`
      });
    }
  }
  return {
    entities: dedupe(entities, (entity) => `${entity.kind}:${entity.key}`),
    assertions: dedupe(assertions, (item) => `${item.subject.key}:${item.predicate}:${item.object.key}`),
    ...(githubIdentity ? { githubIdentity } : {})
  };
}

function normalizeGitHubOwnership(observation: GitHubOwnershipObservation): NormalizedGitHubObservation {
  const repository: SourceEntityIntent = {
    kind: "Repository",
    key: `github:repo:${observation.repository}`,
    displayName: observation.repository
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
      assertions.push({
        subject: repository,
        predicate: "OWNED_BY",
        object: entity,
        explanation: `The CODEOWNERS rule ${entry.pattern} assigns matching repository paths to ${owner}.`,
        qualifiers: { pattern: entry.pattern }
      });
    }
  }
  return {
    entities: dedupe(entities, (entity) => `${entity.kind}:${entity.key}`),
    assertions: dedupe(
      assertions,
      (item) => `${item.subject.key}:${item.predicate}:${item.object.key}:${JSON.stringify(item.qualifiers ?? {})}`
    )
  };
}

function normalizePackageManifest(observation: PackageManifestObservation): NormalizedGitHubObservation {
  const repository: SourceEntityIntent = {
    kind: "Repository",
    key: `github:repo:${observation.repository}`,
    displayName: observation.repository
  };
  const packages = observation.dependencies.map((dependency): SourceEntityIntent => ({
    kind: "Package",
    key: `package:${observation.ecosystem.toLowerCase()}:${dependency.name.toLowerCase()}`,
    displayName: dependency.name
  }));
  return {
    entities: [repository, ...packages],
    assertions: observation.removed
      ? []
      : packages.map((dependency) => ({
          subject: repository,
          predicate: "DEPENDS_ON",
          object: dependency,
          explanation: `${observation.path} declares ${dependency.displayName} as a direct ${observation.ecosystem} dependency.`
        }))
  };
}

function normalizeServiceDefinition(observation: ServiceDefinitionObservation): NormalizedGitHubObservation {
  const service: SourceEntityIntent = {
    kind: "Service",
    key: `service:${observation.source}:${observation.externalId}`,
    displayName: observation.name
  };
  const dependencies = (observation.dependsOnServices ?? []).map((dependency): SourceEntityIntent => ({
    kind: "Service",
    key: `service:${dependency.source}:${dependency.externalId}`,
    displayName: dependency.name
  }));
  return {
    entities: [service, ...dependencies],
    assertions: observation.removed
      ? []
      : dependencies.map((dependency) => ({
          subject: service,
          predicate: "DEPENDS_ON",
          object: dependency,
          explanation: `${observation.path} declares ${service.displayName} as depending on ${dependency.displayName}.`
        }))
  };
}

function normalizeDeployment(observation: DeploymentSourceObservation): NormalizedGitHubObservation {
  const deployment: SourceEntityIntent = {
    kind: "Deployment",
    key: `deployment:${observation.source}:${observation.externalId}`,
    displayName: `${observation.environment} deployment ${observation.externalId}`
  };
  const commit: SourceEntityIntent = {
    kind: "Commit",
    key: `repo:${observation.repository}:sha:${observation.commitSha}`,
    displayName: observation.commitSha.slice(0, 12)
  };
  const service = observation.service
    ? {
        kind: "Service" as const,
        key: `service:${observation.service.source}:${observation.service.externalId}`,
        displayName: observation.service.name
      }
    : undefined;
  return {
    entities: [deployment, commit, ...(service ? [service] : [])],
    assertions: [
      {
        subject: deployment,
        predicate: "DEPLOYS" as const,
        object: commit,
        explanation: `Deployment ${observation.externalId} records commit ${observation.commitSha} for ${observation.environment}.`
      },
      ...(service
        ? [
            {
              subject: deployment,
              predicate: "TARGETS" as const,
              object: service,
              explanation: `Deployment ${observation.externalId} identifies ${service.displayName} as its target service.`
            }
          ]
        : [])
    ]
  };
}

function normalizeIncident(observation: IncidentSourceObservation): NormalizedGitHubObservation {
  const incident: SourceEntityIntent = {
    kind: "Incident",
    key: observation.issueNumber
      ? `incident:github:${observation.repository}#${observation.issueNumber}`
      : `incident:${observation.source}:${observation.externalId}`,
    displayName: observation.title
  };
  const issue = observation.issueNumber
    ? {
        kind: "Issue" as const,
        key: `github:issue:${observation.repository}#${observation.issueNumber}`,
        displayName: `Issue #${observation.issueNumber}`
      }
    : undefined;
  const service = observation.impactedService
    ? {
        kind: "Service" as const,
        key: `service:${observation.impactedService.source}:${observation.impactedService.externalId}`,
        displayName: observation.impactedService.name
      }
    : undefined;
  return {
    entities: [incident, ...(issue ? [issue] : []), ...(service ? [service] : [])],
    assertions: observation.removed
      ? []
      : [
          ...(issue
            ? [
                {
                  subject: incident,
                  predicate: "REFERENCES" as const,
                  object: issue,
                  explanation: `Incident ${observation.externalId} explicitly references Issue #${observation.issueNumber}.`
                }
              ]
            : []),
          ...(service
            ? [
                {
                  subject: incident,
                  predicate: "INCIDENT_IMPACTS" as const,
                  object: service,
                  explanation: `Incident ${observation.externalId} identifies ${service.displayName} as an impacted service.`
                }
              ]
            : [])
        ]
  };
}

function packageDependencies(
  path: string,
  source: string
):
  | {
      readonly ecosystem: string;
      readonly dependencies: readonly { readonly name: string; readonly version?: string }[];
    }
  | undefined {
  const name = path.toLowerCase().split("/").at(-1) ?? path.toLowerCase();
  const dependencies: { name: string; version?: string }[] = [];
  let ecosystem: string | undefined;
  if (name === "package.json") {
    ecosystem = "npm";
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      return { ecosystem, dependencies: [] };
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        const values = record[section];
        if (typeof values !== "object" || values === null || Array.isArray(values)) continue;
        for (const [dependency, version] of Object.entries(values)) {
          dependencies.push({ name: dependency, ...(typeof version === "string" ? { version } : {}) });
        }
      }
    }
  } else if (name === "requirements.txt") {
    ecosystem = "pypi";
    for (const line of source.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z0-9_.-]+)\s*(?:[<>=!~]+\s*([^\s;#]+))?/.exec(line);
      if (match?.[1]) dependencies.push({ name: match[1], ...(match[2] ? { version: match[2] } : {}) });
    }
  } else if (name === "pyproject.toml") {
    ecosystem = "pypi";
    const sections = source.match(/\[(?:project|tool\.poetry)\.dependencies\][\s\S]*?(?=\n\[|$)/g) ?? [];
    for (const section of sections)
      for (const match of section.matchAll(/^([A-Za-z0-9_.-]+)\s*=\s*["']([^"']+)["']/gm)) {
        if (match[1] && match[1].toLowerCase() !== "python")
          dependencies.push({ name: match[1], ...(match[2] ? { version: match[2] } : {}) });
      }
    const projectSection = /\[project\]([\s\S]*?)(?=\n\[|$)/.exec(source)?.[1] ?? "";
    const dependencyAssignment = /(?:^|\n)\s*dependencies\s*=\s*\[/m.exec(projectSection);
    const dependencyStart = dependencyAssignment ? dependencyAssignment.index + dependencyAssignment[0].length : -1;
    const dependencyEnd = dependencyStart >= 0 ? projectSection.lastIndexOf("]") : -1;
    const dependencyArray =
      dependencyEnd >= dependencyStart ? projectSection.slice(dependencyStart, dependencyEnd) : "";
    for (const match of dependencyArray.matchAll(/["']([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?\s*([^"']*)["']/g)) {
      if (!match[1]) continue;
      const version = match[2]?.trim();
      dependencies.push({ name: match[1], ...(version ? { version } : {}) });
    }
  } else if (name === "go.mod") {
    ecosystem = "go";
    for (const match of source.matchAll(/^\s*([A-Za-z0-9_.~/-]+)\s+(v[^\s]+)\s*(?:\/\/.*)?$/gm)) {
      if (match[1] && !match[1].startsWith("module"))
        dependencies.push({ name: match[1], ...(match[2] ? { version: match[2] } : {}) });
    }
  } else if (name === "cargo.toml") {
    ecosystem = "cargo";
    const section = /\[(?:dev-|build-)?dependencies\]([\s\S]*?)(?=\n\[|$)/g;
    for (const block of source.matchAll(section))
      for (const match of (block[1] ?? "").matchAll(
        /^([A-Za-z0-9_-]+)\s*=\s*(?:["']([^"']+)["']|\{[^\n]*version\s*=\s*["']([^"']+))/gm
      )) {
        if (match[1])
          dependencies.push({ name: match[1], ...((match[2] ?? match[3]) ? { version: match[2] ?? match[3] } : {}) });
      }
  } else if (name === "gemfile.lock") {
    ecosystem = "rubygems";
    for (const match of source.matchAll(/^ {4}([A-Za-z0-9_.-]+) \(([^)]+)\)$/gm))
      if (match[1]) dependencies.push({ name: match[1], ...(match[2] ? { version: match[2] } : {}) });
  } else if (name === "pom.xml") {
    ecosystem = "maven";
    for (const match of source.matchAll(
      /<dependency>[\s\S]*?<groupId>([^<]+)<\/groupId>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?(?:<version>([^<]+)<\/version>)?[\s\S]*?<\/dependency>/g
    )) {
      if (match[1] && match[2])
        dependencies.push({ name: `${match[1]}:${match[2]}`, ...(match[3] ? { version: match[3] } : {}) });
    }
  } else if (/^(?:build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?)$/.test(name)) {
    ecosystem = "maven";
    for (const match of source.matchAll(
      /(?:implementation|api|compileOnly|runtimeOnly)\s*\(?["']([^:"']+):([^:"']+)(?::([^"']+))?["']/g
    )) {
      if (match[1] && match[2])
        dependencies.push({ name: `${match[1]}:${match[2]}`, ...(match[3] ? { version: match[3] } : {}) });
    }
  } else if (["pnpm-lock.yaml", "package-lock.json", "cargo.lock"].includes(name)) {
    // Lockfiles confirm resolution but do not introduce direct dependencies;
    // their direct roots come from the paired manifest.
    ecosystem = name.startsWith("cargo") ? "cargo" : "npm";
  }
  if (!ecosystem) return undefined;
  return { ecosystem, dependencies: dedupe(dependencies, (dependency) => dependency.name.toLowerCase()) };
}

export function linkedIssueNumbers(text: string): {
  readonly resolves: readonly number[];
  readonly references: readonly number[];
} {
  const resolves = new Set<number>();
  const references = new Set<number>();
  for (const match of text.matchAll(
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#(\d+)/gi
  )) {
    if (match[1]) resolves.add(Number.parseInt(match[1], 10));
  }
  for (const match of text.matchAll(/(?:^|[^\w/])#(\d+)\b/g)) {
    if (match[1]) references.add(Number.parseInt(match[1], 10));
  }
  return { resolves: [...resolves], references: [...references].filter((number) => !resolves.has(number)) };
}

function dedupe<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => (seen.has(key(value)) ? false : (seen.add(key(value)), true)));
}
