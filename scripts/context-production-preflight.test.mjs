import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const fakeApiKey = "dtn_private_preflight_key";
const fakeBearer = "private-bearer-value";

test("Daytona preflight validates the immutable sandbox and bounded command path without a model", async () => {
  const fixture = await fakeDaytonaFixture();
  try {
    const { stdout, stderr } = await runPreflight(fixture);
    assert.match(stdout, /Daytona production sandbox preflight passed/);
    assert.equal(stderr, "");
    const captured = JSON.parse(await readFile(fixture.capturePath, "utf8"));
    assert.deepEqual(captured, {
      snapshot: null,
      image: `registry.example/board-agent@sha256:${"a".repeat(64)}`,
      envVars: { NODE_ENV: "production", LANG: "C.UTF-8" },
      labels: { "jina-preflight": "context" },
      networkBlockAll: true,
      public: false,
      ephemeral: true,
      ttlMinutes: 5,
      createTimeout: 300,
      commandRequiresFileProbe: true,
      commandTimeout: 60,
      deleted: { timeout: 60, wait: true },
      disposed: true
    });
  } finally {
    await fixture.cleanup();
  }
});

test("Daytona preflight bounds and redacts sandbox failures", async () => {
  const fixture = await fakeDaytonaFixture();
  try {
    await assert.rejects(
      () => runPreflight(fixture, { PREFLIGHT_FAKE_FAILURE: "true" }),
      (error) => {
        const stderr = String(error.stderr);
        assert.match(stderr, /Daytona production sandbox preflight failed/);
        assert.match(stderr, /\[credential-redacted\]/);
        assert.doesNotMatch(stderr, new RegExp(fakeApiKey));
        assert.doesNotMatch(stderr, new RegExp(fakeBearer));
        assert.doesNotMatch(stderr, /dtn_secret_private_placeholder/);
        assert.ok(stderr.length < 4_000, `diagnostic was ${stderr.length} bytes`);
        return true;
      }
    );
  } finally {
    await fixture.cleanup();
  }
});

test("Board drain pauses the worker generation after reaching zero leases", async () => {
  const fixture = await fakeDatabaseFixture();
  try {
    const credential = "release-credential-value-000000000000";
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["scripts/context-production-preflight.mjs", "board-await-drain"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CONTEXT_RESET_MODULE_PATH: fixture.resetPath,
          DATABASE_URL: "postgresql://fake.invalid/jina",
          CONTEXT_RUNTIME_DB_USER: "jina_v2_app",
          JINA_WORKER_RELEASE_ID: "release-under-test",
          JINA_WORKER_RELEASE_CREDENTIAL: credential,
          FAKE_DB_CAPTURE_PATH: fixture.capturePath,
          FAKE_RELEASE_CREDENTIAL: credential
        }
      }
    );
    assert.equal(stderr, "");
    assert.match(stdout, /release_control\.board_drained_and_worker_paused/);
    assert.match(stdout, /"workerGenerationPreserved":false/);
    const queries = JSON.parse(await readFile(fixture.capturePath, "utf8"));
    assert.ok(queries.some((query) => query.includes("set worker_claims_enabled=false, worker_accepts_claims=false")));
    assert.ok(
      queries.some((query) => query.includes('revoke insert,update on jina_runtime.api_state from "jina_v2_app"'))
    );
  } finally {
    await fixture.cleanup();
  }
});

async function fakeDaytonaFixture() {
  const directory = await mkdtemp(join(tmpdir(), "jina-daytona-preflight-test-"));
  const modulePath = join(directory, "daytona.mjs");
  const anchorPath = join(directory, "anchor.mjs");
  const capturePath = join(directory, "capture.json");
  await writeFile(anchorPath, "export {};\n", "utf8");
  await writeFile(
    modulePath,
    `
      import { readFileSync, writeFileSync } from "node:fs";

      function capture(patch) {
        let value = {};
        try { value = JSON.parse(readFileSync(process.env.PREFLIGHT_CAPTURE_PATH, "utf8")); } catch {}
        writeFileSync(process.env.PREFLIGHT_CAPTURE_PATH, JSON.stringify({ ...value, ...patch }));
      }

      export class Daytona {
        constructor(options) {
          this.options = options;
          this.snapshot = {
            get: async (name) => ({ name, state: "active" })
          };
        }

        async create(input, options) {
          if (process.env.PREFLIGHT_FAKE_FAILURE === "true") {
            throw new Error(
              "sandbox failed " +
                process.env.DAYTONA_API_KEY +
                " Bearer ${fakeBearer} dtn_secret_private_placeholder " +
                "x".repeat(5_000) +
                " " +
                process.env.DAYTONA_API_KEY
            );
          }
          return {
            process: {
              executeCommand: async (command, cwd, env, timeout) => {
                capture({
                  snapshot: input.snapshot ?? null,
                  image: input.image ?? null,
                  envVars: input.envVars,
                  labels: input.labels,
                  networkBlockAll: input.networkBlockAll,
                  public: input.public,
                  ephemeral: input.ephemeral,
                  ttlMinutes: input.ttlMinutes,
                  createTimeout: options.timeout,
                  commandRequiresFileProbe:
                    command.includes("/tmp/jina-context-preflight") && command.includes("TOOL_OK"),
                  commandTimeout: timeout
                });
                return { exitCode: 0, result: "AUTH_OK" };
              }
            },
            delete: async (timeout, wait) => capture({ deleted: { timeout, wait } })
          };
        }

        async [Symbol.asyncDispose]() {
          capture({ disposed: true });
        }
      }
    `,
    "utf8"
  );
  return {
    modulePath,
    anchorPath,
    capturePath,
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

async function fakeDatabaseFixture() {
  const directory = await mkdtemp(join(tmpdir(), "jina-production-database-test-"));
  const resetPath = join(directory, "reset.mjs");
  const pgDirectory = join(directory, "node_modules", "pg");
  const capturePath = join(directory, "queries.json");
  await mkdir(pgDirectory, { recursive: true });
  await writeFile(resetPath, "export {};\n", "utf8");
  await writeFile(
    join(pgDirectory, "index.js"),
    `
      const { createHash } = require("node:crypto");
      const { writeFileSync } = require("node:fs");

      const queries = [];
      const client = {
        async query(sql) {
          const query = String(sql).replace(/\\s+/g, " ").trim();
          queries.push(query);
          if (query.includes("select lease_release_id")) {
            return {
              rows: [{
                lease_release_id: "release-under-test",
                lease_credential_sha256: createHash("sha256")
                  .update(process.env.FAKE_RELEASE_CREDENTIAL, "utf8")
                  .digest("hex"),
                lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
                worker_claims_enabled: false
              }]
            };
          }
          if (query.includes("to_regclass('jina_runtime.api_state')")) {
            return { rows: [{ relation: "jina_runtime.api_state" }] };
          }
          if (query.includes("select snapshot from jina_runtime.api_state")) {
            return { rows: [{ snapshot: { intakeState: { board: { outbox: [] } } } }] };
          }
          return { rows: [] };
        },
        release() {}
      };

      class Pool {
        async connect() { return client; }
        async end() {
          writeFileSync(process.env.FAKE_DB_CAPTURE_PATH, JSON.stringify(queries));
        }
      }

      module.exports = { Pool };
    `,
    "utf8"
  );
  return {
    resetPath,
    capturePath,
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

async function runPreflight(fixture, additionalEnvironment = {}) {
  return execFileAsync(process.execPath, ["scripts/context-production-preflight.mjs", "daytona"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DAYTONA_API_KEY: fakeApiKey,
      CONTEXT_DAYTONA_MODULE_PATH: fixture.anchorPath,
      CONTEXT_DAYTONA_SDK_MODULE_PATH: fixture.modulePath,
      CONTEXT_DAYTONA_SNAPSHOT: "",
      CONTEXT_DAYTONA_IMAGE: `registry.example/board-agent@sha256:${"a".repeat(64)}`,
      PREFLIGHT_CAPTURE_PATH: fixture.capturePath,
      ...additionalEnvironment
    }
  });
}
