#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  EvidenceFocusSelector,
  IngestEvidenceService,
  MemoryContextEngineStore,
  repositoryAclFingerprint
} from "../packages/context-engine/dist/index.js";
import { collectRepositoryInput } from "./context-repository-input.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIRECTORY = dirname(SCRIPT_DIRECTORY);
const OWNED_FIXTURE_ENTRIES = new Set([
  "capture-validation.json",
  "provider-capture-metadata.json",
  "provider-evidence.json",
  "repository",
  "repository-input.json"
]);
const DEFAULT_FIXTURE_ROOT = "/tmp/jina-context-fixtures";
const DEFAULT_HISTORY_LIMIT = 500;
const DEFAULT_PROVIDER_ITEM_LIMIT = 500;
const DEFAULT_PROVIDER_PAGE_LIMIT = 10;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

function usage() {
  return `Usage:
  pnpm capture:context-repository-fixture -- \\
    --repository OWNER/NAME --ref BRANCH --slug NAME [options]

Required:
  --repository OWNER/NAME      Public GitHub repository identity.
  --ref BRANCH                 Authoritative branch to capture.
  --slug NAME                  Fixture directory name.

Options:
  --fixture-root PATH          Fixture corpus root (default: /tmp/jina-context-fixtures).
  --history-limit N            Git commits to retain, 1-500 (default: 500).
  --issue-limit N              Most recently updated issues to retain, 0-500 (default: 500).
  --pull-request-limit N       Most recently updated PRs to retain, 0-500 (default: 500).
  --provider-page-limit N      Maximum pages per GitHub endpoint, 1-10 (default: 10).
  --max-file-bytes N           Maximum text blob size (default: 2097152).
  --help                       Show this help.

The Git source is always https://github.com/OWNER/NAME.git. The command resolves
the branch through git ls-remote, captures immutable Git objects at that exact
SHA, checks that the branch did not move during capture, and atomically replaces
only the selected fixture. GH_TOKEN or GITHUB_TOKEN may be supplied through the
environment for GitHub API rate limits. Tokens and request headers are never
written to fixture artifacts.
`;
}

function integer(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function normalizeRepository(value) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error("repository must have the form OWNER/NAME");
  }
  return normalized;
}

function safeRef(value) {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.startsWith("-") ||
    normalized.includes("..") ||
    normalized.includes("@{") ||
    /[\s~^:?*[\]\\]/.test(normalized)
  ) {
    throw new Error("ref must be a valid branch name");
  }
  return normalized;
}

function safeSlug(value) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalized)) {
    throw new Error("slug must contain only lowercase letters, numbers, underscores, and hyphens");
  }
  return normalized;
}

function optionValue(args, index, inlineValue, name) {
  if (inlineValue !== undefined) return { value: inlineValue, consumed: 0 };
  if (args[index + 1] === undefined) throw new Error(`${name} requires a value`);
  return { value: args[index + 1], consumed: 1 };
}

export function parseFixtureCaptureArguments(args, environment = process.env) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--help") {
      values.help = true;
      continue;
    }
    if (!argument.startsWith("--")) throw new Error(`Unexpected positional argument: ${argument}`);
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);
    const supported = new Map([
      ["--repository", "repository"],
      ["--ref", "ref"],
      ["--slug", "slug"],
      ["--fixture-root", "fixtureRoot"],
      ["--history-limit", "historyLimit"],
      ["--issue-limit", "issueLimit"],
      ["--pull-request-limit", "pullRequestLimit"],
      ["--provider-page-limit", "providerPageLimit"],
      ["--max-file-bytes", "maxFileBytes"]
    ]);
    const key = supported.get(name);
    if (!key) throw new Error(`Unknown option: ${name}`);
    const resolved = optionValue(args, index, inlineValue, name);
    values[key] = resolved.value;
    index += resolved.consumed;
  }
  if (values.help) return { help: true };
  if (!values.repository) throw new Error("--repository is required");
  if (!values.ref) throw new Error("--ref is required");
  if (!values.slug) throw new Error("--slug is required");
  const fixtureRoot = resolve(values.fixtureRoot ?? environment.CONTEXT_FIXTURE_ROOT ?? DEFAULT_FIXTURE_ROOT);
  if (fixtureRoot === "/" || fixtureRoot === resolve(WORKSPACE_DIRECTORY)) {
    throw new Error("fixture root must be a dedicated directory, not / or the workspace root");
  }
  return {
    help: false,
    repository: normalizeRepository(values.repository),
    ref: safeRef(values.ref),
    slug: safeSlug(values.slug),
    fixtureRoot,
    historyLimit: integer(values.historyLimit ?? DEFAULT_HISTORY_LIMIT, "history limit", 1, 500),
    issueLimit: integer(values.issueLimit ?? DEFAULT_PROVIDER_ITEM_LIMIT, "issue limit", 0, 500),
    pullRequestLimit: integer(values.pullRequestLimit ?? DEFAULT_PROVIDER_ITEM_LIMIT, "pull request limit", 0, 500),
    providerPageLimit: integer(values.providerPageLimit ?? DEFAULT_PROVIDER_PAGE_LIMIT, "provider page limit", 1, 10),
    maxFileBytes: integer(values.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, "max file bytes", 1, Number.MAX_SAFE_INTEGER),
    githubToken: environment.GH_TOKEN ?? environment.GITHUB_TOKEN
  };
}

async function run(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024,
    cwd: options.cwd
  });
  return stdout.trim();
}

async function git(directory, args, options) {
  return run("git", ["-C", directory, ...args], options);
}

async function authoritativeHead(remoteUrl, ref) {
  const output = await run("git", ["ls-remote", "--exit-code", "--refs", remoteUrl, `refs/heads/${ref}`]);
  const rows = output.split(/\r?\n/).filter(Boolean);
  if (rows.length !== 1) throw new Error(`Expected exactly one authoritative head for ${ref}`);
  const [sha, remoteRef] = rows[0].split(/\s+/);
  if (!/^[0-9a-f]{40}$/i.test(sha) || remoteRef !== `refs/heads/${ref}`) {
    throw new Error(`Invalid authoritative head response for ${ref}`);
  }
  return sha.toLowerCase();
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "jina-context-representative-fixture",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

async function githubJson(url, { token, fetchImpl }) {
  const response = await fetchImpl(url, { headers: githubHeaders(token) });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`GitHub API ${response.status} for ${new URL(url).pathname}: ${body}`);
  }
  return {
    value: await response.json(),
    metadata: {
      url: new URL(url).toString(),
      records: undefined,
      etag: response.headers.get("etag"),
      link: response.headers.get("link")
    },
    rateLimit: {
      limit: response.headers.get("x-ratelimit-limit"),
      remaining: response.headers.get("x-ratelimit-remaining")
    }
  };
}

function hasNextPage(link) {
  return typeof link === "string" && /(?:^|,)\s*<[^>]+>;\s*rel="next"(?:,|$)/.test(link);
}

async function boundedGithubCollection({ endpoint, itemLimit, pageLimit, token, fetchImpl }) {
  if (itemLimit === 0) {
    return { records: [], pages: [], frontierExhausted: false, rateLimit: undefined };
  }
  const perPage = Math.min(100, Math.max(1, itemLimit));
  const records = [];
  const pages = [];
  let frontierExhausted = false;
  let rateLimit;
  for (let page = 1; page <= pageLimit; page += 1) {
    const url = new URL(endpoint);
    url.searchParams.set("state", "all");
    url.searchParams.set("sort", "updated");
    url.searchParams.set("direction", "desc");
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));
    const result = await githubJson(url, { token, fetchImpl });
    if (!Array.isArray(result.value)) throw new Error(`GitHub collection response was not an array: ${url.pathname}`);
    records.push(...result.value);
    pages.push({ ...result.metadata, records: result.value.length });
    rateLimit = result.rateLimit;
    const next = hasNextPage(result.metadata.link);
    if (!next) {
      frontierExhausted = true;
      break;
    }
  }
  return { records, pages, frontierExhausted, rateLimit };
}

function actor(value) {
  return value && typeof value.login === "string" ? { login: value.login } : null;
}

function labels(value) {
  return Array.isArray(value)
    ? value.flatMap((item) =>
        typeof item === "string"
          ? [{ name: item }]
          : item && typeof item.name === "string"
            ? [{ name: item.name, ...(item.color ? { color: item.color } : {}) }]
            : []
      )
    : [];
}

export function sanitizeRepositoryPayload(value) {
  return {
    id: value.id,
    full_name: value.full_name,
    html_url: value.html_url,
    description: value.description,
    private: value.private,
    visibility: value.visibility,
    archived: value.archived,
    disabled: value.disabled,
    default_branch: value.default_branch,
    language: value.language,
    size: value.size,
    open_issues_count: value.open_issues_count,
    stargazers_count: value.stargazers_count,
    forks_count: value.forks_count,
    topics: Array.isArray(value.topics) ? value.topics : [],
    license: value.license?.spdx_id ? { spdx_id: value.license.spdx_id } : null,
    created_at: value.created_at,
    updated_at: value.updated_at,
    pushed_at: value.pushed_at
  };
}

export function sanitizeIssuePayload(value) {
  return {
    number: value.number,
    title: value.title,
    body: value.body,
    state: value.state,
    state_reason: value.state_reason,
    locked: value.locked,
    user: actor(value.user),
    assignees: Array.isArray(value.assignees) ? value.assignees.map(actor).filter(Boolean) : [],
    labels: labels(value.labels),
    milestone: value.milestone?.title ? { title: value.milestone.title } : null,
    comments: value.comments,
    created_at: value.created_at,
    updated_at: value.updated_at,
    closed_at: value.closed_at,
    closed_by: actor(value.closed_by),
    html_url: value.html_url
  };
}

function branch(value) {
  if (!value || typeof value !== "object") return null;
  return {
    ref: value.ref,
    sha: value.sha,
    repository: value.repo?.full_name
  };
}

export function sanitizePullRequestPayload(value) {
  return {
    number: value.number,
    title: value.title,
    body: value.body,
    state: value.state,
    draft: value.draft,
    locked: value.locked,
    user: actor(value.user),
    assignees: Array.isArray(value.assignees) ? value.assignees.map(actor).filter(Boolean) : [],
    requested_reviewers: Array.isArray(value.requested_reviewers)
      ? value.requested_reviewers.map(actor).filter(Boolean)
      : [],
    labels: labels(value.labels),
    milestone: value.milestone?.title ? { title: value.milestone.title } : null,
    head: branch(value.head),
    base: branch(value.base),
    merge_commit_sha: value.merge_commit_sha,
    created_at: value.created_at,
    updated_at: value.updated_at,
    closed_at: value.closed_at,
    merged_at: value.merged_at,
    html_url: value.html_url
  };
}

function providerObservation(repository, sourceType, payload, capturedAt) {
  const kind = sourceType === "pull_request" ? "pull_request" : "issue";
  const number = payload.number;
  return {
    sourceType,
    sourceId: `github:${kind}:${repository}#${number}`,
    title: payload.title,
    payload,
    pathOrUrl: payload.html_url,
    observedAt: payload.updated_at ?? payload.created_at ?? capturedAt,
    metadata: {
      provider: "github",
      number,
      capturedAt
    }
  };
}

export async function captureGithubProviderHistory({
  repository,
  issueLimit = DEFAULT_PROVIDER_ITEM_LIMIT,
  pullRequestLimit = DEFAULT_PROVIDER_ITEM_LIMIT,
  pageLimit = DEFAULT_PROVIDER_PAGE_LIMIT,
  token,
  fetchImpl = fetch,
  capturedAt = new Date().toISOString()
}) {
  const apiRoot = `https://api.github.com/repos/${repository}`;
  const repositoryResult = await githubJson(apiRoot, { token, fetchImpl });
  if (!repositoryResult.value || Array.isArray(repositoryResult.value)) {
    throw new Error("GitHub repository response was not an object");
  }
  if (repositoryResult.value.private === true) {
    throw new Error("Representative fixture capture only supports public repositories");
  }
  const [issuesResult, pullsResult] = await Promise.all([
    boundedGithubCollection({
      endpoint: `${apiRoot}/issues`,
      itemLimit: issueLimit,
      pageLimit,
      token,
      fetchImpl
    }),
    boundedGithubCollection({
      endpoint: `${apiRoot}/pulls`,
      itemLimit: pullRequestLimit,
      pageLimit,
      token,
      fetchImpl
    })
  ]);
  const retainedIssues = issuesResult.records
    .filter((item) => item && !item.pull_request)
    .slice(0, issueLimit)
    .map(sanitizeIssuePayload);
  const retainedPullRequests = pullsResult.records
    .filter(Boolean)
    .slice(0, pullRequestLimit)
    .map(sanitizePullRequestPayload);
  const repositoryPayload = sanitizeRepositoryPayload(repositoryResult.value);
  const observations = [
    {
      sourceType: "observation",
      sourceId: `github:repository:${repository}`,
      title: repository,
      payload: repositoryPayload,
      pathOrUrl: `https://github.com/${repository}`,
      observedAt: capturedAt,
      metadata: {
        provider: "github",
        kind: "repository",
        capturedAt
      }
    },
    ...retainedIssues.map((payload) => providerObservation(repository, "issue", payload, capturedAt)),
    ...retainedPullRequests.map((payload) => providerObservation(repository, "pull_request", payload, capturedAt))
  ];
  return {
    evidence: { capturedAt, repository, observations },
    metadata: {
      capturedAt,
      repository,
      repositoryMetadata: {
        id: repositoryPayload.id,
        defaultBranch: repositoryPayload.default_branch,
        visibility: repositoryPayload.visibility,
        archived: repositoryPayload.archived,
        disabled: repositoryPayload.disabled,
        primaryLanguage: repositoryPayload.language,
        sizeKiB: repositoryPayload.size,
        openIssuesIncludingPullRequests: repositoryPayload.open_issues_count,
        pushedAt: repositoryPayload.pushed_at,
        updatedAt: repositoryPayload.updated_at,
        htmlUrl: repositoryPayload.html_url
      },
      capture: {
        bounds: {
          issueLimit,
          pullRequestLimit,
          pageLimit,
          recordsPerPageMaximum: 100
        },
        issuesEndpointRecords: issuesResult.records.length,
        retainedIssues: retainedIssues.length,
        issueRecordsThatWerePullRequests: issuesResult.records.filter((item) => item?.pull_request).length,
        retainedPullRequests: retainedPullRequests.length,
        issuesPages: issuesResult.pages,
        pullsPages: pullsResult.pages,
        issuesFrontierExhausted: issuesResult.frontierExhausted,
        pullsFrontierExhausted: pullsResult.frontierExhausted,
        commentsRetained: false,
        repositoryEtag: repositoryResult.metadata.etag,
        authenticationSource: token ? "environment" : "anonymous",
        rateLimit: {
          limit: pullsResult.rateLimit?.limit ?? issuesResult.rateLimit?.limit ?? repositoryResult.rateLimit.limit,
          remainingAfterCapture:
            pullsResult.rateLimit?.remaining ??
            issuesResult.rateLimit?.remaining ??
            repositoryResult.rateLimit.remaining
        }
      }
    }
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function versionedSourceStats(repositoryDirectory, collected) {
  const raw = await git(repositoryDirectory, ["ls-tree", "-r", "-z", "-l", "--full-tree", "HEAD"]);
  const records = raw
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^[0-9]{6} (?:blob|commit) [0-9a-f]{40} +(-|[0-9]+)\t([\s\S]+)$/.exec(line);
      if (!match) throw new Error(`Unsupported ls-tree record: ${line.slice(0, 200)}`);
      return { size: match[1] === "-" ? 0 : Number(match[1]), path: match[2] };
    });
  const captured = collected.files.filter((file) => file.contentOmitted !== true && file.entryType === undefined);
  const languages = new Map();
  for (const file of captured) {
    if (!file.language) continue;
    const current = languages.get(file.language) ?? { language: file.language, files: 0, capturedBytes: 0 };
    current.files += 1;
    current.capturedBytes += Buffer.byteLength(file.body);
    languages.set(file.language, current);
  }
  const omittedPaths = collected.files
    .filter((file) => file.contentOmitted === true || file.entryType !== undefined)
    .map((file) => file.path)
    .sort();
  return {
    gitTreeEntries: records.length,
    regularFiles: collected.files.length,
    regularBytes: records.reduce((total, record) => total + record.size, 0),
    capturedTextFiles: captured.length,
    capturedTextBytes: captured.reduce((total, file) => total + Buffer.byteLength(file.body), 0),
    omittedFiles: omittedPaths.length,
    omittedPaths,
    recognizedLanguages: [...languages.values()].sort(
      (left, right) => right.files - left.files || left.language.localeCompare(right.language)
    )
  };
}

async function validateFixture({
  repository,
  ref,
  commitSha,
  collected,
  observations,
  createdAt,
  providerComplete,
  historyComplete
}) {
  const tenantId = `fixture-${repository.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  const store = new MemoryContextEngineStore();
  const checkpoint = await new IngestEvidenceService(store).ingest({
    tenantId,
    repository,
    ref,
    refSequence: 1,
    commitSha,
    files: collected.files,
    observations,
    aclFingerprint: repositoryAclFingerprint(tenantId, repository),
    observationFrontier: JSON.stringify({
      source: "bounded-github-provider-capture",
      records: observations.length
    }),
    createdAt,
    sourceComplete: collected.files.every((file) => file.contentOmitted !== true && file.entryType === undefined),
    git: collected.git
  });
  await new EvidenceFocusSelector(store).select(checkpoint.id);
  const manifest = await store.listManifest(checkpoint.id);
  const evidence = await store.listEvidence(checkpoint.id);
  const providerByType = Object.fromEntries(
    ["issue", "observation", "pull_request"].map((sourceType) => [
      sourceType,
      observations.filter((item) => item.sourceType === sourceType).length
    ])
  );
  return {
    status: "passed",
    repository,
    ref,
    commitSha,
    checkpointId: checkpoint.id,
    manifestEntries: manifest.length,
    evidenceRecords: evidence.length,
    providerObservations: observations.length,
    providerByType,
    gitHistoryRecords: collected.git.history.length,
    historyComplete,
    providerComplete,
    omittedFiles: manifest.filter((entry) => !entry.contentAvailable).length,
    sourceCompleteness: checkpoint.sourceCompleteness,
    validatedAt: new Date().toISOString()
  };
}

async function assertFixtureDirectoryOwned(path) {
  try {
    const entries = await readdir(path);
    const unexpected = entries.filter((entry) => !OWNED_FIXTURE_ENTRIES.has(entry));
    if (unexpected.length > 0) {
      throw new Error(
        `Refusing to replace ${path}; unowned entries would be orphaned: ${unexpected.sort().join(", ")}`
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function readManifest(path, fixtureRoot) {
  try {
    const manifest = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(manifest.fixtures)) throw new Error("fixture manifest must contain a fixtures array");
    return manifest;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      root: fixtureRoot,
      selectionPolicy: "Representative repositories captured at exact authoritative branch heads.",
      inputCapture: {
        immutableSource: "Git objects at the exact detached commit",
        historyLimit: DEFAULT_HISTORY_LIMIT,
        providerPolicy:
          "Bounded GitHub repository metadata and most recently updated issues and pull requests. Comments are excluded.",
        privateData: false
      },
      fixtures: []
    };
  }
}

async function commitFixture({ fixtureRoot, slug, stagedFixture, manifest, entry }) {
  const fixturePath = join(fixtureRoot, slug);
  const backupPath = join(fixtureRoot, `.${slug}-backup-${process.pid}-${Date.now()}`);
  const manifestPath = join(fixtureRoot, "manifest.json");
  const stagedManifestPath = join(fixtureRoot, `.manifest-${process.pid}-${Date.now()}.json`);
  let backedUp = false;
  let installed = false;
  try {
    try {
      await stat(fixturePath);
      await rename(fixturePath, backupPath);
      backedUp = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(stagedFixture, fixturePath);
    installed = true;
    const fixtures = manifest.fixtures
      .filter((fixture) => fixture.slug !== slug && fixture.repository.toLowerCase() !== entry.repository.toLowerCase())
      .concat(entry)
      .sort((left, right) => left.slug.localeCompare(right.slug));
    await writeJson(stagedManifestPath, {
      ...manifest,
      generatedAt: new Date().toISOString(),
      root: fixtureRoot,
      inputCapture: {
        ...(manifest.inputCapture ?? {}),
        immutableSource: "Git objects at the exact detached commit",
        historyLimit: entry.gitHistory.historyLimit,
        providerPolicy:
          "Bounded GitHub repository metadata and most recently updated issues and pull requests. Pull requests are filtered from the combined issues endpoint; comments are excluded.",
        privateData: false,
        captureCommand: `pnpm capture:context-repository-fixture -- --repository ${entry.repository} --ref ${entry.defaultBranch} --slug ${entry.slug}`
      },
      fixtures
    });
    await rename(stagedManifestPath, manifestPath);
    if (backedUp) {
      await rm(backupPath, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch (error) {
    await rm(stagedManifestPath, { force: true });
    if (installed) await rm(fixturePath, { recursive: true, force: true });
    if (backedUp) await rename(backupPath, fixturePath);
    throw error;
  }
}

export async function captureRepresentativeFixture(
  options,
  {
    fetchImpl = fetch,
    remoteUrl = `https://github.com/${options.repository}.git`,
    resolveHead = authoritativeHead
  } = {}
) {
  await mkdir(options.fixtureRoot, { recursive: true });
  const fixturePath = join(options.fixtureRoot, options.slug);
  await assertFixtureDirectoryOwned(fixturePath);
  const manifestPath = join(options.fixtureRoot, "manifest.json");
  const manifest = await readManifest(manifestPath, options.fixtureRoot);
  const previous = manifest.fixtures.find(
    (fixture) => fixture.slug === options.slug || fixture.repository.toLowerCase() === options.repository.toLowerCase()
  );
  const authoritativeCommit = await resolveHead(remoteUrl, options.ref);
  const stagingRoot = await mkdtemp(join(options.fixtureRoot, `.${options.slug}-capture-`));
  const stagedFixture = join(stagingRoot, options.slug);
  const repositoryDirectory = join(stagedFixture, "repository");
  await mkdir(stagedFixture);
  try {
    await run("git", [
      "clone",
      "--quiet",
      "--filter=blob:none",
      "--no-checkout",
      "--single-branch",
      "--branch",
      options.ref,
      remoteUrl,
      repositoryDirectory
    ]);
    const clonedHead = (
      await git(repositoryDirectory, ["rev-parse", `refs/remotes/origin/${options.ref}`])
    ).toLowerCase();
    if (clonedHead !== authoritativeCommit) {
      throw new Error(
        `Authoritative branch moved during clone: expected ${authoritativeCommit}, cloned ${clonedHead}; rerun capture`
      );
    }
    await git(repositoryDirectory, ["checkout", "--quiet", "--detach", authoritativeCommit]);
    await git(repositoryDirectory, ["remote", "set-url", "origin", remoteUrl]);
    if ((await git(repositoryDirectory, ["status", "--porcelain"])) !== "") {
      throw new Error("Pinned fixture checkout is not clean");
    }
    const capturedAt = new Date().toISOString();
    const [collected, provider, totalCommitsReachable] = await Promise.all([
      collectRepositoryInput({
        repositoryDirectory,
        commitSha: authoritativeCommit,
        historyLimit: options.historyLimit,
        maxFileBytes: options.maxFileBytes
      }),
      captureGithubProviderHistory({
        repository: options.repository,
        issueLimit: options.issueLimit,
        pullRequestLimit: options.pullRequestLimit,
        pageLimit: options.providerPageLimit,
        token: options.githubToken,
        fetchImpl,
        capturedAt
      }),
      git(repositoryDirectory, ["rev-list", "--count", authoritativeCommit]).then(Number)
    ]);
    if (provider.metadata.repositoryMetadata.defaultBranch !== options.ref) {
      throw new Error(
        `Requested ref ${options.ref} is not GitHub's default branch ${provider.metadata.repositoryMetadata.defaultBranch}`
      );
    }
    const historyComplete = totalCommitsReachable <= options.historyLimit;
    const providerComplete =
      provider.metadata.capture.issuesFrontierExhausted && provider.metadata.capture.pullsFrontierExhausted;
    const validation = await validateFixture({
      repository: options.repository,
      ref: options.ref,
      commitSha: authoritativeCommit,
      collected,
      observations: provider.evidence.observations,
      createdAt: capturedAt,
      providerComplete,
      historyComplete
    });
    const repositoryInputPath = join(stagedFixture, "repository-input.json");
    const providerEvidencePath = join(stagedFixture, "provider-evidence.json");
    const providerMetadataPath = join(stagedFixture, "provider-capture-metadata.json");
    const validationPath = join(stagedFixture, "capture-validation.json");
    await Promise.all([
      writeJson(repositoryInputPath, {
        capturedAt,
        commitSha: authoritativeCommit,
        files: collected.files,
        git: collected.git
      }),
      writeJson(providerEvidencePath, provider.evidence),
      writeJson(providerMetadataPath, provider.metadata),
      writeJson(validationPath, validation)
    ]);
    const finalHead = await resolveHead(remoteUrl, options.ref);
    if (finalHead !== authoritativeCommit) {
      throw new Error(
        `Authoritative branch moved during capture: expected ${authoritativeCommit}, now ${finalHead}; rerun capture`
      );
    }
    const sourceSnapshot = await versionedSourceStats(repositoryDirectory, collected);
    const finalRoot = join(options.fixtureRoot, options.slug);
    const entry = {
      slug: options.slug,
      repository: options.repository,
      repositoryUrl: `https://github.com/${options.repository}`,
      defaultBranch: options.ref,
      commit: {
        sha: authoritativeCommit,
        committedAt: collected.git.commit.committedAt,
        subject: collected.git.commit.message.split(/\r?\n/, 1)[0]
      },
      paths: {
        root: finalRoot,
        repositoryDirectory: join(finalRoot, "repository"),
        repositoryInput: join(finalRoot, "repository-input.json"),
        providerEvidence: join(finalRoot, "provider-evidence.json"),
        providerCaptureMetadata: join(finalRoot, "provider-capture-metadata.json"),
        captureValidation: join(finalRoot, "capture-validation.json")
      },
      gitHistory: {
        available: true,
        totalCommitsReachable,
        capturedCommits: collected.git.history.length,
        historyLimit: options.historyLimit,
        complete: historyComplete
      },
      sourceSnapshot,
      providerHistory: {
        capturedAt,
        issues: {
          available: options.issueLimit > 0,
          retained: provider.metadata.capture.retainedIssues,
          combinedEndpointRecords: provider.metadata.capture.issuesEndpointRecords,
          pagesFetched: provider.metadata.capture.issuesPages.length,
          limit: options.issueLimit,
          frontierExhausted: provider.metadata.capture.issuesFrontierExhausted
        },
        pullRequests: {
          available: options.pullRequestLimit > 0,
          retained: provider.metadata.capture.retainedPullRequests,
          pagesFetched: provider.metadata.capture.pullsPages.length,
          limit: options.pullRequestLimit,
          frontierExhausted: provider.metadata.capture.pullsFrontierExhausted
        },
        repositoryObservationRetained: true,
        commentsRetained: false,
        complete: providerComplete
      },
      ...(previous?.buildShape ? { buildShape: previous.buildShape } : {}),
      ...(previous?.complementarity ? { complementarity: previous.complementarity } : {}),
      validation,
      sha256: {
        repositoryInput: await sha256(repositoryInputPath),
        providerEvidence: await sha256(providerEvidencePath),
        providerCaptureMetadata: await sha256(providerMetadataPath),
        captureValidation: await sha256(validationPath)
      }
    };
    await commitFixture({
      fixtureRoot: options.fixtureRoot,
      slug: options.slug,
      stagedFixture,
      manifest,
      entry
    });
    return entry;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const options = parseFixtureCaptureArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
      return;
    }
    const entry = await captureRepresentativeFixture(options);
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "passed",
          repository: entry.repository,
          ref: entry.defaultBranch,
          commitSha: entry.commit.sha,
          fixture: entry.paths.root,
          files: entry.sourceSnapshot.gitTreeEntries,
          commits: entry.gitHistory.capturedCommits,
          issues: entry.providerHistory.issues.retained,
          pullRequests: entry.providerHistory.pullRequests.retained,
          providerComplete: entry.providerHistory.complete
        },
        null,
        2
      )}\n`
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
