import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

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
  assert.match(deployment, /context-production-preflight\.mjs/);
});

test("causal graph identity stays independent while cutover coordinates shared admission", () => {
  assert.match(deployment, /migrate-causal-graph\.js/);
  assert.match(deployment, /activate-causal-graph-release\.js/);
  assert.match(deployment, /run_release_control "release-acquire"/);
  assert.match(deployment, /run_release_control "worker-drain"/);
  assert.match(deployment, /run_release_control "board-await-quiescence"/);
  assert.match(deployment, /run_release_control "worker-resume"/);
  assert.doesNotMatch(deployment, /run_release_control "worker-pause"/);
  assert.match(stateStore, /from jina_runtime\.causal_graph_release_control/);
  assert.match(stateStore, /from jina_runtime\.release_control/);

  const acquire = deployment.indexOf('run_release_control "release-acquire"');
  const closeAdmission = deployment.indexOf('run_release_control "worker-drain"', acquire);
  const awaitQuiescence = deployment.indexOf('run_release_control "board-await-quiescence"', closeAdmission);
  const activate = deployment.indexOf('activate_causal_release "${CLOUD_BUILD_ID}"', awaitQuiescence);
  const route = deployment.indexOf('route_causal_revision "${worker_revision}"', activate);
  const reopen = deployment.indexOf('run_release_control "worker-resume"', route);
  const release = deployment.indexOf('run_release_control "release-release"', reopen);
  assert.ok(acquire >= 0 && acquire < closeAdmission);
  assert.ok(closeAdmission < awaitQuiescence);
  assert.ok(awaitQuiescence < activate);
  assert.ok(activate < route);
  assert.ok(route < reopen);
  assert.ok(reopen < release);
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
  assert.match(deployment, /CAUSAL_GRAPH_OPENAI_API_KEY=jina-openai-api-key:\$\{openai_api_key_secret_version\}/);
  assert.match(deployment, /JINA_PRODUCT_API_URL=\$\{product_api_url\}/);
  assert.match(
    deployment,
    /JINA_PRODUCT_INTERNAL_API_TOKEN=\$\{product_internal_token_secret\}:\$\{product_internal_token_secret_version\}/
  );
});

test("first worker creation is release-gated without relying on zero traffic", () => {
  assert.match(deployment, /worker_traffic_args=\(--tag="\$\{candidate_tag\}"\)/);
  assert.match(
    deployment,
    /gcloud run services describe "\$\{worker_service\}"[\s\S]+?worker_traffic_args=\(--no-traffic/
  );
  assert.match(deployment, /gcloud run deploy "\$\{worker_service\}"[\s\S]+?activate-causal-graph-release\.js/);
});

test("an ambiguous causal activation restores the prior identity before reopening claims", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jina-causal-ack-loss-"));
  const bin = join(directory, "bin");
  const log = join(directory, "calls.log");
  const activation = join(directory, "activation");
  const lease = join(directory, "lease");
  await mkdir(bin);
  await writeFile(
    join(bin, "curl"),
    `#!/usr/bin/env bash
exit 0
`
  );
  await writeFile(
    join(bin, "sleep"),
    `#!/usr/bin/env bash
exec /bin/sleep 0.05
`
  );
  await writeFile(
    join(bin, "gcloud"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"${log}"
if [[ "$1 $2 $3" == "secrets versions describe" ]]; then
  printf '%s\\n' ENABLED
  exit 0
fi
if [[ "$1 $2 $3" == "secrets versions add" ]]; then
  cat >/dev/null
  printf '%s\\n' projects/quality-project/secrets/jina-causal-graph-worker-release-credential/versions/16
  exit 0
fi
if [[ "$1 $2 $3" == "run services describe" && "$4" == "jina-api" ]]; then
  printf '%s\\n' https://jina-api.example.run.app
  exit 0
fi
if [[ "$1 $2 $3" == "run services describe" && "$4" == "jina-causal-graph-worker" ]]; then
  if [[ "$*" == *"--format=json"* ]]; then
    if [[ -f "${lease}" ]]; then
      printf '%s\\n' '{"status":{"traffic":[{"percent":100,"revisionName":"jina-causal-graph-worker-latest"}]}}'
    else
      printf '%s\\n' '{"status":{"traffic":[{"percent":100,"revisionName":"jina-causal-graph-worker-stale"}]}}'
    fi
  fi
  exit 0
fi
if [[ "$1 $2 $3" == "run revisions describe" ]]; then
  if [[ "$4" == "jina-causal-graph-worker-latest" ]]; then
    printf '%s\\n' '{"spec":{"containers":[{"env":[{"name":"JINA_WORKER_RELEASE_ID","value":"latest-release"},{"name":"JINA_WORKER_RELEASE_CREDENTIAL","valueFrom":{"secretKeyRef":{"name":"jina-causal-graph-worker-release-credential","key":"15"}}}]}]}}'
  elif [[ "$4" == "jina-causal-graph-worker-stale" ]]; then
    printf '%s\\n' '{"spec":{"containers":[{"env":[{"name":"JINA_WORKER_RELEASE_ID","value":"stale-release"},{"name":"JINA_WORKER_RELEASE_CREDENTIAL","valueFrom":{"secretKeyRef":{"name":"jina-causal-graph-worker-release-credential","key":"14"}}}]}]}}'
  else
    printf '%s\\n' '{"spec":{"containers":[{"env":[{"name":"WORKER_TOPICS","value":"run-causal-graph-history|run-causal-graph-derive|run-causal-graph-publication"}]}]}}'
  fi
  exit 0
fi
if [[ "$1 $2 $3" == "run jobs execute" && "$*" == *"release-acquire"* ]]; then
  : >"${lease}"
  exit 0
fi
if [[ "$1 $2 $3 $4" == "run jobs deploy jina-causal-graph-release-activate" ]]; then
  if [[ "$*" == *"JINA_CAUSAL_GRAPH_RELEASE_ID=quality-build"* ]]; then
    printf '%s\\n' new >"${activation}"
  elif [[ "$*" == *"JINA_CAUSAL_GRAPH_RELEASE_ID=latest-release"* ]]; then
    printf '%s\\n' old >"${activation}"
  fi
  exit 0
fi
if [[ "$1 $2 $3 $4" == "run jobs execute jina-causal-graph-release-activate" ]]; then
  if [[ "$(<"${activation}")" == "new" ]]; then
    printf '%s\\n' activation-ack-lost >>"${log}"
    exit 1
  fi
  printf '%s\\n' prior-activation-restored >>"${log}"
  exit 0
fi
exit 0
`
  );
  await Promise.all([
    chmod(join(bin, "curl"), 0o755),
    chmod(join(bin, "sleep"), 0o755),
    chmod(join(bin, "gcloud"), 0o755)
  ]);

  try {
    await assert.rejects(
      execFileAsync("bash", ["scripts/cloud-build-deploy-causal-graph.sh"], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GCP_PROJECT_ID: "quality-project",
          GCP_REGION: "us-east1",
          CLOUD_BUILD_ID: "quality-build",
          JINA_CAUSAL_GRAPH_DAYTONA_SNAPSHOT: "snapshot-v1",
          JINA_CAUSAL_GRAPH_DAYTONA_MODEL_SECRET: "model-secret"
        }
      }),
      (error) => {
        assert.equal(error.code, 1);
        return true;
      }
    );
    const calls = await readFile(log, "utf8");
    const acknowledgementLoss = calls.indexOf("activation-ack-lost");
    const leaseAcquired = calls.indexOf("release-acquire");
    const capturedLatest = calls.indexOf("run services describe jina-causal-graph-worker", leaseAcquired);
    const restoreIdentity = calls.indexOf("JINA_CAUSAL_GRAPH_RELEASE_ID=latest-release", acknowledgementLoss);
    const restoreAcknowledged = calls.indexOf("prior-activation-restored", restoreIdentity);
    const restoreTraffic = calls.indexOf("run services update-traffic jina-causal-graph-worker", restoreAcknowledged);
    const reopenClaims = calls.indexOf("worker-resume", restoreTraffic);
    assert.ok(leaseAcquired >= 0);
    assert.ok(leaseAcquired < capturedLatest);
    assert.doesNotMatch(calls, /JINA_CAUSAL_GRAPH_RELEASE_ID=stale-release/);
    assert.ok(acknowledgementLoss >= 0);
    assert.ok(acknowledgementLoss < restoreIdentity);
    assert.ok(restoreIdentity < restoreAcknowledged);
    assert.ok(restoreAcknowledged < restoreTraffic);
    assert.ok(restoreTraffic < reopenClaims);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
