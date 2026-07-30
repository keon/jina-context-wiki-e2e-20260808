import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("development quota override is rejected outside the loopback development API", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./dev-server.js", import.meta.url))], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      JINA_ENABLE_DEV_ENDPOINTS: "false",
      JINA_DEV_CONTEXT_MAX_ACTIVE_BUILDS: "8"
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /JINA_DEV_CONTEXT_MAX_ACTIVE_BUILDS requires JINA_ENABLE_DEV_ENDPOINTS=true/);
});
