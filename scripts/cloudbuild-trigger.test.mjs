import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const build = await readFile("cloudbuild.trigger.yaml", "utf8");
const deploy = await readFile("scripts/deploy-trigger-gcloud.sh", "utf8");

test("gcloud Trigger deployment uses the API's canonical product token secret", () => {
  assert.match(build, /secretEnv:[\s\S]+?- INTERNAL_API_TOKEN/);
  assert.match(build, /env: INTERNAL_API_TOKEN/);
  assert.match(deploy, /internal_api_token_secret="jina-staging-internal-api-token"/);
  assert.match(deploy, /internal_api_token_secret="jina-product-internal-api-token"/);
  assert.match(deploy, /_INTERNAL_API_TOKEN_SECRET=\$\{internal_api_token_secret\}/);
  assert.doesNotMatch(deploy, /internal_api_token_secret="jina-internal-api-token"/);
});

test("production deployment is pinned to the review-only Trigger project", () => {
  const production = deploy.slice(deploy.indexOf("  production)"), deploy.indexOf("  *)"));
  assert.match(production, /trigger_project_ref="proj_yrxsqjznkghpwsolfmjp"/);
  assert.match(production, /_TRIGGER_PROJECT_NAME=jina-review-production/);
  assert.doesNotMatch(production, /proj_gmesnthgwwqledarlfip/);
  assert.doesNotMatch(production, /proj_rqckjugodcaghbpgggbz/);
  assert.match(build, /verify-trigger-project\.mjs/);
  assert.match(build, /EXPECTED_TRIGGER_ORGANIZATION_SLUG=om-labs-77da/);
  assert.doesNotMatch(deploy, /JINA_PRODUCTION_TRIGGER_PROJECT_REF/);
});

test("Trigger build validates the pinned source before deploying", () => {
  const manifest = build.indexOf("verify-trigger-source-manifest.mjs");
  const projectIdentity = build.indexOf("verify-trigger-project.mjs");
  const deployment = build.indexOf("npm run deploy", manifest);
  assert.ok(projectIdentity > 0);
  assert.ok(manifest > projectIdentity);
  assert.ok(manifest > 0);
  assert.ok(deployment > manifest);
  assert.match(build, /npm run typecheck[\s\S]+?npm test[\s\S]+?npm run deploy/);
});

test("Trigger tests cannot inherit deployment credentials", () => {
  const testCommand = build.slice(build.indexOf("        env "), build.indexOf("npm run deploy"));
  for (const secret of [
    "TRIGGER_ACCESS_TOKEN",
    "INTERNAL_API_TOKEN",
    "DAYTONA_API_KEY",
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_CLONE_TOKEN",
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY"
  ]) {
    assert.match(testCommand, new RegExp(`-u ${secret}`));
  }
  assert.match(testCommand, /npm test/);
});

test("every Trigger build secret is pinned to a submitted numeric version", () => {
  assert.doesNotMatch(build, /versions\/latest/);
  assert.equal((build.match(/versionName:/g) ?? []).length, 8);
  assert.equal((build.match(/versions\/\$\{_[A-Z_]+_VERSION\}/g) ?? []).length, 8);
  assert.match(deploy, /gcloud secrets versions list/);
  assert.match(deploy, /\^\[1-9\]\[0-9\]\*\$/);
  assert.doesNotMatch(deploy, /substitutions\[[0-9]+\]/);
  assert.match(deploy, /_INTERNAL_API_TOKEN_VERSION:\$\{internal_api_token_secret\}/);
});

test("the staging wrapper resolves numeric versions for the matching named secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jina-trigger-gcloud-"));
  const fakeGcloud = join(directory, "gcloud");
  const capture = join(directory, "submit.txt");
  await writeFile(
    fakeGcloud,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "secrets" && "\${2:-}" == "versions" && "\${3:-}" == "list" ]]; then
  case "\${4:-}" in
    jina-trigger-access-token) echo projects/jina-staging-20260802/secrets/jina-trigger-access-token/versions/11 ;;
    jina-staging-internal-api-token) echo projects/jina-staging-20260802/secrets/jina-staging-internal-api-token/versions/12 ;;
    jina-staging-daytona-api-key) echo projects/jina-staging-20260802/secrets/jina-staging-daytona-api-key/versions/13 ;;
    jina-staging-github-app-id) echo projects/jina-staging-20260802/secrets/jina-staging-github-app-id/versions/14 ;;
    jina-staging-github-app-private-key) echo projects/jina-staging-20260802/secrets/jina-staging-github-app-private-key/versions/15 ;;
    jina-staging-github-clone-token) echo projects/jina-staging-20260802/secrets/jina-staging-github-clone-token/versions/16 ;;
    jina-staging-openrouter-api-key) echo projects/jina-staging-20260802/secrets/jina-staging-openrouter-api-key/versions/17 ;;
    jina-staging-openai-api-key) echo projects/jina-staging-20260802/secrets/jina-staging-openai-api-key/versions/18 ;;
    *) exit 3 ;;
  esac
  exit 0
fi
printf '%s\n' "$@" > "\${JINA_TEST_GCLOUD_CAPTURE:?}"
`,
    "utf8"
  );
  await chmod(fakeGcloud, 0o755);
  try {
    const result = spawnSync("bash", ["scripts/deploy-trigger-gcloud.sh", "staging"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        JINA_TEST_GCLOUD_CAPTURE: capture
      }
    });
    assert.equal(result.status, 0, result.stderr);
    const submission = await readFile(capture, "utf8");
    const substitutionArgument = submission.split("\n").find((argument) => argument.startsWith("--substitutions="));
    assert.ok(substitutionArgument);
    for (const [name, version] of [
      ["TRIGGER_ACCESS_TOKEN", "11"],
      ["INTERNAL_API_TOKEN", "12"],
      ["DAYTONA_API_KEY", "13"],
      ["GITHUB_APP_ID", "14"],
      ["GITHUB_APP_PRIVATE_KEY", "15"],
      ["GITHUB_CLONE_TOKEN", "16"],
      ["OPENROUTER_API_KEY", "17"],
      ["OPENAI_API_KEY", "18"]
    ]) {
      assert.match(substitutionArgument, new RegExp(`_${name}_VERSION=${version}(?:,|$)`));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
