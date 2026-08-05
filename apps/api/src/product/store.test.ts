import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyProviderPreference,
  computeBillableCost,
  decryptIntegrationRow,
  deriveKeySource,
  isTerminalReviewRunStatus,
  normalizeModelProvider,
  normalizeReviewTriggerMode,
  parseModelSettingsSnapshot,
  planTenantMemberships,
  projectDashboardEventPayload,
  projectDashboardRunResult,
  resolveRunKeys,
  shapeRunBilling,
  sortViewerTenants,
  stageModelsAllOpenaiFamily,
  type ViewerTenant,
} from "./store.js";
import { harnessAllowed } from "./store.js";

/* ------------------------------------------------ model routing (coverage) --- */

test("normalizeModelProvider: three selections; everything unselected/legacy-auto defaults to 'managed'", () => {
  for (const p of ["codex", "byok", "managed"]) assert.equal(normalizeModelProvider(p), p);
  assert.equal(normalizeModelProvider("openai"), "byok");
  assert.equal(normalizeModelProvider("openrouter"), "byok");
  // No selection (and the retired 'auto') -> Jina managed until the user selects.
  assert.equal(normalizeModelProvider(null), "managed");
  assert.equal(normalizeModelProvider("auto"), "managed");
  assert.equal(normalizeModelProvider("garbage"), "managed");
});

test("harnessAllowed: only an explicit 'codex' selection enables the harness", () => {
  assert.equal(harnessAllowed("codex"), true);
  assert.equal(harnessAllowed("byok"), false);
  assert.equal(harnessAllowed("managed"), false);
});

test("stageModelsAllOpenaiFamily resolves null stages against the PLATFORM DEFAULTS, never assumes openai", () => {
  const openaiDefaults = { planner: "openai/gpt-5.5", investigation: "openai/gpt-5.4", review: "openai/gpt-5.5", mentalTrace: "openai/gpt-5.4-mini" };
  assert.equal(stageModelsAllOpenaiFamily({ planner_model: null, investigation_model: "openai/gpt-5.5", review_model: null }, openaiDefaults), true);
  // CASE-SENSITIVE, mirroring the proxy's native-route match: a mixed-case slug is NOT natively routable,
  // so it must classify as uncovered (whole-run managed) — never "covered" while the proxy misroutes it.
  assert.equal(stageModelsAllOpenaiFamily({ planner_model: "OpenAI/GPT-5.5" }, openaiDefaults), false, "case-sensitive like the proxy");
  assert.equal(stageModelsAllOpenaiFamily({ review_model: "anthropic/claude-4" }, openaiDefaults), false);
  // The operator can point a platform default at a NON-OpenAI model: an unset stage then makes the run
  // NOT OpenAI-only — null must never be blindly treated as openai/*.
  const mixedDefaults = { planner: "openai/gpt-5.5", investigation: "anthropic/claude-sonnet-4.5", review: "openai/gpt-5.5", mentalTrace: "openai/gpt-5.4-mini" };
  assert.equal(stageModelsAllOpenaiFamily({ planner_model: null, investigation_model: null, review_model: null }, mixedDefaults), false);
  // An explicit openai/* pick on that stage overrides the non-OpenAI default -> covered again.
  assert.equal(stageModelsAllOpenaiFamily({ investigation_model: "openai/gpt-5.4" }, mixedDefaults), true);
  // The mental-trace stage has NO tenant override: a non-OpenAI mental-trace default alone breaks coverage
  // (it still calls the gateway on every run).
  const mentalDefaults = { planner: "openai/gpt-5.5", investigation: "openai/gpt-5.4", review: "openai/gpt-5.5", mentalTrace: "anthropic/claude-haiku" };
  assert.equal(stageModelsAllOpenaiFamily({ planner_model: "openai/gpt-5.5", investigation_model: "openai/gpt-5.4", review_model: "openai/gpt-5.5" }, mentalDefaults), false);
});

test("parseModelSettingsSnapshot round-trips a snapshot and rejects malformed values", () => {
  const snapshot = { planner_model: "openai/gpt-5.5", investigation_model: null, review_model: "anthropic/claude-4" };
  const normalized = {
    ...snapshot,
    context_model: null,
    planner_effort: null,
    investigation_effort: null,
    review_effort: null,
    context_effort: null,
    review_fallback_policy: "fail_notify",
    context_fallback_policy: "fail_notify",
  };
  assert.deepEqual(parseModelSettingsSnapshot(JSON.stringify(snapshot)), normalized);
  // jsonb may come back as an object (pg parses it) — accept both shapes.
  assert.deepEqual(parseModelSettingsSnapshot(snapshot), normalized);
  assert.equal(parseModelSettingsSnapshot(null), undefined);
  assert.equal(parseModelSettingsSnapshot("not-json"), undefined);
  assert.equal(parseModelSettingsSnapshot("[1,2]"), undefined);
});

test("resolveRunKeys: OpenRouter covers any vendor; OpenAI only all-openai runs; managed forces none", () => {
  // codex/byok + OpenRouter -> company keys (OpenRouter for all, native OpenAI for openai/*).
  for (const p of ["codex", "byok"] as const) {
    assert.deepEqual(resolveRunKeys(p, true, true, false), { openrouter: true, openai: true }, p);
    assert.deepEqual(resolveRunKeys(p, true, false, false), { openrouter: true, openai: false }, p);
    // Only OpenAI key: covered only when every model is openai/*, else whole-run managed fallback.
    assert.deepEqual(resolveRunKeys(p, false, true, true), { openrouter: false, openai: true }, p);
    assert.deepEqual(resolveRunKeys(p, false, true, false), { openrouter: false, openai: false }, p);
    // No key -> managed.
    assert.deepEqual(resolveRunKeys(p, false, false, true), { openrouter: false, openai: false }, p);
  }
  // managed -> managed regardless of keys.
  assert.deepEqual(resolveRunKeys("managed", true, true, true), { openrouter: false, openai: false });
});

test("applyProviderPreference: keys per routing decision; harness gated by the SELECTION; whitespace = absent", () => {
  const both = {
    openrouter: "or",
    openaiApiKey: "oai",
    codexHarnessAuth: "blob" as string,
    codexHarnessConnectedAtMs: 1_784_000_000_123,
    harnessOwnerLogin: "octo",
    codexHarnessModel: "gpt-5.5" as const,
  };
  // codex -> harness allowed; keys still resolve for non-harness authors' PRs.
  assert.deepEqual(applyProviderPreference(both, "codex", false), { ...both });
  // managed -> an EXPLICIT override: drop the company keys AND the harness ("connect harness but click managed").
  assert.deepEqual(applyProviderPreference(both, "managed", true), {
    openrouter: undefined,
    openaiApiKey: undefined,
    codexHarnessAuth: undefined,
    harnessOwnerLogin: undefined,
    codexHarnessModel: null,
  });
  // byok -> keys stay, harness disabled (explicit selection beats the default priority).
  assert.deepEqual(applyProviderPreference(both, "byok", false), {
    openrouter: "or",
    openaiApiKey: "oai",
    codexHarnessAuth: undefined,
    harnessOwnerLogin: undefined,
    codexHarnessModel: null,
  });
  // Only an OpenAI key + a non-openai model (allModelsOpenai=false) -> whole-run managed fallback (drop it).
  assert.deepEqual(applyProviderPreference({ openaiApiKey: "oai" }, "byok", false), { openrouter: undefined, openaiApiKey: undefined, codexHarnessAuth: undefined, harnessOwnerLogin: undefined, codexHarnessModel: null });
  // Only an OpenAI key + all-openai run -> keep it.
  assert.deepEqual(applyProviderPreference({ openaiApiKey: "oai" }, "byok", true), { openrouter: undefined, openaiApiKey: "oai", codexHarnessAuth: undefined, harnessOwnerLogin: undefined, codexHarnessModel: null });
  // A whitespace-only key counts as ABSENT.
  assert.deepEqual(applyProviderPreference({ openrouter: "  ", openaiApiKey: "oai" }, "byok", true), { openrouter: undefined, openaiApiKey: "oai", codexHarnessAuth: undefined, harnessOwnerLogin: undefined, codexHarnessModel: null });
});

/* ------------------------------------------------ per-run billing shape --- */

test("shapeRunBilling returns undefined when there is no billing row", () => {
  assert.equal(
    shapeRunBilling({ keySource: null, rateMode: null, infraCredits: null, aiCredits: null, infraStatus: null }),
    undefined,
  );
});

test("shapeRunBilling keeps total null while infra is unsettled (pending/tracking)", () => {
  // A prepared row: null infra, default AI 0, status 'pending'. Summing null infra as 0 would render a
  // finalized-looking "0 credits" — total must stay null until settlement.
  for (const status of ["pending", "tracking"]) {
    const b = shapeRunBilling({ keySource: "managed", rateMode: "included", infraCredits: null, aiCredits: 0, infraStatus: status });
    assert.equal(b?.total_credits, null, `total null for ${status}`);
    assert.equal(b?.infra_credits, null);
    assert.equal(b?.ai_credits, 0);
    assert.equal(b?.infra_status, status);
  }
});

test("shapeRunBilling sums total only once infra has settled", () => {
  const billed = shapeRunBilling({ keySource: "managed", rateMode: "included", infraCredits: 100, aiCredits: 57, infraStatus: "billed" });
  assert.equal(billed?.total_credits, 157);
  const harness = shapeRunBilling({ keySource: "harness", rateMode: "included", infraCredits: 100, aiCredits: 0, infraStatus: "billed" });
  assert.equal(harness?.total_credits, 100);
  // Non-billed-but-settled states still expose a computed total (the UI labels them via infra_status).
  const waived = shapeRunBilling({ keySource: "managed", rateMode: "included", infraCredits: 0, aiCredits: 0, infraStatus: "waived" });
  assert.equal(waived?.total_credits, 0);
  assert.equal(waived?.infra_status, "waived");
});

/* ------------------------------------------------ review trigger mode --- */

test("normalizeReviewTriggerMode accepts stored modes and defaults everything else to 'every_commit'", () => {
  assert.equal(normalizeReviewTriggerMode("first_commit"), "first_commit");
  assert.equal(normalizeReviewTriggerMode("manual_only"), "manual_only");
  assert.equal(normalizeReviewTriggerMode("every_commit"), "every_commit");
  assert.equal(normalizeReviewTriggerMode(undefined), "every_commit");
  assert.equal(normalizeReviewTriggerMode(null), "every_commit");
  assert.equal(normalizeReviewTriggerMode("garbage"), "every_commit");
  assert.equal(normalizeReviewTriggerMode(42), "every_commit");
});

/* ------------------------------------------------ computeBillableCost (BYOK basis) --- */

test("computeBillableCost sums upstream + fee for a BYOK row (the real model spend, not just the fee)", () => {
  // $0.05 OpenRouter fee + $1.00 upstream inference => $1.05 basis (undercharge ~95% if billed on cost alone).
  assert.equal(computeBillableCost({ is_byok: true, cost: "0.05", upstream_inference_cost: "1.00" }), "1.05");
});

test("computeBillableCost returns cost unchanged for a non-BYOK row (summing would double-charge)", () => {
  // Non-BYOK: upstream merely mirrors cost, so the basis is cost alone.
  assert.equal(computeBillableCost({ is_byok: false, cost: "0.50", upstream_inference_cost: "0.50" }), "0.50");
  assert.equal(computeBillableCost({ cost: "0.50" }), "0.50"); // is_byok defaults to non-BYOK
});

test("computeBillableCost tolerates a BYOK row missing the fee or the upstream cost", () => {
  assert.equal(computeBillableCost({ is_byok: true, upstream_inference_cost: "1.00" }), "1.00");
  assert.equal(computeBillableCost({ is_byok: true, cost: "0.05" }), "0.05");
});

test("computeBillableCost returns undefined when a BYOK row has neither cost (persisted NULL -> fallback)", () => {
  assert.equal(computeBillableCost({ is_byok: true }), undefined);
});

test("computeBillableCost returns undefined for a non-BYOK row with no cost (persisted NULL -> fallback)", () => {
  assert.equal(computeBillableCost({ is_byok: false }), undefined);
});

test("terminal review run statuses include completed superseded runs", () => {
  for (const status of ["completed", "completed_superseded", "failed", "superseded", "cancelled", "canceled"]) {
    assert.equal(isTerminalReviewRunStatus(status), true);
  }

  assert.equal(isTerminalReviewRunStatus("runtime_review_started"), false);
});

/* ------------------------------------------ bounded dashboard read model --- */

test("projectDashboardEventPayload keeps list status fields and drops rich runtime work", () => {
  const huge = "x".repeat(20_000);
  const projected = projectDashboardEventPayload("runtime_review_completed", {
    status: "issues_found",
    summary: huge,
    findings_count: 7,
    publishable_findings_count: 3,
    tasks_count: 12,
    areas_count: 4,
    runtime_review: {
      investigations: [{ title: huge, tasks: [{ evidence: huge }] }],
      findings: Array.from({ length: 20 }, () => ({ body: huge })),
      comments: [huge],
    },
    findings: Array.from({ length: 20 }, () => ({ body: huge })),
    markdown_preview: huge,
  });

  assert.equal(projected?.status, "issues_found");
  assert.equal((projected?.summary as string).length, 500);
  assert.equal(projected?.findings_count, 7);
  assert.equal(projected?.publishable_findings_count, 3);
  assert.equal(projected?.tasks_count, 12);
  assert.equal("runtime_review" in (projected ?? {}), false);
  assert.equal("findings" in (projected ?? {}), false);
  assert.equal("markdown_preview" in (projected ?? {}), false);
  assert.ok(JSON.stringify(projected).length < 1_000);
});

test("projectDashboardEventPayload preserves bounded publication state for list notices", () => {
  const projected = projectDashboardEventPayload("github_runtime_review_publish_failed", {
    publication_status: "failed",
    reason: "r".repeat(2_000),
    error: "e".repeat(2_000),
    github_review_url: `https://github.com/${"x".repeat(4_000)}`,
    inline_comment_count: 4,
  });

  assert.equal(projected?.publication_status, "failed");
  assert.equal((projected?.reason as string).length, 500);
  assert.equal((projected?.error as string).length, 500);
  assert.equal((projected?.github_review_url as string).length, 2_048);
  assert.equal(projected?.inline_comment_count, 4);
  assert.equal(projectDashboardEventPayload("runtime_review_started", { large: "x".repeat(20_000) }), undefined);
});

test("projectDashboardRunResult replaces detail arrays with a compact compatible summary", () => {
  const huge = "x".repeat(20_000);
  const projected = projectDashboardRunResult({
    status: "completed",
    review_gate: {
      blocking_level: "high",
      conclusion: "fail",
      blocking: true,
      blocking_count: 2,
      scenario_counts: { total: 9, high: 2, medium: 3, low: 4, unknown: 0, raw: huge },
      raw: huge,
    },
    simulation: {
      status: "failed",
      duration_ms: 123,
      counts: { total: 9, pass: 7, fail: 2, warn: 0, raw: huge },
      scenarios: Array.from({ length: 20 }, () => ({ transcript: huge })),
    },
    final_review: {
      status: "issues_found",
      summary: huge,
      findings: Array.from({ length: 20 }, () => ({ body: huge })),
      markdown: huge,
    },
    review_markdown: huge,
  });

  assert.deepEqual(projected?.review_gate, {
    blocking_level: "high",
    conclusion: "fail",
    blocking: true,
    blocking_count: 2,
    scenario_counts: { total: 9, high: 2, medium: 3, low: 4, unknown: 0 },
  });
  assert.deepEqual(projected?.simulation, {
    status: "failed",
    duration_ms: 123,
    counts: { total: 9, pass: 7, fail: 2, warn: 0 },
    scenarios: [],
  });
  assert.equal(((projected?.final_review as Record<string, unknown>).summary as string).length, 500);
  assert.deepEqual((projected?.final_review as Record<string, unknown>).findings, []);
  assert.equal("review_markdown" in (projected ?? {}), false);
  assert.ok(JSON.stringify(projected).length < 1_500);
});

/* --- resolve-shape mapping (decryptIntegrationRow); values below are legacy plaintext, which
   decryptSecret returns as-is regardless of SECRETS_ENCRYPTION_KEY, so the test is deterministic. --- */

test("decryptIntegrationRow maps openrouter + author harness + owner login + harness model", () => {
  assert.deepEqual(
    decryptIntegrationRow({
      openrouter_api_key: "sk-or-tenant",
      codex_harness_auth: '{"tokens":{"refresh_token":"rt"}}',
      codex_harness_connected_at: "2026-07-15T12:34:56.789Z",
      harness_owner_login: "octocat",
      codex_harness_model: "gpt-5.4",
    }),
    {
      openrouter: "sk-or-tenant",
      openaiApiKey: undefined,
      codexHarnessAuth: '{"tokens":{"refresh_token":"rt"}}',
      codexHarnessConnectedAtMs: Date.parse("2026-07-15T12:34:56.789Z"),
      harnessOwnerLogin: "octocat",
      codexHarnessModel: "gpt-5.4",
    },
  );
});

test("decryptIntegrationRow surfaces a tenant BYOK native OpenAI key", () => {
  // The native OpenAI key resolves independently of the harness/openrouter credentials and drives the
  // BYOK native route (openai/* -> api.openai.com under the tenant's own key).
  assert.deepEqual(
    decryptIntegrationRow({
      openrouter_api_key: null,
      openai_api_key: "sk-tenant-openai",
      codex_harness_auth: null,
      harness_owner_login: null,
      codex_harness_model: null,
    }),
    {
      openrouter: undefined,
      openaiApiKey: "sk-tenant-openai",
      codexHarnessAuth: undefined,
      harnessOwnerLogin: undefined,
      codexHarnessModel: null,
    },
  );
});

test("decryptIntegrationRow coerces an unknown stored harness model to null", () => {
  // A stale/invalid stored model value must never flow to the runtime as-is.
  assert.deepEqual(
    decryptIntegrationRow({
      openrouter_api_key: null,
      codex_harness_auth: '{"tokens":{"refresh_token":"rt"}}',
      harness_owner_login: "octocat",
      codex_harness_model: "made-up-model",
    }),
    {
      openrouter: undefined,
      openaiApiKey: undefined,
      codexHarnessAuth: '{"tokens":{"refresh_token":"rt"}}',
      harnessOwnerLogin: "octocat",
      codexHarnessModel: null,
    },
  );
});

test("decryptIntegrationRow omits harnessOwnerLogin + harness model when no harness blob resolved", () => {
  // A matched author with an integration row but NO codex harness must not look like own-harness.
  assert.deepEqual(
    decryptIntegrationRow({
      openrouter_api_key: "sk-or",
      codex_harness_auth: null,
      codex_harness_connected_at: "2026-07-15T12:34:56.789Z",
      harness_owner_login: "octocat",
      codex_harness_model: "gpt-5.5",
    }),
    {
      openrouter: "sk-or",
      openaiApiKey: undefined,
      codexHarnessAuth: undefined,
      harnessOwnerLogin: undefined,
      codexHarnessModel: null,
    },
  );
});

test("decryptIntegrationRow returns an empty shape for a missing row", () => {
  assert.deepEqual(decryptIntegrationRow(undefined), {
    openrouter: undefined,
    openaiApiKey: undefined,
    codexHarnessAuth: undefined,
    harnessOwnerLogin: undefined,
    codexHarnessModel: null,
  });
});

/* --- billing key-source classification (deriveKeySource) mirrors the runtime credential precedence:
   author harness > tenant OpenRouter key > managed. Only "managed" consumes the managed-AI entitlement. --- */

test("deriveKeySource classifies a harness-only author as 'harness'", () => {
  assert.equal(deriveKeySource(true, false), "harness");
});

test("deriveKeySource classifies a tenant-key-only run as 'user'", () => {
  assert.equal(deriveKeySource(false, true), "user");
});

test("deriveKeySource classifies a run with neither credential as 'managed'", () => {
  assert.equal(deriveKeySource(false, false), "managed");
});

test("deriveKeySource: author harness WINS over a tenant key (mirrors runtime precedence)", () => {
  // The runtime executes on the author's harness when present regardless of a tenant OpenRouter key,
  // so billing must classify this run "harness" too — otherwise a native own-subscription run would be
  // misbilled as managed/user AI.
  assert.equal(deriveKeySource(true, true), "harness");
});

/* --- tenant membership planner (planTenantMemberships): pure desired-set logic that the sync upserts,
   and whose complement (this user's rows NOT in the set) is the stale-delete set. --- */

test("planTenantMemberships adds an admin self-membership for the viewer's personal tenant", () => {
  const desired = planTenantMemberships({
    githubUserId: 7,
    githubLogin: "octocat",
    personalTenantId: "tenant-personal",
    orgTenants: [],
  });
  assert.deepEqual(desired, [
    { tenantId: "tenant-personal", githubUserId: 7, githubLogin: "octocat", role: "admin" },
  ]);
});

test("planTenantMemberships carries each org's GitHub membership role", () => {
  const desired = planTenantMemberships({
    githubUserId: 7,
    githubLogin: "octocat",
    orgTenants: [
      { tenantId: "tenant-admin-org", role: "admin" },
      { tenantId: "tenant-member-org", role: "member" },
    ],
  });
  assert.deepEqual(new Map(desired.map((m) => [m.tenantId, m.role])), new Map([
    ["tenant-admin-org", "admin"],
    ["tenant-member-org", "member"],
  ]));
  for (const membership of desired) {
    assert.equal(membership.githubUserId, 7);
    assert.equal(membership.githubLogin, "octocat");
  }
});

test("planTenantMemberships keeps the personal 'admin' row when a tenant is both personal and an org", () => {
  // Guard: a tenant that appears in both sets resolves to the personal 'admin' row (personal wins).
  const desired = planTenantMemberships({
    githubUserId: 7,
    githubLogin: "octocat",
    personalTenantId: "tenant-x",
    orgTenants: [{ tenantId: "tenant-x", role: "member" }],
  });
  assert.equal(desired.length, 1);
  assert.equal(desired[0].role, "admin");
});

test("planTenantMemberships returns an empty set for a viewer with no personal tenant and no known orgs", () => {
  // The complement of the empty set is ALL of this user's existing rows -> the sync deletes them (they
  // left every org / their personal tenant is gone).
  assert.deepEqual(
    planTenantMemberships({ githubUserId: 7, githubLogin: "octocat", orgTenants: [] }),
    [],
  );
});

/* --- tenant switcher ordering (sortViewerTenants): personal first, then orgs, each alphabetical. --- */

test("sortViewerTenants puts personal tenants first then orgs, alphabetical within each group", () => {
  const input: ViewerTenant[] = [
    { tenant_id: "o2", login: "zebra-org", type: "Organization", role: "member" },
    { tenant_id: "o1", login: "acme", type: "Organization", role: "admin" },
    { tenant_id: "p1", login: "octocat", type: "User", role: "admin" },
  ];
  assert.deepEqual(
    sortViewerTenants(input).map((t) => t.login),
    ["octocat", "acme", "zebra-org"],
  );
});
