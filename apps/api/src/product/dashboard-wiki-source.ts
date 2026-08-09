import { createGitHubInstallationAccessToken } from "@jina/github";

import { ApiError } from "./errors.js";

const gitShaPattern = /^[0-9a-f]{40}$/iu;
const pullRequestRefPattern = /^refs\/pull\/([1-9][0-9]*)\/head$/u;
const commitRefPattern = /^refs\/commits\/([0-9a-f]{40})$/iu;
const maximumRefLength = 512;

type DashboardWikiSource =
  | {
      readonly scopeKind: "branch";
      readonly ref: string;
      readonly commitSha: string;
    }
  | {
      readonly scopeKind: "pull_request";
      readonly ref: string;
      readonly pullRequest: number;
      readonly commitSha: string;
      readonly baseCommitSha: string;
    }
  | {
      readonly scopeKind: "commit";
      readonly ref: string;
      readonly commitSha: string;
    };

interface DashboardWikiSourceInput {
  readonly installationId: number;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly ref?: string;
  readonly commitSha?: string;
}

export type DashboardWikiSourceResolver = (
  input: DashboardWikiSourceInput,
) => Promise<DashboardWikiSource>;

export interface DashboardWikiSourceDependencies {
  readonly fetchImpl?: typeof fetch;
  readonly tokenFactory?: (
    installationId: number,
    repository: string,
  ) => Promise<string>;
}

/**
 * Resolve a dashboard selection into the immutable source contract accepted by
 * `/wiki/build`. Mutable refs are resolved with a repository-restricted GitHub
 * App installation token; an explicit SHA is reused only when its scope is
 * unambiguous from the caller's ref.
 */
export function createDashboardWikiSourceResolver(
  dependencies: DashboardWikiSourceDependencies = {},
): DashboardWikiSourceResolver {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const tokenFactory =
    dependencies.tokenFactory ??
    (async (installationId: number, repository: string) =>
      (
        await createGitHubInstallationAccessToken(installationId, {
          repository,
          fetchImpl,
        })
      ).token);

  return async (input) => {
    const repository = parsedRepository(input.repository);
    const explicitCommitSha = input.commitSha
      ? gitSha(input.commitSha, "commitSha")
      : undefined;
    const selectedRef = input.ref?.trim();

    // With no ref, commitSha alone denotes a commit build. Without commitSha,
    // the repository's authoritative default branch is the mutable selection.
    if (!selectedRef && explicitCommitSha) {
      return commitSource(explicitCommitSha);
    }

    const parsed = parseDashboardWikiRef(
      selectedRef || `refs/heads/${input.defaultBranch}`,
    );
    if (parsed.scopeKind === "commit") {
      if (explicitCommitSha && explicitCommitSha !== parsed.commitSha) {
        throw new ApiError(400, "wiki source commit does not match its ref");
      }
      return commitSource(parsed.commitSha);
    }

    const token = await repositoryToken(
      input.installationId,
      repository.fullName,
      tokenFactory,
    );
    if (parsed.scopeKind === "pull_request") {
      const pullRequest = await githubJson(
        fetchImpl,
        token,
        `/repos/${repository.encoded}/pulls/${parsed.pullRequest}`,
      );
      const headSha = responseSha(pullRequest, ["head", "sha"]);
      const baseSha = responseSha(pullRequest, ["base", "sha"]);
      if (explicitCommitSha && explicitCommitSha !== headSha) {
        throw new ApiError(409, "pull request head changed; refresh and retry");
      }
      return {
        scopeKind: "pull_request",
        ref: `refs/pull/${parsed.pullRequest}/head`,
        pullRequest: parsed.pullRequest,
        commitSha: headSha,
        baseCommitSha: baseSha,
      };
    }

    const commit = await githubJson(
      fetchImpl,
      token,
      `/repos/${repository.encoded}/commits/${encodeURIComponent(parsed.branch)}`,
    );
    const resolvedCommitSha = responseSha(commit, ["sha"]);
    if (explicitCommitSha && explicitCommitSha !== resolvedCommitSha) {
      throw new ApiError(409, "branch head changed; refresh and retry");
    }
    return {
      scopeKind: "branch",
      ref: `refs/heads/${parsed.branch}`,
      commitSha: resolvedCommitSha,
    };
  };
}

type ParsedDashboardWikiRef =
  | { readonly scopeKind: "branch"; readonly branch: string }
  | { readonly scopeKind: "pull_request"; readonly pullRequest: number }
  | { readonly scopeKind: "commit"; readonly commitSha: string };

export function parseDashboardWikiRef(value: string): ParsedDashboardWikiRef {
  const ref = value.trim();
  if (!ref || ref.length > maximumRefLength || hasAsciiControl(ref)) {
    throw new ApiError(400, "wiki source ref is invalid");
  }
  const commit = commitRefPattern.exec(ref);
  if (commit) {
    return { scopeKind: "commit", commitSha: commit[1].toLowerCase() };
  }
  const pullRequest = pullRequestRefPattern.exec(ref);
  if (pullRequest) {
    const number = Number(pullRequest[1]);
    if (!Number.isSafeInteger(number)) {
      throw new ApiError(400, "wiki pull request ref is invalid");
    }
    return { scopeKind: "pull_request", pullRequest: number };
  }
  if (ref.startsWith("refs/") && !ref.startsWith("refs/heads/")) {
    throw new ApiError(400, "wiki source ref is not supported");
  }
  const branch = ref.replace(/^refs\/heads\//u, "");
  if (!validBranch(branch)) {
    throw new ApiError(400, "wiki branch ref is invalid");
  }
  return { scopeKind: "branch", branch };
}

function validBranch(branch: string): boolean {
  return !(
    !branch ||
    branch.length > maximumRefLength ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{") ||
    hasAsciiControl(branch, true) ||
    /[~^:?*[\\]/u.test(branch) ||
    branch.split("/").some((component) =>
      component.startsWith(".") || component.endsWith(".lock")
    )
  );
}

function hasAsciiControl(value: string, includeSpace = false): boolean {
  const upperBound = includeSpace ? 32 : 31;
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= upperBound || codePoint === 127);
  });
}

function parsedRepository(repository: string): {
  readonly fullName: string;
  readonly encoded: string;
} {
  const parts = repository.trim().split("/");
  if (
    parts.length !== 2 ||
    parts.some(
      (part) =>
        !part ||
        part.length > 100 ||
        part === "." ||
        part === ".." ||
        !/^[a-z0-9_.-]+$/iu.test(part),
    )
  ) {
    throw new ApiError(400, "wiki repository is invalid");
  }
  return {
    fullName: parts.join("/").toLowerCase(),
    encoded: parts.map((part) => encodeURIComponent(part)).join("/"),
  };
}

function gitSha(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!gitShaPattern.test(normalized)) {
    throw new ApiError(400, `${label} must be a full Git commit SHA`);
  }
  return normalized;
}

function commitSource(commitSha: string): DashboardWikiSource {
  return {
    scopeKind: "commit",
    ref: `refs/commits/${commitSha}`,
    commitSha,
  };
}

async function repositoryToken(
  installationId: number,
  repository: string,
  tokenFactory: NonNullable<DashboardWikiSourceDependencies["tokenFactory"]>,
): Promise<string> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new ApiError(409, "GitHub installation is required to resolve a wiki source");
  }
  try {
    const token = await tokenFactory(installationId, repository);
    if (!token) throw new Error("empty token");
    return token;
  } catch {
    throw new ApiError(502, "GitHub source resolution is unavailable");
  }
}

async function githubJson(
  fetchImpl: typeof fetch,
  token: string,
  path: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.github.com${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "jina-code-review",
        "x-github-api-version": "2022-11-28",
      },
    });
  } catch {
    throw new ApiError(502, "GitHub source resolution is unavailable");
  }
  if (!response.ok) {
    throw new ApiError(
      response.status === 404 || response.status === 422 ? 400 : 502,
      response.status === 404 || response.status === 422
        ? "selected GitHub source could not be resolved"
        : "GitHub source resolution is unavailable",
    );
  }
  const body = (await response.json().catch(() => undefined)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(502, "GitHub source response was invalid");
  }
  return body as Record<string, unknown>;
}

function responseSha(
  body: Record<string, unknown>,
  path: readonly string[],
): string {
  let value: unknown = body;
  for (const segment of path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ApiError(502, "GitHub source response was invalid");
    }
    value = (value as Record<string, unknown>)[segment];
  }
  if (typeof value !== "string" || !gitShaPattern.test(value.trim())) {
    throw new ApiError(502, "GitHub source response was invalid");
  }
  return value.trim().toLowerCase();
}
