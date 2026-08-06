import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPublicApiDeployArgs,
  deployPublicApiCandidate,
  ensureProductionInboxSchedulerPaused,
  isInboxFenceComplete,
  pauseProductionInboxSchedulerIfPresent,
  updatePublicApiTraffic,
  validatePublicApiAcceptanceEvidence,
  validateInboxFenceSnapshot,
  validateInboxRestoreSnapshot,
  validateInboxKeyCompatibility,
  validatePublicApiCandidateManifest,
  validatePublicApiCandidateState,
  validateServingInboxWriterKey
} from "./deploy-public-api-candidate.mjs";

const OLD_REVISION = "jina-code-review-api-old123";
const CANDIDATE_REVISION = "jina-code-review-api-candidate-a";

function rawManifest() {
  const secrets = {};
  for (const name of [
    "DB_PASS",
    "GITHUB_WEBHOOK_SECRET",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_OAUTH_CLIENT_SECRET",
    "INTERNAL_API_TOKEN",
    "JINA_PRODUCT_INTERNAL_API_TOKEN",
    "SECRETS_ENCRYPTION_KEY",
    "GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY",
    "AUTUMN_SECRET_KEY",
    "JINA_GRAPH_API_TOKEN",
    "JINA_GRAPH_INTERNAL_TOKEN"
  ]) {
    secrets[name] = {
      project: "jina-463721",
      name:
        name === "GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY"
          ? "jina-github-webhook-inbox-encryption-key"
          : name.toLowerCase().replaceAll("_", "-"),
      version: name === "GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY" ? "7" : "3"
    };
  }
  return {
    schema_version: 1,
    mode: "monorepo-candidate",
    release_id: "prod-20260806-a",
    source_sha: "a".repeat(40),
    image: `us-east1-docker.pkg.dev/jina-v2/jina/api@sha256:${"b".repeat(64)}`,
    target: {
      project: "jina-463721",
      region: "us-east1",
      service: "jina-code-review-api",
      service_account: "jina-api-runtime@jina-463721.iam.gserviceaccount.com",
      cloud_sql_instance: "jina-463721:us-east1:jina-db",
      expected_serving_revision: OLD_REVISION
    },
    candidate: {
      revision_suffix: "candidate-a",
      tag: "candidate"
    },
    runtime: {
      concurrency: 80,
      timeout_seconds: 300,
      min_instances: 1,
      max_instances: 10,
      cpu: "1",
      memory: "1Gi",
      port: 8080
    },
    environment: {
      API_BASE_URL: "https://api.usejina.com",
      DASHBOARD_AUTH_MODE: "github",
      DASHBOARD_URL: "https://app.usejina.com",
      DASHBOARD_ORIGIN: "https://app.usejina.com,https://jina-simulation-dashboard.vercel.app",
      DASHBOARD_COOKIE_SAMESITE: "None",
      DASHBOARD_COOKIE_SECURE: "true",
      GITHUB_APP_ID: "4040260",
      GITHUB_APP_SLUG: "jina-review-bot",
      GITHUB_APP_INSTALL_URL: "https://github.com/apps/jina-review-bot/installations/new",
      GITHUB_OAUTH_CLIENT_ID: "Ov23lix0k1McZctAzJu0",
      JINA_PRODUCT_API_ENABLED: "true",
      JINA_PRODUCT_DATABASE_MODE: "shared",
      JINA_TENANCY_MODE: "shared-db",
      JINA_REQUIRE_WORKER_RELEASE_GATE: "true",
      JINA_DB_MANAGE_SCHEMA: "false",
      JINA_DB_POOL_MAX: "3",
      INSTANCE_UNIX_SOCKET: "/cloudsql/jina-463721:us-east1:jina-db",
      DB_NAME: "jina",
      DB_USER: "jina_v2_app",
      JINA_GITHUB_WEBHOOK_INBOX_ENABLED: "true",
      GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY_VERSION: "7",
      JINA_SCHEDULER_OIDC_AUDIENCE: "https://api.usejina.com",
      JINA_SCHEDULER_OIDC_EMAIL: "jina-api-runtime@jina-463721.iam.gserviceaccount.com",
      JINA_REVIEW_BOARD_PIPELINE_MODE: "paused",
      JINA_BILLING_ENFORCE: "on",
      JINA_GRAPH_API_URL: "https://jina-api-m56inn6iva-ue.a.run.app"
    },
    secrets,
    scheduler: {
      job: "jina-github-webhook-inbox-production",
      location: "us-east1",
      schedule: "* * * * *",
      time_zone: "Etc/UTC",
      oidc_service_account: "jina-api-runtime@jina-463721.iam.gserviceaccount.com",
      oidc_audience: "https://api.usejina.com"
    },
    allowed_environment_changes: [],
    rollback_revision: OLD_REVISION
  };
}

function serviceEnvironment(manifest) {
  return [
    ...Object.entries(manifest.environment).map(([name, value]) => ({ name, value })),
    ...Object.entries(manifest.secrets).map(([name, secret]) => ({
      name,
      valueFrom: {
        secretKeyRef: {
          name: `projects/${secret.project}/secrets/${secret.name}`,
          key: secret.version
        }
      }
    }))
  ];
}

function cloudRunService(manifest, servingRevision, { candidateTag = false } = {}) {
  const traffic = [{ revisionName: servingRevision, percent: 100 }];
  if (candidateTag && servingRevision !== CANDIDATE_REVISION) {
    traffic.push({
      revisionName: CANDIDATE_REVISION,
      percent: 0,
      tag: manifest.candidate.tag,
      url: "https://candidate---jina-code-review-api-abc123-ue.a.run.app"
    });
  } else if (candidateTag) {
    traffic[0].tag = manifest.candidate.tag;
    traffic[0].url = "https://candidate---jina-code-review-api-abc123-ue.a.run.app";
  }
  return {
    spec: {
      template: {
        metadata: {
          annotations: {
            "run.googleapis.com/cloudsql-instances": manifest.target.cloudSqlInstance
          }
        },
        spec: {
          serviceAccountName: manifest.target.serviceAccount,
          containers: [{ env: serviceEnvironment(manifest) }]
        }
      }
    },
    status: { traffic }
  };
}

function fakeCloud(manifest, options = {}) {
  const calls = [];
  let service = cloudRunService(manifest, OLD_REVISION);
  let scheduler = options.existingSchedulerEndpoint
    ? schedulerForEndpoint(options.existingSchedulerEndpoint, options.existingSchedulerState ?? "ENABLED", manifest)
    : undefined;
  let schedulerUpdateFailures = options.schedulerUpdateFailures ?? 0;
  let trafficUpdateFailures = options.trafficUpdateFailures ?? 0;
  let pauseCalls = 0;
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    const joined = [command, ...args].join(" ");
    if (joined.includes("run services describe")) return JSON.stringify(service);
    if (joined.includes("artifacts docker images describe")) return `${manifest.image}\n`;
    if (joined.includes("secrets versions describe")) return "ENABLED\n";
    if (joined.includes("secrets versions access")) return "internal-token\n";
    if (joined.includes("services enable cloudscheduler.googleapis.com")) return "";
    if (joined.includes("scheduler jobs describe")) {
      if (options.failSchedulerDescribe) throw new Error("permission denied");
      if (!scheduler) throw new Error("not found");
      return JSON.stringify(scheduler);
    }
    if (joined.includes("scheduler jobs create http")) {
      scheduler = schedulerFromArgs(args, "ENABLED");
      return "";
    }
    if (joined.includes("scheduler jobs update http")) {
      if (schedulerUpdateFailures > 0) {
        schedulerUpdateFailures -= 1;
        scheduler = { ...scheduler, state: "UPDATE_FAILED" };
        throw new Error("scheduler update failed");
      }
      scheduler = schedulerFromArgs(
        args,
        scheduler?.state === "UPDATE_FAILED" ? "ENABLED" : (scheduler?.state ?? "ENABLED")
      );
      return "";
    }
    if (joined.includes("scheduler jobs pause")) {
      pauseCalls += 1;
      if (options.failSchedulerPauseAfterFirst && pauseCalls > 1) throw new Error("pause failed");
      if (scheduler?.state !== "ENABLED") throw new Error("scheduler is not enabled");
      scheduler = { ...scheduler, state: "PAUSED" };
      return "";
    }
    if (joined.includes("scheduler jobs resume")) {
      if (options.failSchedulerResume) throw new Error("resume failed");
      if (scheduler?.state !== "PAUSED") throw new Error("scheduler is not paused");
      scheduler = { ...scheduler, state: "ENABLED" };
      return "";
    }
    if (joined.includes("scheduler jobs run")) return "";
    if (joined.includes("logging read")) {
      const status = options.failSchedulerExecution ? 401 : 200;
      return JSON.stringify([
        {
          timestamp: new Date(Date.now() + 1_000).toISOString(),
          jsonPayload: {
            "@type": "type.googleapis.com/google.cloud.scheduler.logging.AttemptFinished",
            debugInfo: `URL_CRAWLED. Original HTTP response code number = ${status}`,
            jobName: `projects/${manifest.target.project}/locations/${manifest.scheduler.location}/jobs/${manifest.scheduler.job}`,
            targetType: "HTTP",
            url: scheduler.httpTarget.uri
          }
        }
      ]);
    }
    if (joined.includes("run services get-iam-policy")) {
      return JSON.stringify({
        bindings: [{ role: "roles/run.invoker", members: ["allUsers"] }]
      });
    }
    if (joined.includes("beta run domain-mappings describe")) {
      return JSON.stringify({
        spec: { routeName: manifest.target.service },
        status: {
          conditions: [{ type: "CertificateProvisioned", status: "True" }]
        }
      });
    }
    if (joined.includes("projects describe")) return "123456789\n";
    if (joined.includes("artifacts repositories get-iam-policy")) {
      return JSON.stringify({
        bindings: [
          {
            role: "roles/artifactregistry.reader",
            members: options.omitImageReader
              ? []
              : ["serviceAccount:service-123456789@serverless-robot-prod.iam.gserviceaccount.com"]
          }
        ]
      });
    }
    if (joined.includes(`run revisions describe ${OLD_REVISION}`)) {
      const env = [];
      if (options.servingInboxVersion) {
        env.push(
          { name: "JINA_GITHUB_WEBHOOK_INBOX_ENABLED", value: "true" },
          { name: "GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY_VERSION", value: options.servingInboxVersion },
          {
            name: "GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY",
            valueFrom: {
              secretKeyRef: {
                name: options.servingInboxSecretName ?? "jina-github-webhook-inbox-encryption-key",
                key: options.servingInboxMountedVersion ?? options.servingInboxVersion
              }
            }
          }
        );
      }
      return JSON.stringify({
        spec: { containers: [{ env }] },
        status: { conditions: [{ type: "Ready", status: "True" }] }
      });
    }
    if (joined.includes("run revisions describe")) {
      return JSON.stringify({
        status: { conditions: [{ type: "Ready", status: "True" }] }
      });
    }
    if (joined.includes("run deploy")) {
      service = cloudRunService(manifest, OLD_REVISION, { candidateTag: true });
      return "";
    }
    if (joined.includes("run services update-traffic")) {
      if (trafficUpdateFailures > 0) {
        trafficUpdateFailures -= 1;
        throw new Error("traffic update failed");
      }
      const target = args
        .find((arg) => arg.startsWith("--to-revisions="))
        ?.slice("--to-revisions=".length)
        .split("=")[0];
      service = cloudRunService(manifest, target, {
        candidateTag: target === CANDIDATE_REVISION
      });
      return "";
    }
    throw new Error(`unexpected fake command: ${joined}`);
  };
  return {
    calls,
    runner,
    setServingRevision(revision) {
      service = cloudRunService(manifest, revision, {
        candidateTag: revision === CANDIDATE_REVISION
      });
    },
    setCandidateDeployed() {
      service = cloudRunService(manifest, OLD_REVISION, { candidateTag: true });
    },
    scheduler() {
      return scheduler;
    }
  };
}

function schedulerFromArgs(args, state) {
  const value = (prefix) => args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  return {
    state,
    schedule: value("--schedule="),
    timeZone: value("--time-zone="),
    httpTarget: {
      uri: value("--uri="),
      httpMethod: "POST",
      headers: { "Content-Type": "application/json" },
      oidcToken: {
        serviceAccountEmail: value("--oidc-service-account-email="),
        audience: value("--oidc-token-audience=")
      }
    }
  };
}

function schedulerForEndpoint(endpoint, state, manifest) {
  return {
    state,
    schedule: manifest.scheduler.schedule,
    timeZone: manifest.scheduler.timeZone,
    httpTarget: {
      uri: endpoint,
      httpMethod: "POST",
      headers: { "Content-Type": "application/json" },
      oidcToken: {
        serviceAccountEmail: manifest.scheduler.oidcServiceAccount,
        audience: manifest.scheduler.oidcAudience
      }
    }
  };
}

function acceptanceEvidence(manifest) {
  return {
    schema_version: 1,
    release_id: manifest.releaseId,
    source_sha: manifest.sourceSha,
    image: manifest.image,
    revision: CANDIDATE_REVISION,
    tagged_url: "https://candidate---jina-code-review-api-abc123-ue.a.run.app",
    completed_at: "2026-08-06T17:00:00.000Z",
    checks: {
      health: true,
      github_oauth: true,
      read_only_product: true,
      encrypted_integration: true,
      internal_callback: true,
      autumn: true,
      graph: true,
      inbox_capture: true,
      inbox_replay: true
    }
  };
}

async function fakeFenceInboxProcessor() {
  return { previousMode: "legacy_forward", changed: true, fencedGeneration: 2 };
}

async function fakeRestoreInboxProcessor() {}

const fakeInboxFenceDependencies = {
  fenceInboxProcessor: fakeFenceInboxProcessor,
  restoreInboxProcessor: fakeRestoreInboxProcessor
};

test("manifest requires the fixed public target, a digest, and numeric secret versions", () => {
  const raw = rawManifest();
  const manifest = validatePublicApiCandidateManifest(raw);
  const args = buildPublicApiDeployArgs(manifest);
  assert.ok(args.includes("--no-traffic"));
  assert.ok(args.includes("--tag=candidate"));
  assert.ok(args.includes(`--image=${raw.image}`));
  const setSecrets = args.find((arg) => arg.startsWith("--set-secrets="));
  assert.match(setSecrets, /GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY=jina-github-webhook-inbox-encryption-key:7/);
  assert.doesNotMatch(setSecrets, /latest/);

  for (const mutate of [
    (copy) => {
      copy.image = "us-east1-docker.pkg.dev/jina-v2/jina/api:latest";
    },
    (copy) => {
      copy.target.project = "jina-v2";
    },
    (copy) => {
      copy.secrets.DB_PASS.version = "latest";
    },
    (copy) => {
      copy.secrets.DB_PASS.project = "jina-v2";
    },
    (copy) => {
      copy.secrets.GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY.name = "another-key";
    },
    (copy) => {
      copy.environment.EXTRA_API_KEY = "plaintext";
    }
  ]) {
    const copy = structuredClone(raw);
    mutate(copy);
    assert.throws(() => validatePublicApiCandidateManifest(copy));
  }
});

test("candidate validation proves the immutable inputs and production edge before deploy", async () => {
  const manifest = validatePublicApiCandidateManifest(rawManifest());
  const cloud = fakeCloud(manifest);
  const result = await validatePublicApiCandidateState(manifest, cloud.runner);
  assert.equal(result.servingRevision, OLD_REVISION);
  assert.ok(cloud.calls.some((call) => call.join(" ").includes("domain-mappings describe")));
  assert.ok(cloud.calls.some((call) => call.join(" ").includes("repositories get-iam-policy")));
  assert.ok(cloud.calls.filter((call) => call.join(" ").includes("secrets versions describe")).length >= 9);
  assert.equal(
    cloud.calls.some((call) => call.join(" ").includes("run deploy")),
    false
  );
});

test("candidate deployment is no-traffic, keeps the old revision serving, and probes its tag", async () => {
  const manifest = validatePublicApiCandidateManifest(rawManifest());
  const cloud = fakeCloud(manifest);
  const probes = [];
  const result = await deployPublicApiCandidate(manifest, {
    runner: cloud.runner,
    probe: async (url) => probes.push(url)
  });
  assert.equal(result.revision, CANDIDATE_REVISION);
  assert.deepEqual(probes, ["https://candidate---jina-code-review-api-abc123-ue.a.run.app/health"]);
  const deployIndex = cloud.calls.findIndex((call) => call.join(" ").includes("run deploy"));
  assert.ok(deployIndex > 0);
  assert.ok(cloud.calls.slice(0, deployIndex).every((call) => !call.join(" ").includes("update-traffic")));
});

test("a failed prerequisite cannot reach the Cloud Run deploy mutation", async () => {
  const manifest = validatePublicApiCandidateManifest(rawManifest());
  const cloud = fakeCloud(manifest, { omitImageReader: true });
  await assert.rejects(
    deployPublicApiCandidate(manifest, { runner: cloud.runner, probe: async () => {} }),
    /cannot pull/
  );
  assert.equal(
    cloud.calls.some((call) => call.join(" ").includes("run deploy")),
    false
  );
});

test("promotion and rollback accept only the manifest revisions and verify 100 percent traffic", async () => {
  const manifest = validatePublicApiCandidateManifest(rawManifest());
  const cloud = fakeCloud(manifest);
  cloud.setCandidateDeployed();
  const evidence = acceptanceEvidence(manifest);
  assert.deepEqual(validatePublicApiAcceptanceEvidence(evidence, manifest, new Date("2026-08-06T18:00:00.000Z")), {
    taggedUrl: evidence.tagged_url,
    completedAt: evidence.completed_at
  });
  await updatePublicApiTraffic(manifest, CANDIDATE_REVISION, {
    runner: cloud.runner,
    ...fakeInboxFenceDependencies,
    acceptanceEvidence: evidence,
    loadInboxSnapshot: async () => ({ activeKeyVersions: { 7: 0 } }),
    now: new Date("2026-08-06T18:00:00.000Z")
  });
  cloud.setServingRevision(CANDIDATE_REVISION);
  await updatePublicApiTraffic(manifest, OLD_REVISION, {
    runner: cloud.runner,
    ...fakeInboxFenceDependencies
  });
  await assert.rejects(
    updatePublicApiTraffic(manifest, "jina-code-review-api-unrecorded", { runner: cloud.runner }),
    /not the manifest candidate or rollback revision/
  );
  assert.equal(cloud.calls.filter((call) => call.join(" ").includes("run services update-traffic")).length, 2);
  const promoteIndex = cloud.calls.findIndex((call) => call.join(" ").includes("run services update-traffic"));
  const resumeIndex = cloud.calls.findIndex((call) => call.join(" ").includes("scheduler jobs resume"));
  assert.ok(resumeIndex > promoteIndex);
  assert.ok(cloud.calls.some((call) => call.join(" ").includes("scheduler jobs run")));
  assert.ok(cloud.calls.some((call) => call.join(" ").includes("logging read")));
  const trafficIndexes = cloud.calls.flatMap((call, index) =>
    call.join(" ").includes("run services update-traffic") ? [index] : []
  );
  const pauseIndexes = cloud.calls.flatMap((call, index) =>
    call.join(" ").includes("scheduler jobs pause") ? [index] : []
  );
  assert.ok(pauseIndexes.at(-1) < trafficIndexes[1]);
  assert.equal(cloud.scheduler().state, "PAUSED");
});

test("promotion rejects active inbox rows encrypted by an unavailable key version", async () => {
  const manifest = validatePublicApiCandidateManifest(rawManifest());
  const cloud = fakeCloud(manifest);
  cloud.setCandidateDeployed();
  assert.throws(
    () => validateInboxKeyCompatibility({ activeKeyVersions: { 6: 2, 7: 4 } }, manifest),
    /cannot process active rows encrypted by 6:2/
  );
  await assert.rejects(
    updatePublicApiTraffic(manifest, CANDIDATE_REVISION, {
      runner: cloud.runner,
      ...fakeInboxFenceDependencies,
      acceptanceEvidence: acceptanceEvidence(manifest),
      loadInboxSnapshot: async () => ({ activeKeyVersions: { 6: 2, 7: 4 } }),
      now: new Date("2026-08-06T18:00:00.000Z")
    }),
    /cannot process active rows encrypted by 6:2/
  );
  assert.equal(
    cloud.calls.some((call) => call.join(" ").includes("services enable cloudscheduler")),
    false
  );
  assert.equal(
    cloud.calls.some((call) => call.join(" ").includes("update-traffic")),
    false
  );
});

test("application rollback fence requires capture_only and zero current/prior-generation leases", () => {
  assert.equal(
    isInboxFenceComplete({
      control: { mode: "capture_only", generation: 2 },
      leased: 0,
      priorGenerationLeases: 0
    }),
    true
  );
  for (const snapshot of [
    { control: { mode: "legacy_forward", generation: 1 }, leased: 0, priorGenerationLeases: 0 },
    { control: { mode: "capture_only", generation: 2 }, leased: 1, priorGenerationLeases: 1 }
  ]) {
    assert.equal(isInboxFenceComplete(snapshot), false);
  }
  assert.throws(
    () =>
      validateInboxFenceSnapshot({
        control: { mode: "capture_only", generation: 2 },
        leased: -1,
        priorGenerationLeases: 0
      }),
    /inbox fence leased/
  );
});

test("inbox compensation cannot overwrite a newer safety generation", () => {
  const snapshot = {
    control: { mode: "capture_only", generation: 3 },
    leased: 0,
    priorGenerationLeases: 0
  };
  assert.throws(
    () => validateInboxRestoreSnapshot(snapshot, { fencedGeneration: 2 }),
    /generation changed from 2 to 3/
  );
  assert.deepEqual(validateInboxRestoreSnapshot(snapshot, { fencedGeneration: 3 }), snapshot);
});

test("promotion rejects a concurrently serving inbox writer on another key version", async () => {
  const manifest = validatePublicApiCandidateManifest(rawManifest());
  assert.throws(
    () =>
      validateServingInboxWriterKey(
        {
          spec: {
            containers: [
              {
                env: [
                  { name: "JINA_GITHUB_WEBHOOK_INBOX_ENABLED", value: "true" },
                  { name: "GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY_VERSION", value: "6" },
                  {
                    name: "GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY",
                    valueFrom: {
                      secretKeyRef: { name: "jina-github-webhook-inbox-encryption-key", key: "7" }
                    }
                  }
                ]
              }
            ]
          }
        },
        manifest
      ),
    /currently serving inbox writer uses key version 6/
  );
  const cloud = fakeCloud(manifest, { servingInboxVersion: "6", servingInboxMountedVersion: "7" });
  cloud.setCandidateDeployed();
  await assert.rejects(
    updatePublicApiTraffic(manifest, CANDIDATE_REVISION, {
      runner: cloud.runner,
      ...fakeInboxFenceDependencies,
      acceptanceEvidence: acceptanceEvidence(manifest),
      loadInboxSnapshot: async () => ({ activeKeyVersions: { 7: 1 } }),
      now: new Date("2026-08-06T18:00:00.000Z")
    }),
    /currently serving inbox writer uses key version 6/
  );
  assert.equal(
    cloud.calls.some((call) => call.join(" ").includes("services enable cloudscheduler")),
    false
  );
  assert.equal(
    cloud.calls.some((call) => call.join(" ").includes("update-traffic")),
    false
  );
});

test("promotion rejects a serving writer whose mounted secret version differs from its label", async () => {
  const manifest = validatePublicApiCandidateManifest(rawManifest());
  const cloud = fakeCloud(manifest, {
    servingInboxVersion: "7",
    servingInboxMountedVersion: "6"
  });
  cloud.setCandidateDeployed();
  await assert.rejects(
    updatePublicApiTraffic(manifest, CANDIDATE_REVISION, {
      runner: cloud.runner,
      ...fakeInboxFenceDependencies,
      acceptanceEvidence: acceptanceEvidence(manifest),
      loadInboxSnapshot: async () => ({ activeKeyVersions: { 7: 1 } }),
      now: new Date("2026-08-06T18:00:00.000Z")
    }),
    /mounts key version 6/
  );
  assert.equal(
    cloud.calls.some((call) => call.join(" ").includes("update-traffic")),
    false
  );
});

test("promotion rejects a serving writer on another secret resource with the same version", async () => {
  const manifest = validatePublicApiCandidateManifest(rawManifest());
  const cloud = fakeCloud(manifest, {
    servingInboxVersion: "7",
    servingInboxSecretName: "other-inbox-key"
  });
  cloud.setCandidateDeployed();
  await assert.rejects(
    updatePublicApiTraffic(manifest, CANDIDATE_REVISION, {
      runner: cloud.runner,
      ...fakeInboxFenceDependencies,
      acceptanceEvidence: acceptanceEvidence(manifest),
      loadInboxSnapshot: async () => ({ activeKeyVersions: { 7: 1 } }),
      now: new Date("2026-08-06T18:00:00.000Z")
    }),
    /must bind secret jina-463721\/jina-github-webhook-inbox-encryption-key/
  );
  assert.equal(
    cloud.calls.some((call) => call.join(" ").includes("update-traffic")),
    false
  );
});

test("production inbox scheduler is created dormant, paused, and rebound to the accepted tag", async () => {
  const manifest = validatePublicApiCandidateManifest(rawManifest());
  const cloud = fakeCloud(manifest);
  const taggedUrl = "https://candidate---jina-code-review-api-abc123-ue.a.run.app";
  await ensureProductionInboxSchedulerPaused(manifest, taggedUrl, cloud.runner);
  assert.equal(cloud.scheduler().state, "PAUSED");
  assert.equal(cloud.scheduler().httpTarget.uri, `${taggedUrl}/internal/github-webhook-inbox/process`);
  const create = cloud.calls.find((call) => call.join(" ").includes("scheduler jobs create http"));
  assert.ok(create.includes("--schedule=0 0 1 1 *"));
  const update = cloud.calls.find((call) => call.join(" ").includes("scheduler jobs update http"));
  assert.ok(update.includes("--schedule=* * * * *"));
});

test("scheduler provisioning does not hide an authorization failure as a missing job", async () => {
  const manifest = validatePublicApiCandidateManifest(rawManifest());
  const cloud = fakeCloud(manifest, { failSchedulerDescribe: true });
  await assert.rejects(
    ensureProductionInboxSchedulerPaused(
      manifest,
      "https://candidate---jina-code-review-api-abc123-ue.a.run.app",
      cloud.runner
    ),
    /permission denied/
  );
  assert.equal(
    cloud.calls.some((call) => call.join(" ").includes("scheduler jobs create http")),
    false
  );
});

test("scheduler activation failure restores the previously serving revision", async () => {
  const manifest = validatePublicApiCandidateManifest(rawManifest());
  const cloud = fakeCloud(manifest, { failSchedulerResume: true });
  cloud.setCandidateDeployed();
  await assert.rejects(
    updatePublicApiTraffic(manifest, CANDIDATE_REVISION, {
      runner: cloud.runner,
      ...fakeInboxFenceDependencies,
      acceptanceEvidence: acceptanceEvidence(manifest),
      loadInboxSnapshot: async () => ({ activeKeyVersions: { 7: 0 } }),
      now: new Date("2026-08-06T18:00:00.000Z")
    }),
    /traffic and scheduler restored to their prior state/
  );
  assert.equal(cloud.calls.filter((call) => call.join(" ").includes("run services update-traffic")).length, 2);
  assert.equal(cloud.scheduler().state, "PAUSED");
});

test("a failed scheduler rebind restores the prior endpoint and enabled state", async () => {
  const manifest = validatePublicApiCandidateManifest(rawManifest());
  const priorEndpoint =
    "https://prior---jina-code-review-api-abc123-ue.a.run.app/internal/github-webhook-inbox/process";
  const cloud = fakeCloud(manifest, {
    existingSchedulerEndpoint: priorEndpoint,
    schedulerUpdateFailures: 1
  });
  await assert.rejects(
    ensureProductionInboxSchedulerPaused(
      manifest,
      "https://candidate---jina-code-review-api-abc123-ue.a.run.app",
      cloud.runner
    ),
    /scheduler update failed/
  );
  assert.equal(cloud.scheduler().httpTarget.uri, priorEndpoint);
  assert.equal(cloud.scheduler().state, "ENABLED");
});

test("a traffic mutation failure restores the prior scheduler endpoint and state", async () => {
  const manifest = validatePublicApiCandidateManifest(rawManifest());
  const priorEndpoint =
    "https://prior---jina-code-review-api-abc123-ue.a.run.app/internal/github-webhook-inbox/process";
  const cloud = fakeCloud(manifest, {
    existingSchedulerEndpoint: priorEndpoint,
    trafficUpdateFailures: 1
  });
  cloud.setCandidateDeployed();
  await assert.rejects(
    updatePublicApiTraffic(manifest, CANDIDATE_REVISION, {
      runner: cloud.runner,
      ...fakeInboxFenceDependencies,
      acceptanceEvidence: acceptanceEvidence(manifest),
      loadInboxSnapshot: async () => ({ activeKeyVersions: { 7: 0 } }),
      now: new Date("2026-08-06T18:00:00.000Z")
    }),
    /traffic update failed/
  );
  assert.equal(cloud.scheduler().httpTarget.uri, priorEndpoint);
  assert.equal(cloud.scheduler().state, "ENABLED");
});

test("an unsuccessful authenticated scheduler execution rolls traffic back", async () => {
  const manifest = validatePublicApiCandidateManifest(rawManifest());
  const cloud = fakeCloud(manifest, { failSchedulerExecution: true });
  cloud.setCandidateDeployed();
  await assert.rejects(
    updatePublicApiTraffic(manifest, CANDIDATE_REVISION, {
      runner: cloud.runner,
      ...fakeInboxFenceDependencies,
      acceptanceEvidence: acceptanceEvidence(manifest),
      loadInboxSnapshot: async () => ({ activeKeyVersions: { 7: 0 } }),
      now: new Date("2026-08-06T18:00:00.000Z")
    }),
    /did not complete successfully \(HTTP 401\)/
  );
  assert.equal(cloud.calls.filter((call) => call.join(" ").includes("run services update-traffic")).length, 2);
  assert.equal(cloud.scheduler().state, "PAUSED");
});

test("failed scheduler fencing leaves candidate traffic in place and reports manual intervention", async () => {
  const manifest = validatePublicApiCandidateManifest(rawManifest());
  const cloud = fakeCloud(manifest, {
    failSchedulerExecution: true,
    failSchedulerPauseAfterFirst: true
  });
  cloud.setCandidateDeployed();
  await assert.rejects(
    updatePublicApiTraffic(manifest, CANDIDATE_REVISION, {
      runner: cloud.runner,
      ...fakeInboxFenceDependencies,
      acceptanceEvidence: acceptanceEvidence(manifest),
      loadInboxSnapshot: async () => ({ activeKeyVersions: { 7: 0 } }),
      now: new Date("2026-08-06T18:00:00.000Z")
    }),
    /scheduler fencing failed; traffic was not rolled back/
  );
  assert.equal(cloud.calls.filter((call) => call.join(" ").includes("run services update-traffic")).length, 1);
  assert.equal(cloud.scheduler().state, "ENABLED");
});

test("pausing an already-paused owned scheduler is idempotent", async () => {
  const manifest = validatePublicApiCandidateManifest(rawManifest());
  const endpoint = "https://prior---jina-code-review-api-abc123-ue.a.run.app/internal/github-webhook-inbox/process";
  const cloud = fakeCloud(manifest, {
    existingSchedulerEndpoint: endpoint,
    existingSchedulerState: "PAUSED"
  });
  assert.equal(await pauseProductionInboxSchedulerIfPresent(manifest, cloud.runner), true);
  assert.equal(
    cloud.calls.some((call) => call.join(" ").includes("scheduler jobs pause")),
    false
  );
  assert.equal(cloud.scheduler().state, "PAUSED");
});

test("rollback tolerates a production inbox scheduler that has never been created", async () => {
  const manifest = validatePublicApiCandidateManifest(rawManifest());
  const cloud = fakeCloud(manifest);
  assert.equal(await pauseProductionInboxSchedulerIfPresent(manifest, cloud.runner), false);
  assert.equal(
    cloud.calls.some((call) => call.join(" ").includes("scheduler jobs pause")),
    false
  );
});

test("rollback does not hide a scheduler authorization failure", async () => {
  const manifest = validatePublicApiCandidateManifest(rawManifest());
  const cloud = fakeCloud(manifest, { failSchedulerDescribe: true });
  await assert.rejects(pauseProductionInboxSchedulerIfPresent(manifest, cloud.runner), /permission denied/);
});

test("promotion cannot mutate traffic without fresh complete acceptance evidence", async () => {
  const manifest = validatePublicApiCandidateManifest(rawManifest());
  const cloud = fakeCloud(manifest);
  cloud.setCandidateDeployed();
  await assert.rejects(
    updatePublicApiTraffic(manifest, CANDIDATE_REVISION, { runner: cloud.runner }),
    /requires complete acceptance evidence/
  );
  const stale = acceptanceEvidence(manifest);
  stale.completed_at = "2026-08-05T17:00:00.000Z";
  await assert.rejects(
    updatePublicApiTraffic(manifest, CANDIDATE_REVISION, {
      runner: cloud.runner,
      ...fakeInboxFenceDependencies,
      acceptanceEvidence: stale,
      now: new Date("2026-08-06T18:00:00.000Z")
    }),
    /no more than four hours old/
  );
  assert.equal(
    cloud.calls.some((call) => call.join(" ").includes("update-traffic")),
    false
  );
});
