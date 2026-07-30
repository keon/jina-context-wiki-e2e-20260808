import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  AGENT_KNOWLEDGE_CODEX_ARGS,
  KNOWLEDGE_AGENT_STAGE_DEVELOPER_INSTRUCTIONS,
  createRepositoryArchive,
  findExistingCodex,
  checkpointClaimVerifier,
  checkpointReferenceVerifier,
  contextEvidenceCategories,
  deadlineAwarePrompt,
  improvesHostCheckedOutput,
  isTransientKnowledgeGenerationFailure,
  keepsPartialCatalog,
  MAX_RUN_BUDGET_SECONDS,
  runBudgetSeconds,
  requireDurableOrchestration,
  validateDocumentOutputArchive,
  validatePrivateCheckpointArchive,
  withFinalCheckpoint,
  KNOWLEDGE_PROMPT_STDIN_REDIRECT,
  productionAgentFirstPrompt,
  runDetachedKnowledgeCommand,
  withAgentStageReceiptDiagnostics,
  withCollaborationTranscriptDiagnostics,
  withRemoteAgentStageDiagnostics
} from "./knowledge-document-executor.js";
import {
  LocalCodexKnowledgeDocumentGenerator,
  citationRepairPrompt,
  createDocumentationWorkLedger,
  documentationWorkLedgerStatus,
  readDocumentationWorkLedger,
  retryCitationAuditFormat
} from "./local-knowledge-document-executor.js";

const execFileAsync = promisify(execFile);

test("page structural repair stays bounded when there are no orchestration diagnostics", () => {
  const prompt = citationRepairPrompt(
    "/work/output",
    "/work/state",
    "/checkpoint/repository",
    [
      {
        documentPath: "context/runtime",
        claim: "An unsupported claim",
        target: "src/runtime.ts#L1-L2",
        reason: "claim-absent"
      }
    ],
    [],
    1
  );
  assert.match(prompt, /smallest edit that resolves each exact diagnostic/);
  assert.doesNotMatch(prompt, /agent-owned goal-verification workflow/);
  assert.doesNotMatch(prompt, /worker spawns/);
});

test("host evidence categories distinguish configuration, tests, docs, code, history, and providers", () => {
  assert.deepEqual(contextEvidenceCategories("blob", ".env.example"), ["configuration"]);
  assert.deepEqual(contextEvidenceCategories("blob", "apps/api/.env.production"), ["configuration"]);
  assert.deepEqual(contextEvidenceCategories("blob", "src/cache.test.ts"), ["tests"]);
  assert.deepEqual(contextEvidenceCategories("blob", "docs/cache.md"), ["documentation"]);
  assert.deepEqual(contextEvidenceCategories("blob", "src/cache.ts"), ["code"]);
  assert.deepEqual(contextEvidenceCategories("commit"), ["history"]);
  assert.deepEqual(contextEvidenceCategories("pull_request", "https://github.com/acme/cache/pull/7"), ["provider"]);
});

test("knowledge generation retry classification is bounded to transient failures", () => {
  assert.equal(isTransientKnowledgeGenerationFailure("HTTP 503 from sandbox gateway"), true);
  assert.equal(isTransientKnowledgeGenerationFailure("stream disconnected while reconnecting"), true);
  assert.equal(isTransientKnowledgeGenerationFailure("output failed JSON schema validation"), false);
  assert.equal(isTransientKnowledgeGenerationFailure("permission denied"), false);
  // Verbatim from the deploy this was found in: the sandbox SDK words a gateway
  // failure this way, and the old pattern only matched the "http 502" wording.
  assert.equal(isTransientKnowledgeGenerationFailure("Request failed with status code 502"), true);
  assert.equal(isTransientKnowledgeGenerationFailure("Request failed with status code 429"), true);
  // Also verbatim, and deliberately not transient: retrying a run that used its
  // whole wall clock costs another full DAYTONA_RUN_TIMEOUT_SECONDS, and the
  // pages it already wrote are kept instead.
  assert.equal(isTransientKnowledgeGenerationFailure("command execution timeout"), false);
  assert.equal(isTransientKnowledgeGenerationFailure("Request failed with status code 400"), false);
});

test("detached knowledge execution polls through short requests and reads the private transcript tail", async () => {
  type Executor = Parameters<typeof runDetachedKnowledgeCommand>[0];
  const calls: {
    command: string;
    cwd: string | undefined;
    environment: Record<string, string> | undefined;
    timeout: number | undefined;
  }[] = [];
  let probes = 0;
  const executor: Executor = {
    executeCommand: async (command, cwd, environment, timeout) => {
      calls.push({ command, cwd, environment, timeout });
      if (command.includes("nohup setsid")) return { exitCode: 0, result: "" };
      if (command.includes("if [ -f")) {
        probes += 1;
        if (probes === 1) throw new Error("temporary gateway disconnect");
        return { exitCode: 0, result: "0\n" };
      }
      if (command.includes("tail -c")) return { exitCode: 0, result: "finished secret-value\n" };
      return { exitCode: 0, result: "" };
    }
  };
  let now = 0;

  const result = await runDetachedKnowledgeCommand(
    executor,
    "codex exec --json < '/home/daytona/context-engine/prompt.txt'",
    { OPENAI_API_KEY: "secret-value" },
    90,
    ["secret-value"],
    {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      pollSeconds: 1,
      killGraceSeconds: 1
    }
  );

  assert.deepEqual(result, { exitCode: 0, result: "finished ***REDACTED***" });
  assert.equal(probes, 2);
  const start = calls[0];
  assert.ok(start);
  assert.match(start.command, /nohup setsid sh -c/);
  assert.match(start.command, /derive-state\/transcript\.log/);
  assert.match(start.command, /derive-state\/run-exit-code\.tmp/);
  assert.match(start.command, /mv -f .*run-exit-code\.tmp.*run-exit-code/);
  assert.equal(start.command.includes("derive-output/transcript.log"), false);
  assert.deepEqual(start.environment, { OPENAI_API_KEY: "secret-value" });
  assert.equal(
    calls.every(({ timeout }) => timeout !== undefined && timeout <= 60),
    true,
    "every sandbox request must remain shorter than the gateway window"
  );
  assert.match(calls.at(-1)?.command ?? "", /^rm -f .*run-exit-code/);
});

test("detached knowledge execution kills the complete process group at its budget deadline", async () => {
  type Executor = Parameters<typeof runDetachedKnowledgeCommand>[0];
  const calls: { command: string; timeout: number | undefined }[] = [];
  let terminationAttempts = 0;
  const executor: Executor = {
    executeCommand: async (command, _cwd, _environment, timeout) => {
      calls.push({ command, timeout });
      if (command.includes("nohup setsid")) return { exitCode: 0, result: "" };
      if (command.includes("if [ -f")) return { exitCode: 0, result: "running\n" };
      if (command.includes("pid=$(cat")) {
        terminationAttempts += 1;
        if (terminationAttempts === 1) throw new Error("gateway lost the kill response");
      }
      return { exitCode: 0, result: "" };
    }
  };
  let now = 0;

  const result = await runDetachedKnowledgeCommand(executor, "codex exec", undefined, 2, [], {
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
    pollSeconds: 1,
    killGraceSeconds: 1
  });

  assert.deepEqual(result, { exitCode: 124, result: "command execution timeout" });
  const termination = calls.find(({ command }) => command.includes("pid=$(cat"));
  assert.ok(termination);
  assert.match(termination.command, /kill -TERM -- "-\$pid"/);
  assert.match(termination.command, /kill -KILL -- "-\$pid"/);
  assert.match(termination.command, /sleep 1/);
  assert.equal(terminationAttempts, 2, "termination is retried through a fresh short request");
  assert.equal(
    calls.filter(({ command }) => command.includes("if [ -f")).length,
    3,
    "the deadline is checked after each bounded probe"
  );
  assert.equal(
    calls.every(({ timeout }) => timeout !== undefined && timeout <= 60),
    true
  );
  assert.match(calls.at(-1)?.command ?? "", /^rm -f .*run-exit-code/);
});

test("detached knowledge execution reports a failed launch without polling or leaking credentials", async () => {
  type Executor = Parameters<typeof runDetachedKnowledgeCommand>[0];
  const calls: string[] = [];
  const executor: Executor = {
    executeCommand: async (command) => {
      calls.push(command);
      return command.includes("nohup setsid")
        ? { exitCode: 127, result: "could not launch secret-value" }
        : { exitCode: 0, result: "" };
    }
  };

  const result = await runDetachedKnowledgeCommand(executor, "codex exec", { OPENAI_API_KEY: "secret-value" }, 90, [
    "secret-value"
  ]);

  assert.deepEqual(result, {
    exitCode: 127,
    result: "could not start detached run: could not launch ***REDACTED***"
  });
  assert.equal(
    calls.some((command) => command.includes("if [ -f")),
    false
  );
  assert.match(calls.at(-1) ?? "", /^rm -f .*run-exit-code/);
});

test("an ambiguous detached launch is terminated and cleaned before its gateway error is rethrown", async () => {
  type Executor = Parameters<typeof runDetachedKnowledgeCommand>[0];
  const calls: string[] = [];
  const executor: Executor = {
    executeCommand: async (command) => {
      calls.push(command);
      if (command.includes("nohup setsid")) throw new Error("gateway disconnected after acceptance");
      return { exitCode: 0, result: "" };
    }
  };

  await assert.rejects(
    runDetachedKnowledgeCommand(executor, "codex exec", undefined, 90, []),
    /gateway disconnected after acceptance/
  );

  assert.match(calls[1] ?? "", /while .*run-pid/);
  assert.match(calls[1] ?? "", /kill -TERM -- "-\$pid"/);
  assert.match(calls[1] ?? "", /kill -KILL -- "-\$pid"/);
  assert.match(calls[2] ?? "", /^rm -f .*run-exit-code/);
});

test("an ambiguous launch that cannot confirm a remote PID fails closed instead of racing a retry", async () => {
  type Executor = Parameters<typeof runDetachedKnowledgeCommand>[0];
  const calls: string[] = [];
  const executor: Executor = {
    executeCommand: async (command) => {
      calls.push(command);
      if (command.includes("nohup setsid")) throw new Error("gateway disconnected after acceptance");
      if (command.includes("pid=$(cat")) return { exitCode: 75, result: "" };
      return { exitCode: 0, result: "" };
    }
  };

  await assert.rejects(
    runDetachedKnowledgeCommand(executor, "codex exec", undefined, 90, []),
    /detached run launch cleanup could not be confirmed/
  );

  assert.equal(calls.filter((command) => command.includes("pid=$(cat")).length, 2);
  assert.match(calls.at(-1) ?? "", /^rm -f .*run-exit-code/);
});

test("an invalid detached exit signal is quiesced before it is reported", async () => {
  type Executor = Parameters<typeof runDetachedKnowledgeCommand>[0];
  const calls: string[] = [];
  const executor: Executor = {
    executeCommand: async (command) => {
      calls.push(command);
      if (command.includes("if [ -f")) return { exitCode: 0, result: "not-an-exit-code\n" };
      return { exitCode: 0, result: "" };
    }
  };

  const result = await runDetachedKnowledgeCommand(executor, "codex exec", undefined, 90, []);

  assert.deepEqual(result, {
    exitCode: 1,
    result: "detached run produced an invalid exit code: not-an-exit-code"
  });
  const terminationIndex = calls.findIndex((command) => command.includes("pid=$(cat"));
  const cleanupIndex = calls.findIndex(
    (command, index) => index > 0 && command.startsWith("rm -f") && !command.includes("nohup setsid")
  );
  assert.notEqual(terminationIndex, -1);
  assert.notEqual(cleanupIndex, -1);
  assert.ok(terminationIndex < cleanupIndex);
});

test("detached kill grace is capped so a misconfigured environment cannot create a long request", async () => {
  type Executor = Parameters<typeof runDetachedKnowledgeCommand>[0];
  const calls: { command: string; timeout: number | undefined }[] = [];
  const executor: Executor = {
    executeCommand: async (command, _cwd, _environment, timeout) => {
      calls.push({ command, timeout });
      if (command.includes("if [ -f")) return { exitCode: 0, result: "running\n" };
      return { exitCode: 0, result: "" };
    }
  };
  const previousGrace = process.env.DAYTONA_DETACHED_KILL_GRACE_SECONDS;
  process.env.DAYTONA_DETACHED_KILL_GRACE_SECONDS = "3600";
  let now = 0;
  try {
    const result = await runDetachedKnowledgeCommand(executor, "codex exec", undefined, 1, [], {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      pollSeconds: 1
    });
    assert.deepEqual(result, { exitCode: 124, result: "command execution timeout" });
  } finally {
    if (previousGrace === undefined) delete process.env.DAYTONA_DETACHED_KILL_GRACE_SECONDS;
    else process.env.DAYTONA_DETACHED_KILL_GRACE_SECONDS = previousGrace;
  }

  const termination = calls.find(({ command }) => command.includes("pid=$(cat"));
  assert.ok(termination);
  assert.match(termination.command, /sleep 10/);
  assert.equal(
    calls.every(({ timeout }) => timeout !== undefined && timeout <= 60),
    true
  );
});

test("a run killed by its wall clock keeps the pages already written to disk", () => {
  // The production failure this exists for: derivation ran the full
  // DAYTONA_RUN_TIMEOUT_SECONDS and threw, discarding every finished page.
  assert.equal(keepsPartialCatalog(1), true);
  assert.equal(keepsPartialCatalog(12), true);
  // Nothing written means the run failed before producing anything, and an empty
  // catalog would publish as "no knowledge" instead of surfacing the failure.
  assert.equal(keepsPartialCatalog(0), false);
});

test("private checkpoint archives accept the producer root entry and reject links", async () => {
  const root = await mkdtemp(join(tmpdir(), "jina-private-checkpoint-"));
  try {
    const state = join(root, "state");
    const stages = join(state, "agent-stages");
    await mkdir(stages, { recursive: true });
    await writeFile(join(stages, "research-plan.json"), '{"status":"complete"}\n');
    const valid = join(root, "valid.tar.gz");
    await execFileAsync("tar", ["--format=ustar", "-czf", valid, "-C", state, "agent-stages"]);
    const validBytes = await readFile(valid);
    validatePrivateCheckpointArchive(validBytes);
    assert.throws(() => validatePrivateCheckpointArchive(validBytes, ["status"]), /protected credential/);

    await symlink("../../outside", join(stages, "escape"));
    const linked = join(root, "linked.tar.gz");
    await execFileAsync("tar", ["--format=ustar", "-czf", linked, "-C", state, "agent-stages"]);
    const linkedBytes = await readFile(linked);
    assert.throws(() => validatePrivateCheckpointArchive(linkedBytes), /unsupported entry type/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private checkpoint archive validation fails closed on malformed gzip", () => {
  assert.throws(() => validatePrivateCheckpointArchive(Buffer.from("not-gzip")), /bounded gzip stream/);
});

test("host repair settles before the final checkpoint and checkpoint failure does not discard output", async () => {
  const order: string[] = [];
  const result = await withFinalCheckpoint(
    async () => {
      order.push("host-repair");
      return "published";
    },
    async () => {
      assert.deepEqual(order, ["host-repair"]);
      order.push("final-checkpoint");
      throw new Error("checkpoint unavailable");
    },
    (error) => {
      assert.match(error instanceof Error ? error.message : String(error), /checkpoint unavailable/);
      order.push("reported");
    }
  );
  assert.equal(result, "published");
  assert.deepEqual(order, ["host-repair", "final-checkpoint", "reported"]);

  await assert.rejects(
    withFinalCheckpoint(
      async () => {
        throw new Error("repair failed");
      },
      async () => {
        order.push("checkpoint-after-failure");
      },
      () => assert.fail("successful checkpoint must not report a failure")
    ),
    /repair failed/
  );
  assert.equal(order.at(-1), "checkpoint-after-failure");
});

test("public output archives are safe before host extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "jina-public-output-"));
  try {
    const output = join(root, "output");
    await mkdir(join(output, "architecture"), { recursive: true });
    await writeFile(join(output, "architecture", "overview.md"), "# Overview\n");
    const valid = join(root, "valid.tar.gz");
    await execFileAsync("tar", ["--format=ustar", "-czf", valid, "-C", output, "."]);
    validateDocumentOutputArchive(await readFile(valid));

    await symlink("../../outside", join(output, "architecture", "escape.md"));
    const linked = join(root, "linked.tar.gz");
    await execFileAsync("tar", ["--format=ustar", "-czf", linked, "-C", output, "."]);
    const linkedBytes = await readFile(linked);
    assert.throws(() => validateDocumentOutputArchive(linkedBytes), /unsupported entry type/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("targeted repair is accepted when it fixes plan diagnostics without losing pages", () => {
  type Checked = Parameters<typeof improvesHostCheckedOutput>[0];
  const checked = (
    documentCount: number,
    citations: number,
    problems: Checked["problems"],
    orchestrationDiagnostics: readonly string[]
  ): Checked =>
    ({
      output: {
        documents: Array.from({ length: documentCount }, () => ({
          citations: Array.from({ length: citations }, () => ({}))
        }))
      },
      problems,
      orchestrationDiagnostics
    }) as Checked;
  const before = checked(
    2,
    1,
    [{ documentPath: "architecture", reason: "claim-absent" }],
    ["covered subject database names unknown page database"]
  );
  assert.equal(improvesHostCheckedOutput(before, checked(2, 1, [], [])), true);
  assert.equal(
    improvesHostCheckedOutput(before, checked(2, 5, before.problems, before.orchestrationDiagnostics)),
    false
  );
  const invalidPlan = checked(2, 1, [], ["orchestration plan is invalid"]);
  const validPartialPlan = {
    ...checked(
      2,
      1,
      [],
      Array.from({ length: 5 }, (_, index) => `semantic ${index}`)
    ),
    output: {
      ...checked(2, 1, [], []).output,
      orchestration: { phase: "partial" }
    }
  } as unknown as Checked;
  assert.equal(improvesHostCheckedOutput(invalidPlan, validPartialPlan), true);
  assert.equal(improvesHostCheckedOutput(validPartialPlan, invalidPlan), false);
  assert.equal(improvesHostCheckedOutput(before, checked(1, 1, [], [])), false);
  assert.equal(improvesHostCheckedOutput(before, before), false);

  const ungroundedSections = checked(
    2,
    1,
    [
      { documentPath: "architecture", reason: "ungrounded-section" },
      { documentPath: "architecture", reason: "uncited-summary" }
    ],
    []
  );
  assert.equal(improvesHostCheckedOutput(ungroundedSections, checked(2, 3, [], [])), true);
});

test("durable worker claims require matching private spawn events", () => {
  type Checked = Parameters<typeof withCollaborationTranscriptDiagnostics>[0];
  const checked = {
    output: {
      documents: [],
      orchestration: {
        phase: "complete",
        workers: [
          { id: "research", role: "research", status: "complete", pageIds: [] },
          { id: "critic", role: "critic", status: "complete", pageIds: [] }
        ]
      }
    },
    problems: [],
    orchestrationDiagnostics: []
  } as unknown as Checked;
  const event = (id: string) =>
    JSON.stringify({
      type: "item.completed",
      item: { id, type: "collab_tool_call", tool: "spawn_agent", status: "completed" }
    });
  assert.match(
    withCollaborationTranscriptDiagnostics(checked, event("spawn-1")).orchestrationDiagnostics[0] ?? "",
    /claims 2 delegated workers.*records 1 completed spawn_agent/
  );
  assert.deepEqual(
    withCollaborationTranscriptDiagnostics(checked, `${event("spawn-1")}\n${event("spawn-2")}`)
      .orchestrationDiagnostics,
    []
  );
});

test("host-orchestrated workers require exact completed agent-stage receipts", () => {
  type Checked = Parameters<typeof withAgentStageReceiptDiagnostics>[0];
  const checked = {
    output: {
      documents: [],
      orchestration: {
        phase: "complete",
        workers: [
          { id: "source-research", role: "research", status: "complete", pageIds: [] },
          { id: "critic-pass-1", role: "critic", status: "complete", pageIds: [] }
        ]
      }
    },
    problems: [],
    orchestrationDiagnostics: []
  } as unknown as Checked;
  const missing = withAgentStageReceiptDiagnostics(checked, [
    { id: "source-research", role: "research", status: "complete" }
  ]);
  assert.match(missing.orchestrationDiagnostics[0] ?? "", /critic-pass-1/);
  assert.equal(missing.output.orchestration?.phase, "partial");
  assert.deepEqual(
    withAgentStageReceiptDiagnostics(checked, [
      { id: "source-research", role: "research", status: "complete" },
      { id: "critic-pass-1", role: "critic", status: "complete" }
    ]).orchestrationDiagnostics,
    []
  );
});

test("complete remote orchestration requires the durable v9 stage graph", () => {
  type Checked = Parameters<typeof withRemoteAgentStageDiagnostics>[0];
  const checked = {
    output: {
      documents: [],
      orchestration: { phase: "complete", workers: [] }
    },
    problems: [],
    orchestrationDiagnostics: []
  } as unknown as Checked;
  const incomplete = withRemoteAgentStageDiagnostics(checked, {
    artifactNames: ["research-plan.json", "documentation-plan.json", "receipts.json"],
    diagnostics: []
  });
  assert.equal(incomplete.output.orchestration?.phase, "partial");
  assert.match(incomplete.orchestrationDiagnostics[0] ?? "", /source-challenge\.json/);
  assert.match(incomplete.orchestrationDiagnostics[0] ?? "", /critic-pass-N\.json/);
  assert.deepEqual(
    withRemoteAgentStageDiagnostics(checked, {
      artifactNames: [
        "research-plan.json",
        "documentation-plan.json",
        "receipts.json",
        "source-challenge.json",
        "source-challenge.checkpoint.json",
        "critic-pass-2.json",
        "certification.json"
      ],
      diagnostics: []
    }).orchestrationDiagnostics,
    []
  );
  const corrupt = withRemoteAgentStageDiagnostics(checked, {
    artifactNames: [
      "research-plan.json",
      "documentation-plan.json",
      "receipts.json",
      "source-challenge.json",
      "source-challenge.checkpoint.json",
      "critic-pass-1.json",
      "certification.json"
    ],
    diagnostics: ["certification does not bind the persisted source challenge"]
  });
  assert.equal(corrupt.output.orchestration?.phase, "partial");
  assert.match(corrupt.orchestrationDiagnostics[0] ?? "", /does not bind/);
});

test("production prompt delegates semantic choices but requires challenge and digest-bound certification", () => {
  const prompt = productionAgentFirstPrompt("Build grounded context.");
  assert.match(prompt, /Adapt its subjects and assignments to this repository/);
  assert.match(prompt, /bounded to 12/);
  assert.match(prompt, /SOURCE CHALLENGE/);
  assert.match(prompt, /not the planner's expected page mapping/);
  assert.match(prompt, /CONTEXT-ONLY CRITIC/);
  assert.match(prompt, /SHA-256/);
  assert.match(prompt, /Internal plans.*never belong in public output/);
  assert.match(prompt, /mismatched or absent digest invalidates that stage and everything downstream/);
});

test("a missing or unparsable durable plan cannot report a successful derivation", () => {
  const invalid = {
    output: { documents: [] },
    problems: [],
    orchestrationDiagnostics: ["orchestration plan is invalid: unsupported signal source"]
  } as Parameters<typeof requireDurableOrchestration>[0];
  assert.throws(() => requireDurableOrchestration(invalid), /did not produce a valid durable orchestration plan/);

  const partial = {
    ...invalid,
    output: {
      documents: [],
      orchestration: {
        phase: "partial"
      }
    }
  } as unknown as Parameters<typeof requireDurableOrchestration>[0];
  assert.equal(requireDurableOrchestration(partial), partial.output);
});

test("documentation work ledgers resume only exact page-sized plan units", async () => {
  const root = await mkdtemp(join(tmpdir(), "jina-documentation-ledger-"));
  const path = join(root, "documentation-work-ledger.json");
  const units = [
    {
      id: "page-architecture",
      pageId: "architecture",
      path: "architecture.md",
      sourceWriterId: "writer-platform",
      objective: "Explain the architecture.",
      dependencies: [],
      inputDigest: "a".repeat(64)
    },
    {
      id: "page-request-flow",
      pageId: "request-flow",
      path: "flows/request-flow.md",
      sourceWriterId: "writer-platform",
      objective: "Explain request flow.",
      dependencies: ["architecture"],
      inputDigest: "b".repeat(64)
    }
  ] as const;
  const identity = {
    repository: "acme/cache",
    ref: "main",
    commitSha: "c".repeat(40),
    planDigest: "d".repeat(64),
    units
  };
  try {
    const ledger = createDocumentationWorkLedger(identity);
    assert.equal(ledger.status, "planned");
    assert.equal(ledger.units.length, 2);
    assert.equal(
      documentationWorkLedgerStatus([
        { ...ledger.units[0]!, status: "verified" },
        { ...ledger.units[1]!, status: "failed", lastError: "writer timed out" }
      ]),
      "partial"
    );
    await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`);
    assert.equal((await readDocumentationWorkLedger(path, identity))?.units[1]?.pageId, "request-flow");
    const interrupted = {
      ...ledger,
      status: "working" as const,
      units: [{ ...ledger.units[0]!, status: "working" as const, attempts: 1 }, ledger.units[1]!]
    };
    await writeFile(path, `${JSON.stringify(interrupted, null, 2)}\n`);
    assert.equal((await readDocumentationWorkLedger(path, identity))?.units[0]?.status, "pending");
    assert.equal(
      await readDocumentationWorkLedger(path, {
        ...identity,
        units: [{ ...units[0], inputDigest: "e".repeat(64) }, units[1]]
      }),
      undefined
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the local executor reports completed pages before returning its final catalog", async () => {
  const repository = await mkdtemp(join(tmpdir(), "jina-local-progress-repository-"));
  const fakeCodex = join(repository, "fake-codex.sh");
  const previous = {
    binary: process.env.CODEX_BINARY,
    files: process.env.CONTEXT_DERIVE_DOCUMENT_FILES,
    interval: process.env.CONTEXT_DERIVE_PROGRESS_INTERVAL_SECONDS,
    stages: process.env.CONTEXT_AGENT_STAGES
  };
  try {
    await writeFile(join(repository, "README.md"), "The cache removes expired entries before lookup returns.\n");
    await writeFile(
      fakeCodex,
      [
        "#!/bin/sh",
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = "-C" ]; then shift; cd "$1"; break; fi',
        "  shift",
        "done",
        'prompt="$(cat)"',
        `output="$(printf '%s\\n' "$prompt" | sed -n 's|^Write each document as a Markdown file under \\([^,]*\\),.*|\\1|p' | head -1)"`,
        'mkdir -p "$output"',
        'state="$(dirname "$output")/derive-state"',
        'mkdir -p "$state/agent-stages"',
        `printf '%s\n' '{"repository":"acme/cache","status":"complete"}' > "$state/agent-stages/research-plan.json"`,
        `printf '%s\\n' '{"version":4,"repository":"acme/cache","ref":"main","commitSha":"${"a".repeat(
          40
        )}","mode":"initial","phase":"complete","subjects":[{"id":"cache-lifecycle","kind":"flow","statement":"Cache lookup preserves expiry behavior.","priority":"required","status":"covered","signals":[{"source":"documentation","reference":"README.md"}],"questions":[{"id":"cache-lookup","question":"How does the cache work?","priority":"required","status":"answered","pageIds":["architecture"]}],"pageIds":["architecture"]}],"items":[{"id":"architecture","path":"architecture.md","title":"Cache architecture","purpose":"Explain the repository","priority":"required","status":"complete","scope":{"paths":["README.md"],"symbols":[]},"questions":["cache-lookup"],"requiredEvidence":["documentation"],"dependencies":[]}],"areas":[{"id":"root","status":"covered","pageIds":["architecture"]}],"workers":[{"id":"cache-critic","role":"critic","status":"complete","pageIds":[]}],"reviews":[{"id":"cache-context-review","kind":"context_only","status":"complete","reviewer":"subagent","workerId":"cache-critic","results":[{"questionId":"cache-lookup","verdict":"pass","pageIds":["architecture"],"gapIds":[],"summary":"The architecture page answers the cache task."}],"summary":"The context answers the required maintenance question."}],"gaps":[],"completionReason":"Required repository context is complete."}' > "$state/plan.json"`,
        `printf '%s\\n' '# Cache architecture' '' '[The cache removes expired entries before lookup returns.](README.md#L1-L1)' > "$output/architecture.md"`,
        "sleep 2"
      ].join("\n")
    );
    await chmod(fakeCodex, 0o755);
    process.env.CODEX_BINARY = fakeCodex;
    process.env.CONTEXT_DERIVE_DOCUMENT_FILES = "true";
    process.env.CONTEXT_DERIVE_PROGRESS_INTERVAL_SECONDS = "1";
    process.env.CONTEXT_AGENT_STAGES = "false";
    const reported: string[] = [];
    const privateCheckpoints: Buffer[] = [];
    const output = (await new LocalCodexKnowledgeDocumentGenerator().generate({
      prompt:
        "Write each document as a Markdown file under /home/daytona/context-engine/derive-output, and finish it before returning.",
      repairErrors: [],
      budgetSeconds: 20,
      bundle: {
        checkpoint: {
          id: "ec_local_progress",
          tenantId: "tenant-local",
          repository: "acme/cache",
          ref: "main",
          refSequence: 1,
          commitSha: "a".repeat(40),
          parserVersion: "thin-ingest-v2",
          sourceCompleteness: "complete",
          observationFrontier: "test",
          evidenceFingerprint: "e".repeat(64),
          manifestFingerprint: "m".repeat(64),
          aclFingerprint: "c".repeat(64),
          createdAt: "2026-07-29T00:00:00.000Z"
        },
        items: [],
        omittedCount: 0,
        truncatedEvidenceIds: [],
        selectorVersion: "test",
        fingerprint: "f".repeat(64)
      },
      async onProgress(pages) {
        reported.push(...pages.map((page) => page.documentPath));
      },
      async onPrivateCheckpoint(archive) {
        privateCheckpoints.push(Buffer.from(archive));
      },
      workspace: {
        repositoryDirectory: repository,
        manifest: [
          {
            tenantId: "tenant-local",
            repository: "acme/cache",
            ref: "main",
            commitSha: "a".repeat(40),
            path: "README.md",
            blobSha: "b".repeat(40),
            contentDigest: "d".repeat(64),
            contentAvailable: true,
            executable: false
          }
        ],
        priorKnowledge: []
      }
    })) as { documents: readonly { logicalId: string }[] };
    assert.deepEqual(reported, ["architecture"]);
    assert.equal(privateCheckpoints.length, 1);
    validatePrivateCheckpointArchive(privateCheckpoints[0]!);
    assert.equal(output.documents[0]?.logicalId, "repository:acme/cache:architecture");
  } finally {
    if (previous.binary === undefined) delete process.env.CODEX_BINARY;
    else process.env.CODEX_BINARY = previous.binary;
    if (previous.files === undefined) delete process.env.CONTEXT_DERIVE_DOCUMENT_FILES;
    else process.env.CONTEXT_DERIVE_DOCUMENT_FILES = previous.files;
    if (previous.interval === undefined) delete process.env.CONTEXT_DERIVE_PROGRESS_INTERVAL_SECONDS;
    else process.env.CONTEXT_DERIVE_PROGRESS_INTERVAL_SECONDS = previous.interval;
    if (previous.stages === undefined) delete process.env.CONTEXT_AGENT_STAGES;
    else process.env.CONTEXT_AGENT_STAGES = previous.stages;
    await rm(repository, { recursive: true, force: true });
  }
});

test("the prompt tells the agent when its run ends", () => {
  const prompt = deadlineAwarePrompt({ prompt: "Write the context.", budgetSeconds: 1800 });
  // The agent has a shell and can read a clock; what it lacked was being told
  // there is one. The deadline is earlier than the kill so the file in hand can
  // be finished rather than cut off mid-write and withheld.
  assert.match(prompt, /terminated at \d{4}-\d{2}-\d{2}T/);
  assert.match(prompt, /date -u/);
  assert.match(prompt, /last filesystem action.*complete.*partial/s);
  assert.match(prompt, /reviewing.*never a terminal phase/);
  assert.ok(prompt.startsWith("Write the context."));
});

test("a run takes the budget it was handed, bounded by the sandbox ceiling", () => {
  const previous = process.env.DAYTONA_RUN_TIMEOUT_SECONDS;
  process.env.DAYTONA_RUN_TIMEOUT_SECONDS = "2400";
  try {
    // What the caller has left, not a fixed per-run value, so a repair run
    // cannot restart the clock on a stage that is already nearly spent.
    assert.equal(runBudgetSeconds({ budgetSeconds: 5400 }), 5400);
    assert.equal(runBudgetSeconds({ budgetSeconds: 600 }), 600);
    // No caller value falls back to the deployment default.
    assert.equal(runBudgetSeconds({}), 2400);
    // The ceiling binds whatever a build asked for.
    assert.equal(runBudgetSeconds({ budgetSeconds: 99_999 }), MAX_RUN_BUDGET_SECONDS);
    // Nonsense does not disable the timeout, which would hand the sandbox an
    // unbounded run and hold the lease until it expired.
    assert.equal(runBudgetSeconds({ budgetSeconds: 0 }), 2400);
    assert.equal(runBudgetSeconds({ budgetSeconds: -1 }), 2400);
    assert.equal(runBudgetSeconds({ budgetSeconds: Number.NaN }), 2400);
  } finally {
    if (previous === undefined) delete process.env.DAYTONA_RUN_TIMEOUT_SECONDS;
    else process.env.DAYTONA_RUN_TIMEOUT_SECONDS = previous;
  }
});

test("a claim the checkpoint does not make is dropped, not fatal", async () => {
  const repository = await mkdtemp(join(tmpdir(), "jina-claim-verify-"));
  try {
    await writeFile(join(repository, "outbox.ts"), "line one\nlease expiry releases the row\nline three\n");
    const verify = checkpointClaimVerifier(repository);
    assert.ok(verify);
    const link = (path: string, startLine: number, endLine: number, claim: string) =>
      ({
        citationId: "test-citation",
        claimSpan: claim,
        path,
        startLine,
        endLine,
        claim
      }) as Parameters<typeof verify>[0];
    // The claim occurs verbatim in the range it names.
    assert.equal(verify(link("outbox.ts", 2, 2, "lease expiry releases the row")), true);
    // The production failure: a plausible claim the cited lines do not make.
    assert.equal(verify(link("outbox.ts", 1, 1, "lease expiry releases the row")), false);
    // A range past the end of the file, and a file that is not there at all.
    assert.equal(verify(link("outbox.ts", 1, 99, "line one")), false);
    assert.equal(verify(link("absent.ts", 1, 1, "line one")), false);
    // Paths come from an untrusted agent, so one that escapes the checkout must
    // verify nothing rather than read the host filesystem.
    assert.equal(verify(link("../../etc/passwd", 1, 1, "root user entry")), false);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("natural citation labels preserve a valid range and yield an exact source anchor", async () => {
  const repository = await mkdtemp(join(tmpdir(), "jina-reference-verify-"));
  try {
    await writeFile(join(repository, "auth.ts"), "export function authorize() {\n  return denyAnonymous();\n}\n");
    const verify = checkpointReferenceVerifier(repository);
    assert.ok(verify);
    const result = verify({
      citationId: "cite_aaaaaaaaaaaaaaaaaaaa",
      claim: "rejects unauthenticated calls",
      claimSpan: "The API rejects unauthenticated calls.",
      path: "auth.ts",
      startLine: 1,
      endLine: 2
    });
    assert.equal(result, "export function authorize() { return denyAnonymous();");
    assert.equal(
      verify({
        citationId: "cite_bbbbbbbbbbbbbbbbbbbb",
        claim: "descriptive navigation label",
        claimSpan: "A claim.",
        path: "../../etc/passwd",
        startLine: 1,
        endLine: 1
      }),
      false
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("snapshot reuse accepts only an absolute working Codex path", async () => {
  const found = await findExistingCodex({
    process: {
      async executeCommand() {
        return { exitCode: 0, result: "/opt/codex/bin/codex\n" };
      }
    }
  });
  assert.equal(found, "/opt/codex/bin/codex");

  const missing = await findExistingCodex({
    process: {
      async executeCommand() {
        return { exitCode: 0, result: "codex\n" };
      }
    }
  });
  assert.equal(missing, undefined);
});

test("agentic knowledge generation enables only read-only local shell exploration", () => {
  assert.ok(AGENT_KNOWLEDGE_CODEX_ARGS.includes("--ignore-user-config"));
  assert.ok(AGENT_KNOWLEDGE_CODEX_ARGS.includes("--ignore-rules"));
  assert.ok(AGENT_KNOWLEDGE_CODEX_ARGS.includes("--strict-config"));
  assert.ok(AGENT_KNOWLEDGE_CODEX_ARGS.includes("--skip-git-repo-check"));
  assert.ok(AGENT_KNOWLEDGE_CODEX_ARGS.includes("--enable shell_tool"));
  assert.ok(AGENT_KNOWLEDGE_CODEX_ARGS.includes("--enable multi_agent"));
  for (const feature of [
    "shell_snapshot",
    "apps",
    "browser_use",
    "computer_use",
    "image_generation",
    "unified_exec",
    "plugins",
    "remote_plugin",
    "hooks",
    "in_app_browser",
    "code_mode_host",
    "workspace_dependencies",
    "skill_mcp_dependency_install"
  ]) {
    assert.ok(AGENT_KNOWLEDGE_CODEX_ARGS.includes(`--disable ${feature}` as never));
  }
  assert.ok(AGENT_KNOWLEDGE_CODEX_ARGS.includes('-c web_search="disabled"'));
  assert.ok(AGENT_KNOWLEDGE_CODEX_ARGS.includes('-c approval_policy="never"'));
  assert.ok(AGENT_KNOWLEDGE_CODEX_ARGS.includes("-c project_doc_max_bytes=0"));
  assert.ok(AGENT_KNOWLEDGE_CODEX_ARGS.includes('-c shell_environment_policy.inherit="none"'));
});

test("bounded host stages cannot recursively recreate the lead workflow", () => {
  assert.match(KNOWLEDGE_AGENT_STAGE_DEVELOPER_INSTRUCTIONS, /Complete only the bounded work unit/);
  assert.match(KNOWLEDGE_AGENT_STAGE_DEVELOPER_INSTRUCTIONS, /Do not .*spawn subagents/);
  assert.doesNotMatch(KNOWLEDGE_AGENT_STAGE_DEVELOPER_INSTRUCTIONS, /invoke parallel non-overlapping/);
});

test("an invalid citation-auditor envelope retries without weakening its verdict", async () => {
  const diagnostics: string[] = [];
  const result = await retryCitationAuditFormat({
    id: "page-architecture-audit",
    attempts: 2,
    run: async (attempt, diagnostic) => {
      diagnostics.push(diagnostic);
      return attempt === 1 ? { citationIds: ["invented"] } : { citationIds: ["expected"] };
    },
    parse: (value) => {
      const citationIds = (value as { citationIds?: string[] }).citationIds;
      if (citationIds?.join(",") !== "expected") throw new Error("invented citation id");
      return citationIds;
    }
  });
  assert.deepEqual(result, ["expected"]);
  assert.equal(diagnostics[0], "");
  assert.match(diagnostics[1] ?? "", /invented citation id/);
  await assert.rejects(
    retryCitationAuditFormat({
      id: "page-architecture-audit",
      attempts: 2,
      run: async () => ({ citationIds: ["invented"] }),
      parse: () => {
        throw new Error("invented citation id");
      }
    }),
    /remained invalid after 2 attempts/
  );
});

test("knowledge prompts stream over stdin instead of expanding into argv", () => {
  assert.equal(KNOWLEDGE_PROMPT_STDIN_REDIRECT, "< '/home/daytona/context-engine/prompt.txt'");
  assert.equal(KNOWLEDGE_PROMPT_STDIN_REDIRECT.includes("$("), false);
});

test("repository archives are pinned to the requested commit and exclude worktree and Git metadata", async () => {
  const repository = await mkdtemp(join(tmpdir(), "jina-agent-archive-test-"));
  let archive: Awaited<ReturnType<typeof createRepositoryArchive>> | undefined;
  try {
    await execFileAsync("git", ["init", "-q", repository]);
    await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "Archive Test"]);
    await writeFile(join(repository, "README.md"), "checkpoint content\n");
    await execFileAsync("git", ["-C", repository, "add", "README.md"]);
    await execFileAsync("git", ["-C", repository, "commit", "-q", "-m", "checkpoint"]);
    const { stdout } = await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"]);
    const checkpoint = stdout.trim();
    await writeFile(join(repository, "README.md"), "uncommitted content\n");
    await writeFile(join(repository, "untracked-secret.txt"), "must not be archived\n");

    archive = await createRepositoryArchive(repository, checkpoint);
    const listing = (await execFileAsync("tar", ["-tzf", archive.path])).stdout;
    const readme = (await execFileAsync("tar", ["-xOzf", archive.path, "README.md"])).stdout;
    assert.equal(readme, "checkpoint content\n");
    assert.doesNotMatch(listing, /\.git|untracked-secret/);
  } finally {
    if (archive) await rm(archive.directory, { recursive: true, force: true });
    await rm(repository, { recursive: true, force: true });
  }
});
