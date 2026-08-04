import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const deployment = await readFile("scripts/deploy-staging-causal-graph.sh", "utf8");

test("causal graph staging deployment refuses production and non-staging resources", () => {
  assert.match(deployment, /project="\$\{GCP_PROJECT_ID:-jina-staging-20260802\}"/);
  assert.match(deployment, /project}" == "jina-463721"/);
  assert.match(deployment, /Refusing non-staging deployment value/);
  assert.match(deployment, /IMAGE_TAG.*!= \*staging\*/);
});

test("causal graph staging has an isolated worker and release lane", () => {
  assert.match(deployment, /worker_service="jina-causal-graph-worker"/);
  assert.match(deployment, /Refusing unexpected causal graph worker identity/);
  assert.match(deployment, /migration_job="jina-causal-graph-migrate-staging"/);
  assert.match(deployment, /activation_job="jina-causal-graph-release-activate-staging"/);
  assert.match(deployment, /release_credential_secret="jina-staging-causal-graph-worker-release-credential"/);
  assert.match(deployment, /migrate-causal-graph\.js/);
  assert.match(deployment, /activate-causal-graph-release\.js/);
});

test("causal graph staging does not deploy or route shared services", () => {
  assert.match(deployment, /api_service="jina-api-staging"/);
  assert.doesNotMatch(deployment, /gcloud run deploy "\$\{api_service\}"/);
  assert.doesNotMatch(deployment, /gcloud run deploy jina-context-worker-staging/);
  assert.doesNotMatch(deployment, /gcloud run deploy jina-task-worker-staging/);
  assert.doesNotMatch(deployment, /gcloud run services update-traffic "\$\{api_service\}"/);
});

test("causal graph staging uses exact topics and staging-only secrets", () => {
  assert.match(
    deployment,
    /causal_topics="run-causal-graph-history\|run-causal-graph-derive\|run-causal-graph-publication"/
  );
  assert.match(deployment, /CAUSAL_GRAPH_OPENAI_API_KEY=\$\{openai_secret\}:latest/);
  assert.match(deployment, /item\.get\("name"\) == "WORKER_TOPICS"/);
  assert.match(deployment, /observed_topics}" != "\$\{causal_topics\}/);
  assert.doesNotMatch(deployment, /jina-openai-api-key:latest/);
  assert.doesNotMatch(deployment, /jina-internal-api-token:latest/);
});

test("first staging worker creation remains release-gated", () => {
  assert.match(deployment, /worker_traffic_args=\(--tag="\$\{candidate_tag\}"\)/);
  assert.match(
    deployment,
    /gcloud run services describe "\$\{worker_service\}"[\s\S]+?worker_traffic_args=\(--no-traffic/
  );
  assert.match(deployment, /gcloud run deploy "\$\{worker_service\}"[\s\S]+?activate-causal-graph-release\.js/);
});

test("causal graph staging keeps bounded warm capacity", () => {
  assert.match(deployment, /--min-instances=1/);
  assert.match(deployment, /--max-instances=3/);
  assert.match(deployment, /--concurrency=1/);
});
