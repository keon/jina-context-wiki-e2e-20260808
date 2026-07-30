import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const devUp = await readFile("scripts/dev-up.sh", "utf8");

test("local startup repairs a stale PageIndex requirements stamp", async () => {
  await execFileAsync("bash", ["-n", "scripts/dev-up.sh"]);

  const stampCheck = devUp.indexOf('if [[ ! -f "$requirements_stamp" ]]');
  const repairProbe = devUp.indexOf('if ! PAGEINDEX_SOURCE_ROOT="$PAGEINDEX_SOURCE_ROOT"', stampCheck);
  const repairInstall = devUp.indexOf("install_pageindex_requirements", repairProbe);
  const requiredProbe = devUp.indexOf(
    'PAGEINDEX_SOURCE_ROOT="$PAGEINDEX_SOURCE_ROOT" \\\n  "$CONTEXT_PAGEINDEX_PYTHON" "$CONTEXT_PAGEINDEX_WORKER" --probe >/dev/null',
    repairInstall
  );

  assert.ok(stampCheck > 0);
  assert.ok(repairProbe > stampCheck);
  assert.ok(repairInstall > repairProbe);
  assert.ok(requiredProbe > repairInstall);
  assert.match(
    devUp,
    /install_pageindex_requirements\(\)[\s\S]+?-r "\$REPO\/services\/pageindex-worker\/requirements\.txt"[\s\S]+?: > "\$requirements_stamp"/
  );
});
