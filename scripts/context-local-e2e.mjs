#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApiServer } from "../apps/api/dist/server.js";
import {
  ContextCatalogService,
  DeriveKnowledgeService,
  EvidenceFocusSelector,
  IndexContextService,
  IngestEvidenceService,
  KnowledgeOutputValidator,
  LocalPageIndexClient,
  MemoryContextEngineStore,
  PageIndexHierarchyAdapter,
  buildKnowledgeFilePrompt,
  buildKnowledgeRepairPrompt,
  repositoryAclFingerprint,
  selectPriorKnowledge
} from "../packages/context-engine/dist/index.js";
import { LocalCodexKnowledgeDocumentGenerator } from "../packages/daytona/dist/index.js";

const execFileAsync = promisify(execFile);
const TENANT = "tenant-local-e2e";
const PRINCIPAL = "user:local-e2e@example.com";
const REPOSITORY = "acme/context-sample";
const REF = "main";
const CONTEXT_TOKEN = "local-e2e-context-token";

process.env.CONTEXT_DERIVE_DOCUMENT_FILES = "true";
process.env.CONTEXT_CODEX_MODEL = process.env.CONTEXT_CODEX_MODEL?.trim() || "gpt-5.6-terra";
process.env.CONTEXT_CODEX_EFFORT = process.env.CONTEXT_CODEX_EFFORT?.trim() || "low";
process.env.CONTEXT_CODEX_AUTH = process.env.CONTEXT_CODEX_AUTH?.trim() || "session";

function iso(sequence) {
  return `2026-07-29T12:${String(sequence).padStart(2, "0")}:00.000Z`;
}

async function git(directory, args) {
  const { stdout } = await execFileAsync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout.trim();
}

async function put(directory, path, body) {
  await mkdir(join(directory, path.split("/").slice(0, -1).join("/")), { recursive: true });
  await writeFile(join(directory, path), body);
}

async function commit(directory, message) {
  await git(directory, ["add", "."]);
  await git(directory, [
    "-c",
    "user.name=Context E2E",
    "-c",
    "user.email=context-e2e@example.com",
    "commit",
    "-m",
    message
  ]);
  return git(directory, ["rev-parse", "HEAD"]);
}

async function filesAt(directory, commitSha) {
  const paths = (await git(directory, ["ls-tree", "-r", "--name-only", commitSha])).split("\n").filter(Boolean);
  return Promise.all(
    paths.map(async (path) => ({
      path,
      blobSha: await git(directory, ["rev-parse", `${commitSha}:${path}`]),
      body: await git(directory, ["show", `${commitSha}:${path}`]),
      language: path.endsWith(".ts") ? "typescript" : path.endsWith(".md") ? "markdown" : "text"
    }))
  );
}

async function commitMetadata(directory, sha) {
  const [treeSha, parentLine, author, authoredAt, committedAt, message] = await Promise.all([
    git(directory, ["show", "-s", "--format=%T", sha]),
    git(directory, ["show", "-s", "--format=%P", sha]),
    git(directory, ["show", "-s", "--format=%an", sha]),
    git(directory, ["show", "-s", "--format=%aI", sha]),
    git(directory, ["show", "-s", "--format=%cI", sha]),
    git(directory, ["show", "-s", "--format=%B", sha])
  ]);
  return {
    treeSha,
    parentShas: parentLine ? parentLine.split(" ") : [],
    author,
    authoredAt,
    committedAt,
    message
  };
}

async function gitSnapshot(directory, commitSha) {
  const commit = await commitMetadata(directory, commitSha);
  const currentFiles = new Map((await filesAt(directory, commitSha)).map((file) => [file.path, file.blobSha]));
  const priorFiles =
    commit.parentShas.length === 0
      ? new Map()
      : new Map((await filesAt(directory, commit.parentShas[0])).map((file) => [file.path, file.blobSha]));
  const paths = [...new Set([...currentFiles.keys(), ...priorFiles.keys()])].sort();
  const changes = paths.flatMap((path) => {
    const oldBlobSha = priorFiles.get(path);
    const newBlobSha = currentFiles.get(path);
    if (oldBlobSha === newBlobSha) return [];
    if (oldBlobSha === undefined) return [{ kind: "add", path, newBlobSha }];
    if (newBlobSha === undefined) return [{ kind: "delete", path, oldBlobSha }];
    return [{ kind: "modify", path, oldBlobSha, newBlobSha }];
  });
  const historyShas = (await git(directory, ["rev-list", "--max-count=20", commitSha])).split("\n").filter(Boolean);
  const history = await Promise.all(
    historyShas.map(async (sha) => ({
      sha,
      ...(await commitMetadata(directory, sha))
    }))
  );
  return { commit, changes, history };
}

function observations(sequence) {
  const base = [
    {
      sourceType: "issue",
      sourceId: "github:acme/context-sample:issue:1",
      title: "Issue #1: stale entries survive past lease expiry",
      pathOrUrl: "https://github.com/acme/context-sample/issues/1",
      observedAt: iso(sequence),
      payload: {
        number: 1,
        title: "Stale entries survive past lease expiry",
        body: "Expired cache entries must be removed before a lookup returns.",
        state: "closed"
      }
    }
  ];
  if (sequence === 1) return base;
  return [
    ...base,
    {
      sourceType: "pull_request",
      sourceId: "github:acme/context-sample:pull:7",
      title: "PR #7: add cache hit metrics",
      pathOrUrl: "https://github.com/acme/context-sample/pull/7",
      observedAt: iso(sequence),
      payload: {
        number: 7,
        title: "Add cache hit metrics",
        body: "Record cache hits and misses so operators can detect expiry regressions.",
        state: "open",
        head: "metrics"
      }
    },
    {
      sourceType: "issue",
      sourceId: "github:acme/context-sample:issue:2",
      title: "Issue #2: expose cache hit metrics",
      pathOrUrl: "https://github.com/acme/context-sample/issues/2",
      observedAt: iso(sequence),
      payload: {
        number: 2,
        title: "Expose cache hit metrics",
        body: "Operators need separate cache hit and miss counters.",
        state: "open"
      }
    }
  ];
}

async function ingest(store, directory, commitSha, sequence) {
  return new IngestEvidenceService(store).ingest({
    tenantId: TENANT,
    repository: REPOSITORY,
    ref: REF,
    refSequence: sequence,
    commitSha,
    files: await filesAt(directory, commitSha),
    observations: observations(sequence),
    aclFingerprint: repositoryAclFingerprint(TENANT, REPOSITORY),
    observationFrontier: JSON.stringify({ sequence, issues: sequence, pullRequests: sequence - 1 }),
    createdAt: iso(sequence),
    sourceComplete: true,
    git: await gitSnapshot(directory, commitSha)
  });
}

async function derive(store, directory, checkpoint, budgetSeconds, buildTriggers) {
  const selector = new EvidenceFocusSelector(store);
  const bundle = await selector.select(checkpoint.id);
  const workspace = {
    repositoryDirectory: directory,
    manifest: await store.listManifest(checkpoint.id),
    priorKnowledge: await selectPriorKnowledge(store, checkpoint),
    resumedPages: []
  };
  const localGenerator = new LocalCodexKnowledgeDocumentGenerator();
  const basePrompt = buildKnowledgeFilePrompt(bundle, [], buildTriggers);
  const deadline = Date.now() + budgetSeconds * 1_000;
  let diagnostics = [];
  let committed;
  let orchestration;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const availableSeconds = Math.floor((deadline - Date.now()) / 1_000);
    if (attempt > 0 && availableSeconds < 30) break;
    const remainingSeconds = Math.max(30, availableSeconds);
    const rawOutput = await localGenerator.generate({
      prompt: attempt === 0 ? basePrompt : buildKnowledgeRepairPrompt(basePrompt, diagnostics),
      bundle,
      repairErrors: diagnostics,
      budgetSeconds: remainingSeconds,
      workspace
    });
    orchestration = rawOutput.orchestration;
    committed = await new DeriveKnowledgeService(
      selector,
      {
        name: localGenerator.name,
        version: localGenerator.version,
        model: localGenerator.model,
        async generate() {
          return rawOutput;
        }
      },
      store,
      new KnowledgeOutputValidator(store)
    ).derive(checkpoint.id, checkpoint.createdAt, undefined, 1);
    if (committed.status === "succeeded") break;
    diagnostics = committed.diagnostics;
  }
  assert.equal(committed?.status, "succeeded", committed?.diagnostics.join("; "));
  assert.ok(committed.revisionIds.length > 0, "No citation-valid context revisions were committed");
  assert.ok(orchestration, "Codex did not produce a durable context plan");
  assert.equal(
    orchestration.phase,
    "complete",
    `controlled E2E repository should finish its plan: ${orchestration.completionReason ?? "no completion reason"}`
  );
  assert.ok(orchestration.subjects.length > 0, "Codex did not discover any maintenance subjects");
  assert.ok(
    orchestration.subjects
      .filter((subject) => subject.priority === "required")
      .every((subject) => subject.status === "covered" || subject.status === "unsupported"),
    "required maintenance subjects were left unresolved"
  );
  const requiredQuestions = orchestration.subjects
    .flatMap((subject) => subject.questions)
    .filter((question) => question.priority === "required");
  assert.ok(requiredQuestions.length > 0, "Codex did not discover any required maintenance questions");
  assert.ok(
    requiredQuestions.every((question) => question.status === "answered" || question.status === "unsupported"),
    "required maintenance questions were left unresolved"
  );
  assert.ok(
    orchestration.reviews.some((review) => review.status === "complete" && review.kind === "context_only"),
    "Codex did not complete a context-only critic review"
  );
  return { run: committed, orchestration };
}

async function index(store, checkpoint, orchestration) {
  const client = new LocalPageIndexClient({
    python: process.env.CONTEXT_PAGEINDEX_PYTHON,
    workerPath: process.env.CONTEXT_PAGEINDEX_WORKER,
    timeoutMs: 30_000
  });
  const probe = await client.probe();
  assert.equal(probe.available, true, `PageIndex worker unavailable: ${probe.reason ?? "unknown"}`);
  const release = await new IndexContextService(store, new PageIndexHierarchyAdapter(client)).index(
    checkpoint.id,
    new Date(Date.parse(checkpoint.createdAt) + 30_000).toISOString(),
    undefined,
    orchestration.phase === "complete" ? "complete" : "partial"
  );
  assert.equal(release.capabilities.hierarchy, "available");
  assert.notEqual(release.capabilities.derivedKnowledge, "unavailable");
  return release;
}

async function main() {
  assert.ok(process.env.CONTEXT_PAGEINDEX_WORKER, "CONTEXT_PAGEINDEX_WORKER must name the local worker.py");
  assert.ok(process.env.PAGEINDEX_SOURCE_ROOT, "PAGEINDEX_SOURCE_ROOT must name a pinned PageIndex checkout");
  const directory = await mkdtemp(join(tmpdir(), "jina-context-e2e-"));
  const keep = process.env.JINA_KEEP_E2E_REPO === "true";
  try {
    await git(directory, ["init", "-b", REF]);
    await put(
      directory,
      "README.md",
      [
        "# Acme Cache",
        "",
        "Acme Cache is an in-memory cache for request handlers.",
        "Requests call Cache.get before computing an expensive value.",
        "Every entry has an absolute expiry timestamp.",
        "Expired entries are removed before a lookup returns.",
        "Operators run npm test before publishing a cache change.",
        ""
      ].join("\n")
    );
    await put(
      directory,
      "src/cache.ts",
      [
        "export interface Clock { now(): number }",
        'export type CacheStatus = "hit" | "miss";',
        "export class Cache {",
        "  readonly #entries = new Map<string, { value: string; expiresAt: number }>();",
        "  constructor(private readonly clock: Clock) {}",
        "  set(key: string, value: string, ttlMs: number): void {",
        "    this.#entries.set(key, { value, expiresAt: this.clock.now() + ttlMs });",
        "  }",
        "  get(key: string): string | undefined {",
        "    const entry = this.#entries.get(key);",
        "    if (!entry || entry.expiresAt <= this.clock.now()) {",
        "      this.#entries.delete(key);",
        "      return undefined;",
        "    }",
        "    return entry.value;",
        "  }",
        "}",
        ""
      ].join("\n")
    );
    await put(
      directory,
      "docs/operations.md",
      [
        "# Cache operations",
        "",
        "A sudden miss increase can indicate an expiry regression.",
        "Run npm test to verify expiry behavior before deployment.",
        "Compare hit and miss counters after deployment.",
        ""
      ].join("\n")
    );
    await put(
      directory,
      "package.json",
      `${JSON.stringify(
        {
          name: "acme-context-sample",
          private: true,
          type: "module",
          scripts: { test: "node --test" }
        },
        null,
        2
      )}\n`
    );
    const initialSha = await commit(directory, "fix: remove expired cache entries before returning");

    const store = new MemoryContextEngineStore();
    await store.replaceRepositoryAccess(TENANT, PRINCIPAL, [REPOSITORY]);
    const initialCheckpoint = await ingest(store, directory, initialSha, 1);
    const initialDerivation = await derive(store, directory, initialCheckpoint, 300, [`push:${initialSha}`, "issue:1"]);
    const initialRelease = await index(store, initialCheckpoint, initialDerivation.orchestration);

    const initialCatalog = new ContextCatalogService(store);
    const initialList = await initialCatalog.listContext({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      repository: REPOSITORY,
      ref: REF
    });
    assert.ok(initialList.documents.length > 0);
    assert.ok(initialList.tree.length > 0);
    assert.ok(initialList.documents.every((document) => document.citations.length > 0));
    assert.ok(initialList.documents.every((document) => document.logicalId.includes(REPOSITORY)));
    assert.ok(
      initialList.documents.some((document) => document.logicalId === `repository:${REPOSITORY}:architecture`),
      "full initialization did not publish repository architecture context"
    );
    assert.ok(
      initialList.documents
        .flatMap((document) => document.citations)
        .some((citation) => citation.anchor.sourceId === "github:acme/context-sample:issue:1"),
      "full initialization did not ground context in existing issue history"
    );
    const initialRead = await initialCatalog.readContext({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      repository: REPOSITORY,
      releaseId: initialRelease.id,
      document: initialList.documents[0].logicalId
    });
    assert.ok(initialRead.document.bodyMarkdown.startsWith("# "));

    await put(
      directory,
      "src/cache.ts",
      [
        "export interface Clock { now(): number }",
        'export type CacheStatus = "hit" | "miss";',
        "export interface CacheMetrics { hits: number; misses: number }",
        "export class Cache {",
        "  readonly #entries = new Map<string, { value: string; expiresAt: number }>();",
        "  readonly metrics: CacheMetrics = { hits: 0, misses: 0 };",
        "  constructor(private readonly clock: Clock) {}",
        "  set(key: string, value: string, ttlMs: number): void {",
        "    this.#entries.set(key, { value, expiresAt: this.clock.now() + ttlMs });",
        "  }",
        "  get(key: string): string | undefined {",
        "    const entry = this.#entries.get(key);",
        "    if (!entry || entry.expiresAt <= this.clock.now()) {",
        "      this.#entries.delete(key);",
        "      this.metrics.misses += 1;",
        "      return undefined;",
        "    }",
        "    this.metrics.hits += 1;",
        "    return entry.value;",
        "  }",
        "}",
        ""
      ].join("\n")
    );
    await put(
      directory,
      "README.md",
      [
        "# Acme Cache",
        "",
        "Acme Cache is an in-memory cache for request handlers.",
        "Requests call Cache.get before computing an expensive value.",
        "Every entry has an absolute expiry timestamp.",
        "Expired entries are removed before a lookup returns.",
        "Cache.get records separate hit and miss counters.",
        "Operators run npm test before publishing a cache change.",
        ""
      ].join("\n")
    );
    const incrementalSha = await commit(directory, "feat: record cache hit and miss metrics for issue 2");
    const incrementalCheckpoint = await ingest(store, directory, incrementalSha, 2);
    const incrementalDerivation = await derive(store, directory, incrementalCheckpoint, 240, [
      `push:${incrementalSha}`,
      `pull:7:${incrementalSha}`,
      "issue:2"
    ]);
    const incrementalRelease = await index(store, incrementalCheckpoint, incrementalDerivation.orchestration);

    const catalog = new ContextCatalogService(store);
    const list = await catalog.listContext({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      repository: REPOSITORY,
      ref: REF
    });
    assert.ok(list.documents.length > 0);
    assert.ok(list.documents.every((document) => document.citations.length > 0));
    const incrementalCitationIds = new Set(
      list.documents.flatMap((document) => document.citations.map((citation) => citation.anchor.sourceId))
    );
    assert.ok(
      incrementalCitationIds.has("github:acme/context-sample:issue:2"),
      "incremental context did not use the newly opened issue"
    );
    assert.ok(
      incrementalCitationIds.has("github:acme/context-sample:pull:7"),
      "incremental context did not use the newly opened pull request"
    );

    const diff = await catalog.diffContext({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      repository: REPOSITORY,
      fromReleaseId: initialRelease.id,
      toReleaseId: incrementalRelease.id
    });
    assert.equal(diff.from.commitSha, initialSha);
    assert.equal(diff.to.commitSha, incrementalSha);
    assert.ok(diff.added.length + diff.changed.length + diff.removed.length > 0);

    const server = createApiServer({
      tenantId: TENANT,
      seedDemo: false,
      contextStore: store,
      contextApiToken: CONTEXT_TOKEN,
      contextApiTenantId: TENANT,
      contextApiPrincipalId: PRINCIPAL
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const apiUrl = `http://127.0.0.1:${server.address().port}`;
    const headers = {
      authorization: `Bearer ${CONTEXT_TOKEN}`,
      "content-type": "application/json",
      "x-jina-tenant-id": TENANT,
      "x-jina-principal-id": PRINCIPAL
    };
    const searchQuery = "How are cache hits and misses recorded, and how do operators diagnose expiry regressions?";
    let search;
    let mcpTools;
    try {
      const releasesResponse = await apiJson(
        `${apiUrl}/context/releases?repository=${encodeURIComponent(REPOSITORY)}`,
        { headers }
      );
      assert.ok(releasesResponse.releases.some((release) => release.id === incrementalRelease.id));
      const listResponse = await apiJson(
        `${apiUrl}/context/list?repository=${encodeURIComponent(REPOSITORY)}&releaseId=${encodeURIComponent(incrementalRelease.id)}`,
        { headers }
      );
      assert.equal(listResponse.documents.length, list.documents.length);
      const readResponse = await apiJson(
        `${apiUrl}/context/read?repository=${encodeURIComponent(REPOSITORY)}&releaseId=${encodeURIComponent(incrementalRelease.id)}&document=${encodeURIComponent(list.documents[0].id)}`,
        { headers }
      );
      assert.ok(readResponse.document.bodyMarkdown.startsWith("# "));
      const diffResponse = await apiJson(
        `${apiUrl}/context/diff?repository=${encodeURIComponent(REPOSITORY)}&fromReleaseId=${encodeURIComponent(initialRelease.id)}&toReleaseId=${encodeURIComponent(incrementalRelease.id)}`,
        { headers }
      );
      assert.equal(diffResponse.from.id, initialRelease.id);
      assert.equal(diffResponse.to.id, incrementalRelease.id);
      search = await apiJson(`${apiUrl}/context/search`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          repository: REPOSITORY,
          releaseId: incrementalRelease.id,
          query: searchQuery,
          limit: 5
        })
      });
      assert.equal(search.retrieval.method, "lexical_tree", search.retrieval.degradedReason);
      assert.ok(search.results.length > 0);
      assert.ok(search.results.every((result) => result.citations.length > 0));
      assert.equal("answer" in search, false);

      const client = new Client({ name: "jina-local-e2e", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${apiUrl}/mcp`), {
        requestInit: { headers }
      });
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        mcpTools = tools.tools.map((tool) => tool.name);
        assert.deepEqual(mcpTools, ["search_context", "list_context", "read_context", "diff_context"]);
        const calls = await Promise.all([
          client.callTool({
            name: "search_context",
            arguments: {
              repository: REPOSITORY,
              releaseId: incrementalRelease.id,
              query: searchQuery,
              limit: 5
            }
          }),
          client.callTool({
            name: "list_context",
            arguments: { repository: REPOSITORY, releaseId: incrementalRelease.id }
          }),
          client.callTool({
            name: "read_context",
            arguments: {
              repository: REPOSITORY,
              releaseId: incrementalRelease.id,
              document: list.documents[0].id
            }
          }),
          client.callTool({
            name: "diff_context",
            arguments: {
              repository: REPOSITORY,
              fromReleaseId: initialRelease.id,
              toReleaseId: incrementalRelease.id
            }
          })
        ]);
        assert.ok(calls.every((call) => call.isError !== true));
        assert.equal("answer" in calls[0].structuredContent, false);
        assert.ok(calls[0].structuredContent.results.length > 0);
      } finally {
        await client.close();
      }
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }

    const report = {
      model: process.env.CONTEXT_CODEX_MODEL,
      reasoningEffort: process.env.CONTEXT_CODEX_EFFORT,
      authentication: process.env.CONTEXT_CODEX_AUTH,
      initial: {
        commitSha: initialSha,
        checkpointId: initialCheckpoint.id,
        derivationRunId: initialDerivation.run.id,
        releaseId: initialRelease.id,
        documents: initialList.documents.length,
        treeRoots: initialList.tree.length,
        orchestration: {
          phase: initialDerivation.orchestration.phase,
          subjects: initialDerivation.orchestration.subjects.length,
          subjectKinds: [...new Set(initialDerivation.orchestration.subjects.map((subject) => subject.kind))].sort(),
          historySignals: initialDerivation.orchestration.subjects
            .flatMap((subject) => subject.signals)
            .filter((signal) => ["commit", "pull_request", "issue", "observation"].includes(signal.source)).length,
          items: initialDerivation.orchestration.items.length,
          areas: initialDerivation.orchestration.areas.length,
          workers: initialDerivation.orchestration.workers.length,
          openBlockingGaps: initialDerivation.orchestration.gaps.filter(
            (gap) => gap.severity === "blocking" && gap.status === "open"
          ).length
        }
      },
      incremental: {
        commitSha: incrementalSha,
        checkpointId: incrementalCheckpoint.id,
        derivationRunId: incrementalDerivation.run.id,
        releaseId: incrementalRelease.id,
        documents: list.documents.length,
        treeRoots: list.tree.length,
        observations: { issues: [1, 2], pullRequests: [7] },
        groundedProviderEvidence: [...incrementalCitationIds].filter((sourceId) => sourceId.startsWith("github:")),
        orchestration: {
          phase: incrementalDerivation.orchestration.phase,
          subjects: incrementalDerivation.orchestration.subjects.length,
          subjectKinds: [
            ...new Set(incrementalDerivation.orchestration.subjects.map((subject) => subject.kind))
          ].sort(),
          historySignals: incrementalDerivation.orchestration.subjects
            .flatMap((subject) => subject.signals)
            .filter((signal) => ["commit", "pull_request", "issue", "observation"].includes(signal.source)).length,
          items: incrementalDerivation.orchestration.items.length,
          areas: incrementalDerivation.orchestration.areas.length,
          workers: incrementalDerivation.orchestration.workers.length,
          openBlockingGaps: incrementalDerivation.orchestration.gaps.filter(
            (gap) => gap.severity === "blocking" && gap.status === "open"
          ).length
        }
      },
      search: {
        method: search.retrieval.method,
        selector: search.retrieval.selector,
        resultDocuments: search.results.map((result) => result.logicalId),
        returnsAnswer: false
      },
      api: {
        routes: ["/context/releases", "/context/list", "/context/read", "/context/search", "/context/diff"]
      },
      mcp: {
        tools: mcpTools
      },
      diff: {
        added: diff.added.map((document) => document.logicalId),
        changed: diff.changed.map((entry) => entry.after.logicalId),
        removed: diff.removed.map((document) => document.logicalId),
        unchanged: diff.unchanged
      }
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (keep) process.stderr.write(`Kept E2E repository at ${directory}\n`);
    else await rm(directory, { recursive: true, force: true });
  }
}

async function apiJson(url, init) {
  const response = await fetch(url, init);
  const body = await response.json();
  assert.equal(response.status, 200, `${new URL(url).pathname}: ${JSON.stringify(body)}`);
  return body;
}

await main();
