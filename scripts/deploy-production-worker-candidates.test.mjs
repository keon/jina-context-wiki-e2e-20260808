import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkerCandidateDeployArgs,
  deployWorkerCandidates,
  validateWorkerCandidateManifest,
  validateWorkerCandidateState
} from "./deploy-production-worker-candidates.mjs";

const IMAGE = `us-east1-docker.pkg.dev/jina-v2/jina/worker@sha256:${"b".repeat(64)}`;
const SERVICES = {
  context: "jina-context-worker",
  task: "jina-task-worker"
};
const ACCOUNTS = {
  context: "jina-context-worker@jina-v2.iam.gserviceaccount.com",
  task: "jina-task-worker@jina-v2.iam.gserviceaccount.com"
};

function rawManifest() {
  return {
    schema_version: 1,
    release_id: "prod-20260806-a",
    source_sha: "a".repeat(40),
    image: IMAGE,
    api_url: "https://candidate---jina-code-review-api.example.run.app",
    candidate: { revision_suffix: "candidate-a", tag: "candidate" },
    workers: {
      context: {
        runtime: runtime(1, 20),
        environment: {
          GOOGLE_CLOUD_PROJECT: "jina-v2",
          JINA_API_URL: "https://candidate---jina-code-review-api.example.run.app",
          JINA_WORKER_CLAIM_MODE: "paused",
          WORKER_TOPICS:
            "run-context-input-snapshot|run-context-page-plan|run-context-page-build|run-context-publication",
          CONTEXT_BOARD_EXECUTOR: "daytona",
          CONTEXT_DAYTONA_MODEL_SECRET: "jina-openai-api-key"
        },
        secrets: secrets([
          "INTERNAL_API_TOKEN",
          "JINA_PRODUCT_INTERNAL_API_TOKEN",
          "DAYTONA_API_KEY",
          "GITHUB_APP_ID",
          "GITHUB_APP_PRIVATE_KEY",
          "GITHUB_CLONE_TOKEN"
        ])
      },
      task: {
        runtime: runtime(1, 5),
        environment: {
          GOOGLE_CLOUD_PROJECT: "jina-v2",
          JINA_API_URL: "https://candidate---jina-code-review-api.example.run.app",
          JINA_WORKER_CLAIM_MODE: "paused",
          WORKER_TOPICS: "run-review",
          REVIEW_MODEL: "gpt-5.6-sol"
        },
        secrets: secrets(["INTERNAL_API_TOKEN", "OPENAI_API_KEY", "GITHUB_CLONE_TOKEN", "TRIGGER_SECRET_KEY"])
      }
    }
  };
}

function runtime(minInstances, maxInstances) {
  return {
    concurrency: 1,
    timeout_seconds: 300,
    min_instances: minInstances,
    max_instances: maxInstances,
    cpu: "1",
    memory: "1Gi"
  };
}

function secrets(names) {
  return Object.fromEntries(
    names.map((name) => [
      name,
      {
        project: "jina-v2",
        name: name.toLowerCase().replaceAll("_", "-"),
        version: "3"
      }
    ])
  );
}

function service(kind, servingRevision, tagged = false) {
  const traffic = [{ revisionName: servingRevision, percent: 100 }];
  if (tagged) {
    traffic.push({
      revisionName: `${SERVICES[kind]}-candidate-a`,
      percent: 0,
      tag: "candidate",
      url: `https://candidate---${SERVICES[kind]}.example.run.app`
    });
  }
  return {
    spec: { template: { spec: { serviceAccountName: ACCOUNTS[kind] } } },
    status: { traffic }
  };
}

function revision(manifest, kind) {
  return {
    spec: {
      serviceAccountName: ACCOUNTS[kind],
      containers: [
        {
          env: [
            ...Object.entries(manifest.workers[kind].environment).map(([name, value]) => ({ name, value })),
            ...Object.keys(manifest.workers[kind].secrets).map((name) => ({
              name,
              valueFrom: { secretKeyRef: { name } }
            }))
          ]
        }
      ]
    },
    status: { conditions: [{ type: "Ready", status: "True" }] }
  };
}

function fakeCloud(manifest, options = {}) {
  const calls = [];
  const state = {
    context: service("context", "jina-context-worker-serving"),
    task: service("task", "jina-task-worker-serving")
  };
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    const joined = [command, ...args].join(" ");
    if (joined.includes("artifacts docker images describe")) return `${IMAGE}\n`;
    if (joined.includes("secrets versions describe")) {
      return options.disabledSecret && joined.includes(options.disabledSecret) ? "DISABLED\n" : "ENABLED\n";
    }
    for (const kind of ["context", "task"]) {
      if (joined.includes(`run services describe ${SERVICES[kind]}`)) {
        return JSON.stringify(state[kind]);
      }
      if (joined.includes(`run deploy ${SERVICES[kind]}`)) {
        state[kind] = service(kind, `${SERVICES[kind]}-serving`, true);
        return "";
      }
      if (joined.includes(`run revisions describe ${SERVICES[kind]}-candidate-a`)) {
        return JSON.stringify(revision(manifest, kind));
      }
    }
    throw new Error(`unexpected fake command: ${joined}`);
  };
  return { calls, runner };
}

test("worker candidate manifest is immutable, paused, relational, and numerically pinned", () => {
  const raw = rawManifest();
  const manifest = validateWorkerCandidateManifest(raw);
  for (const kind of ["context", "task"]) {
    const args = buildWorkerCandidateDeployArgs(manifest, kind);
    const command = args.join(" ");
    assert.match(command, /--no-traffic/);
    assert.match(command, /JINA_WORKER_CLAIM_MODE=paused/);
    assert.doesNotMatch(command, /update-traffic|latest|JINA_WORKER_RELEASE_CREDENTIAL/);
  }
  for (const mutate of [
    (copy) => {
      copy.image = "us-east1-docker.pkg.dev/jina-v2/jina/worker:latest";
    },
    (copy) => {
      copy.workers.task.environment.JINA_WORKER_CLAIM_MODE = "enabled";
    },
    (copy) => {
      copy.workers.context.secrets.INTERNAL_API_TOKEN.version = "latest";
    },
    (copy) => {
      copy.workers.context.secrets.INTERNAL_API_TOKEN.project = "jina-463721";
    },
    (copy) => {
      copy.workers.task.secrets.JINA_WORKER_RELEASE_CREDENTIAL = {
        project: "jina-v2",
        name: "release",
        version: "1"
      };
    }
  ]) {
    const copy = structuredClone(raw);
    mutate(copy);
    assert.throws(() => validateWorkerCandidateManifest(copy));
  }
});

test("worker validation is read-only and proves every exact secret version", async () => {
  const manifest = validateWorkerCandidateManifest(rawManifest());
  const cloud = fakeCloud(manifest);
  const serving = await validateWorkerCandidateState(manifest, cloud.runner);
  assert.deepEqual(serving, {
    context: "jina-context-worker-serving",
    task: "jina-task-worker-serving"
  });
  assert.equal(
    cloud.calls.some((call) => call.join(" ").includes("run deploy")),
    false
  );
  assert.equal(cloud.calls.filter((call) => call.join(" ").includes("secrets versions describe")).length, 10);
});

test("candidate-only deployment keeps both serving revisions unchanged", async () => {
  const manifest = validateWorkerCandidateManifest(rawManifest());
  const cloud = fakeCloud(manifest);
  const deployed = await deployWorkerCandidates(manifest, { runner: cloud.runner });
  assert.equal(deployed.context.revision, "jina-context-worker-candidate-a");
  assert.equal(deployed.task.revision, "jina-task-worker-candidate-a");
  const commands = cloud.calls.map((call) => call.join(" ")).join("\n");
  assert.doesNotMatch(commands, /update-traffic|run jobs|sql|migrate|release-acquire/);
});

test("a disabled secret prevents every worker mutation", async () => {
  const manifest = validateWorkerCandidateManifest(rawManifest());
  const cloud = fakeCloud(manifest, { disabledSecret: "trigger-secret-key" });
  await assert.rejects(deployWorkerCandidates(manifest, { runner: cloud.runner }), /is not enabled/);
  assert.equal(
    cloud.calls.some((call) => call.join(" ").includes("run deploy")),
    false
  );
});
