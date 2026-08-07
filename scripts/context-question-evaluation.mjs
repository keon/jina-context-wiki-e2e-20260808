#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const apiUrl = requiredEnvironment("JINA_API_URL").replace(/\/$/, "");
const repository = requiredEnvironment("JINA_CONTEXT_REPOSITORY");
const questionFile = requiredEnvironment("CONTEXT_QUESTION_FILE");
const ref = process.env.JINA_CONTEXT_REF?.trim() || "main";
const concurrency = boundedInteger(process.env.CONTEXT_QUESTION_CONCURRENCY, 1, 16, 4);
const timeoutMs = boundedInteger(process.env.CONTEXT_QUESTION_TIMEOUT_MS, 1_000, 120_000, 30_000);
const questions = parseQuestions(await readFile(questionFile, "utf8"));
if (questions.length === 0) throw new Error("CONTEXT_QUESTION_FILE contains no Markdown bullet questions");

const results = await concurrentMap(questions, concurrency, async (entry) => {
  const started = performance.now();
  try {
    const response = await fetch(`${apiUrl}/wiki/search`, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        repository,
        ref,
        query: entry.question
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const payload = await response.json().catch(() => ({}));
    const latencyMs = Math.round((performance.now() - started) * 100) / 100;
    if (!response.ok) {
      return {
        ...entry,
        result: "error",
        latencyMs,
        status: response.status,
        error: errorMessage(payload)
      };
    }
    if ("answer" in payload) throw new Error("context search unexpectedly returned an answer");
    const contextResults = Array.isArray(payload.results) ? payload.results : [];
    const citations = contextResults.flatMap((result) => (Array.isArray(result?.citations) ? result.citations : []));
    const result = contextResults.length > 0 && citations.length > 0 ? "retrieved" : "no_context";
    return {
      ...entry,
      result,
      latencyMs,
      releaseId: typeof payload.release?.id === "string" ? payload.release.id : undefined,
      commitSha: typeof payload.release?.commitSha === "string" ? payload.release.commitSha : undefined,
      contextCount: contextResults.length,
      citationCount: citations.length,
      citationSourceIds: [
        ...new Set(
          citations.map((citation) => citation?.anchor?.sourceId).filter((sourceId) => typeof sourceId === "string")
        )
      ],
      logicalIds: contextResults
        .map((context) => context?.logicalId)
        .filter((logicalId) => typeof logicalId === "string"),
      retrievalMethod: typeof payload.retrieval?.method === "string" ? payload.retrieval.method : undefined,
      selector: typeof payload.retrieval?.selector === "string" ? payload.retrieval.selector : undefined,
      degradedReason:
        typeof payload.retrieval?.degradedReason === "string" ? payload.retrieval.degradedReason : undefined
    };
  } catch (error) {
    return {
      ...entry,
      result: "error",
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      error: error instanceof Error ? error.message : String(error)
    };
  }
});

const counts = Object.fromEntries(
  ["retrieved", "no_context", "error"].map((status) => [
    status,
    results.filter((result) => result.result === status).length
  ])
);
const latencies = results.map((result) => result.latencyMs).sort((left, right) => left - right);
const report = {
  schemaVersion: "context-search-evaluation-v1",
  generatedAt: new Date().toISOString(),
  apiUrl,
  repository,
  ref,
  questionFile,
  questionCount: results.length,
  counts,
  retrievedRate: counts.retrieved / results.length,
  latencyMs: {
    median: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    maximum: latencies.at(-1) ?? 0
  },
  categories: [...new Set(results.map((result) => result.category))].map((category) => {
    const categoryResults = results.filter((result) => result.category === category);
    return {
      category,
      questionCount: categoryResults.length,
      retrieved: categoryResults.filter((result) => result.result === "retrieved").length,
      noContext: categoryResults.filter((result) => result.result === "no_context").length,
      errors: categoryResults.filter((result) => result.result === "error").length
    };
  }),
  results
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
const minimumRate = Number(process.env.CONTEXT_QUESTION_MIN_RETRIEVED_RATE ?? "0");
if (!Number.isFinite(minimumRate) || minimumRate < 0 || minimumRate > 1) {
  throw new Error("CONTEXT_QUESTION_MIN_RETRIEVED_RATE must be between 0 and 1");
}
if (counts.error > 0 || report.retrievedRate < minimumRate) process.exitCode = 1;

function parseQuestions(markdown) {
  const values = [];
  let category = "Uncategorized";
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      category = heading[1];
      continue;
    }
    const bullet = /^\s*-\s+(.+?)\s*$/.exec(line);
    if (bullet) values.push({ id: values.length + 1, category, question: bullet[1] });
  }
  return values;
}

async function concurrentMap(values, limit, operation) {
  const output = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        output[index] = await operation(values[index]);
      }
    })
  );
  return output;
}

function requestHeaders() {
  const headers = { accept: "application/json", "content-type": "application/json" };
  const token = process.env.CONTEXT_API_TOKEN?.trim() || process.env.INTERNAL_API_TOKEN?.trim();
  if (token) headers.authorization = `Bearer ${token}`;
  const tenant = process.env.JINA_TENANT_ID?.trim();
  const principal = process.env.JINA_PRINCIPAL_ID?.trim();
  if (tenant) headers["x-jina-tenant-id"] = tenant;
  if (principal) headers["x-jina-principal-id"] = principal;
  return headers;
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`integer must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function percentile(values, quantile) {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)];
}

function errorMessage(payload) {
  if (typeof payload?.error === "string") return payload.error;
  if (typeof payload?.message === "string") return payload.message;
  return JSON.stringify(payload).slice(0, 500);
}
