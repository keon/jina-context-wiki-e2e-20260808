import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPublicApiDeployArgs,
  deployPublicApiCandidate,
  updatePublicApiTraffic,
  validatePublicApiAcceptanceEvidence,
  validatePublicApiCandidateManifest,
  validatePublicApiCandidateState
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
      name: name.toLowerCase().replaceAll("_", "-"),
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
      JINA_REVIEW_BOARD_PIPELINE_MODE: "paused",
      JINA_BILLING_ENFORCE: "on",
      JINA_GRAPH_API_URL: "https://jina-api-m56inn6iva-ue.a.run.app"
    },
    secrets,
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
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    const joined = [command, ...args].join(" ");
    if (joined.includes("run services describe")) return JSON.stringify(service);
    if (joined.includes("artifacts docker images describe")) return `${manifest.image}\n`;
    if (joined.includes("secrets versions describe")) return "ENABLED\n";
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

test("manifest requires the fixed public target, a digest, and numeric secret versions", () => {
  const raw = rawManifest();
  const manifest = validatePublicApiCandidateManifest(raw);
  const args = buildPublicApiDeployArgs(manifest);
  assert.ok(args.includes("--no-traffic"));
  assert.ok(args.includes("--tag=candidate"));
  assert.ok(args.includes(`--image=${raw.image}`));
  const setSecrets = args.find((arg) => arg.startsWith("--set-secrets="));
  assert.match(
    setSecrets,
    /GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY=projects\/jina-463721\/secrets\/github-webhook-inbox-encryption-key:7/
  );
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
    acceptanceEvidence: evidence,
    now: new Date("2026-08-06T18:00:00.000Z")
  });
  cloud.setServingRevision(CANDIDATE_REVISION);
  await updatePublicApiTraffic(manifest, OLD_REVISION, { runner: cloud.runner });
  await assert.rejects(
    updatePublicApiTraffic(manifest, "jina-code-review-api-unrecorded", { runner: cloud.runner }),
    /not the manifest candidate or rollback revision/
  );
  assert.equal(cloud.calls.filter((call) => call.join(" ").includes("run services update-traffic")).length, 2);
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
