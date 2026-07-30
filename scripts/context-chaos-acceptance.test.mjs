import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  contextChaosManifest,
  runBuiltInChaosScenario,
  runContextChaosAcceptance
} from "./context-chaos-acceptance.mjs";

test("chaos manifest names every documented case and has no declared live-boundary gap", () => {
  const manifest = contextChaosManifest();
  assert.equal(manifest.schemaVersion, "context-chaos-acceptance-v1");
  assert.equal(manifest.cases.length, 20);
  assert.equal(new Set(manifest.cases.map((entry) => entry.id)).size, 20);
  assert.deepEqual(
    manifest.cases.filter((entry) => entry.unsupported),
    []
  );
  assert.equal(
    manifest.cases.every(
      (entry) =>
        entry.requirement.length > 0 &&
        entry.proofGroups.length > 0 &&
        entry.proofGroups.every(
          (group) => group in manifest.proofGroups && manifest.proofGroups[group].tests.length > 0
        )
    ),
    true
  );
});

test("chaos report passes when every retained proof and scenario passes", async () => {
  const report = await runContextChaosAcceptance(
    { proofMode: "run", timeoutMs: 10_000 },
    {
      now: sequenceClock(),
      candidateIdentity: async () => ({ head: "a".repeat(40), dirty: false, statusSha256: "b".repeat(64) }),
      proofRunner: async (id) => ({ id, status: "passed", exitCode: 0 }),
      scenarioRunner: async (id) => ({ id, status: "passed", kind: "fixture" })
    }
  );
  assert.equal(report.status, "passed");
  assert.deepEqual(report.summary, { total: 20, passed: 20, failed: 0, unsupported: 0 });
  assert.equal(report.configuration.productionMutationAllowed, false);
  assert.equal(report.cases.find((entry) => entry.id === "completion_response_lost")?.status, "passed");
  assert.equal(report.cases.find((entry) => entry.id === "worker_crash_after_artifact")?.status, "passed");
});

test("a failed reused proof fails every dependent case and the consolidated report", async () => {
  const report = await runContextChaosAcceptance(
    { proofMode: "run", timeoutMs: 10_000 },
    {
      now: sequenceClock(),
      candidateIdentity: async () => ({ head: "a".repeat(40), dirty: true, statusSha256: "b".repeat(64) }),
      proofRunner: async (id) =>
        id === "apiBoard"
          ? { id, status: "failed", exitCode: 1, reason: "fixture failure" }
          : { id, status: "passed", exitCode: 0 },
      scenarioRunner: async (id) => ({ id, status: "passed", kind: "fixture" })
    }
  );
  assert.equal(report.status, "failed");
  assert.ok(report.summary.failed > 0);
  assert.equal(report.cases.find((entry) => entry.id === "completion_response_lost")?.status, "failed");
});

test("isolated process and fake-service scenarios exercise practical failure boundaries", async () => {
  for (const id of [
    "crash_before_artifact",
    "crash_after_artifact",
    "duplicate_claim",
    "gcs_outage",
    "model_timeout_sibling"
  ]) {
    const result = await runBuiltInChaosScenario(id, { proofMode: "run", timeoutMs: 10_000 });
    assert.equal(result.status, "passed", `${id}: ${result.reason ?? "no reason"}`);
  }
});

test("CLI writes a mode-0600 incomplete report and exits two in manifest-only mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jina-context-chaos-cli-"));
  const reportPath = join(directory, "chaos-report.json");
  try {
    await writeFile(reportPath, "stale\n", { mode: 0o644 });
    const result = await runProcess(process.execPath, [
      "scripts/context-chaos-acceptance.mjs",
      "--report",
      reportPath,
      "--proof-mode",
      "manifest-only"
    ]);
    assert.equal(result.code, 2, result.stderr);
    const text = await readFile(reportPath, "utf8");
    const report = JSON.parse(text);
    assert.equal(report.status, "incomplete");
    assert.equal(report.summary.total, 20);
    assert.equal(report.summary.unsupported, 20);
    assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
    assert.equal(text.includes('productionMutationAllowed": true'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function sequenceClock() {
  const values = [new Date("2026-07-30T12:00:00.000Z"), new Date("2026-07-30T12:00:01.000Z")];
  return () => values.shift() ?? new Date("2026-07-30T12:00:01.000Z");
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
