import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const releaseBuild = await readFile("cloudbuild.release-build.yaml", "utf8");

test("release build validates once and emits all immutable candidate image families", () => {
  assert.match(releaseBuild, /test "\$\(git rev-parse HEAD\)" = "\$\{COMMIT_SHA\}"/);
  assert.match(releaseBuild, /args: \[scripts\/cloud-build-ci\.sh\]/);
  for (const image of ["api", "worker", "dashboard", "admin"]) {
    assert.match(
      releaseBuild,
      new RegExp(`us-east1-docker\\.pkg\\.dev/\\$PROJECT_ID/jina/${image}:\\$\\{_RELEASE_ID\\}`)
    );
  }
  assert.match(releaseBuild, /requestedVerifyOption: VERIFIED/);
  assert.match(releaseBuild, /sourceProvenanceHash: \[SHA256\]/);
  assert.match(releaseBuild, /release-build-source\.json/);
});

test("release build cannot deploy, migrate, drain, read runtime secrets, or explicitly push", () => {
  for (const forbidden of [
    /cloud-build-deploy\.sh/,
    /deploy-staging\.sh/,
    /gcloud run/,
    /gcloud sql/,
    /gcloud secrets/,
    /secretEnv:/,
    /--set-secrets/,
    /docker push/,
    /release-acquire/,
    /worker-drain/,
    /migrate-all\.js/
  ]) {
    assert.doesNotMatch(releaseBuild, forbidden);
  }
});
