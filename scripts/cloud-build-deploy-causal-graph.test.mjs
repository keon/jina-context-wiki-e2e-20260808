import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const deployment = await readFile("scripts/cloud-build-deploy-causal-graph.sh", "utf8");
const cloudBuild = await readFile("cloudbuild.causal-graph.yaml", "utf8");
const stateStore = await readFile("packages/db/src/postgres-json-state-store.ts", "utf8");

test("causal graph has its own Cloud Build and worker service", () => {
  assert.match(cloudBuild, /scripts\/cloud-build-deploy-causal-graph\.sh/);
  assert.match(deployment, /worker_service="jina-causal-graph-worker"/);
  assert.match(
    deployment,
    /causal_topics="run-causal-graph-history\|run-causal-graph-derive\|run-causal-graph-publication"/
  );
  assert.doesNotMatch(deployment, /gcloud run deploy jina-context-worker/);
  assert.doesNotMatch(deployment, /gcloud run deploy jina-task-worker/);
  assert.doesNotMatch(deployment, /context-production-preflight/);
});

test("causal graph release activation is independent of Context release control", () => {
  assert.match(deployment, /migrate-causal-graph\.js/);
  assert.match(deployment, /activate-causal-graph-release\.js/);
  assert.doesNotMatch(deployment, /worker-pause|board-drain|release-acquire/);
  assert.match(stateStore, /from jina_runtime\.causal_graph_release_control/);
  assert.match(stateStore, /from jina_runtime\.release_control/);
});

test("causal graph releases cannot deploy or route the shared API", () => {
  assert.match(deployment, /api_service="jina-api"/);
  assert.match(deployment, /api_url="\$\(gcloud run services describe "\$\{api_service\}"[\s\S]+?value\(status\.url\)/);
  assert.doesNotMatch(deployment, /gcloud run deploy "\$\{api_service\}"/);
  assert.doesNotMatch(deployment, /gcloud run services update-traffic "\$\{api_service\}"/);
  assert.doesNotMatch(deployment, /api_candidate_url|tagged_service_url/);
});

test("causal graph deployment uses isolated capacity and an exact topic check", () => {
  assert.match(deployment, /--min-instances=1/);
  assert.match(deployment, /--max-instances=1/);
  assert.match(deployment, /--concurrency=1/);
  assert.match(deployment, /--format=json \| python3 -c/);
  assert.match(deployment, /item\.get\("name"\) == "WORKER_TOPICS"/);
  assert.match(deployment, /if \[\[ "\$\{observed_topics\}" != "\$\{causal_topics\}" \]\]/);
  assert.match(deployment, /CAUSAL_GRAPH_OPENAI_API_KEY=jina-openai-api-key:latest/);
});

test("first worker creation is release-gated without relying on zero traffic", () => {
  assert.match(deployment, /worker_traffic_args=\(--tag="\$\{candidate_tag\}"\)/);
  assert.match(
    deployment,
    /gcloud run services describe "\$\{worker_service\}"[\s\S]+?worker_traffic_args=\(--no-traffic/
  );
  assert.match(deployment, /gcloud run deploy "\$\{worker_service\}"[\s\S]+?activate-causal-graph-release\.js/);
});
