import { timingSafeEqual } from "node:crypto";

import type { Context } from "hono";

import type { AppConfig } from "./config.js";
import type { BillingService } from "./billing.js";
import { normalizeDecimalLiteral } from "./billing-math.js";
import { ApiError } from "./errors.js";
import { looksLikeJwt, verifyGoogleIdToken } from "./google-oidc.js";
import { getOpenAiModelPricing, type OpenAiModelPrice } from "./model-settings.js";
import {
  completeReviewRun,
  EMPTY_MODEL_SETTINGS,
  getModelSettingsForRun,
  getOrCreateContextExecutionProfile,
  getReviewProviderResolution,
  getReviewSupersession,
  getTenantBillingIdentity,
  saveRunModelSettingsSnapshot,
  getReviewRunStatus,
  isTerminalReviewRunStatus,
  persistReviewFindings,
  persistReviewUsageRecords,
  reconcileReviewRunBillingKeySource,
  recordInstallation,
  recordReviewEvent as storeRecordReviewEvent,
  prepareReviewRun,
  reopenBlockedReviewRun,
  reconcileBoardReviewTerminal,
  ReviewDispatchNotBoundError,
  ReviewDispatchProvenanceError,
  resolveIntegrationKeysForRun,
  ReviewRunNotFoundError,
  type CreateReviewRunInput,
  type InstallationRepository,
  type InstallationLifecycle,
  type ModelSettings,
  type ReviewUsageInput,
  type ReviewUsageRecord,
} from "./store.js";

export interface InstallationBackfillStore {
  recordInstallation: typeof recordInstallation;
  getTenantBillingIdentity: typeof getTenantBillingIdentity;
}

export type InstallationCustomerProvisioner = Pick<BillingService, "provisionTenantCustomer">;

const installationBackfillStore: InstallationBackfillStore = { recordInstallation, getTenantBillingIdentity };

export async function prepareReview(c: Context, config: AppConfig, billing?: BillingService): Promise<Response> {
  authorizeInternal(c, config);
  const body = await readJson(c);
  const triggerRunId = stringValue(body.trigger_run_id);
  const payload = objectAt(body, ["payload"]);
  const repository = objectAt(payload, ["repository"]);
  const pullRequest = objectAt(payload, ["pull_request"]);
  const idempotencyKey = stringValue(body.idempotency_key) ?? stringAt(payload, ["review_idempotency_key"]);
  const installationId = numberAt(payload, ["github_installation_id"]);
  if (!idempotencyKey) {
    throw new ApiError(400, "idempotency_key is required");
  }
  if (!installationId) {
    throw new ApiError(400, "github_installation_id is required");
  }

  let reviewRunId: string;
  try {
    reviewRunId = await prepareReviewRun({
      triggerRunId,
      idempotencyKey,
      deliveryId: stringAt(payload, ["delivery_id"]),
      sourceEvent: stringAt(payload, ["source_event"]),
      triggerSource: stringAt(payload, ["trigger"]),
      ...reviewCommandFieldsFromPayload(payload),
      orchestrationPayload: payload,
      installationId,
      account: {
        id: numberAt(repository, ["owner_id"]),
        login: stringAt(repository, ["owner"]),
        type: stringAt(repository, ["owner_type"]),
      },
      repository: {
        githubRepoId: numberAt(repository, ["github_repo_id"]),
        owner: stringAt(repository, ["owner"]),
        name: stringAt(repository, ["name"]),
        fullName: stringAt(repository, ["full_name"]),
        defaultBranch: stringAt(repository, ["default_branch"]),
        private: booleanAt(repository, ["private"]),
      },
      pullRequest: {
        number: numberAt(pullRequest, ["number"]),
        title: stringAt(pullRequest, ["title"]),
        htmlUrl: stringAt(pullRequest, ["html_url"]),
        author: stringAt(pullRequest, ["author"]),
        headSha: stringAt(pullRequest, ["head_sha"]),
        baseSha: stringAt(pullRequest, ["base_sha"]),
        headRef: stringAt(pullRequest, ["head_ref"]),
        baseRef: stringAt(pullRequest, ["base_ref"]),
        draft: booleanAt(pullRequest, ["draft"]),
      },
    });
  } catch (error) {
    if (error instanceof ReviewDispatchNotBoundError) {
      throw new ApiError(503, "review dispatch is not bound yet", { code: "review_dispatch_not_bound" });
    }
    if (error instanceof ReviewDispatchProvenanceError) {
      throw new ApiError(409, "review dispatch provenance check failed", { code: "review_dispatch_conflict" });
    }
    throw error;
  }

  // Resolve per-tenant model selection for this run. A lookup failure must never fail
  // prepare — fall back to all-null (platform defaults) with a warning.
  let modelSettings: ModelSettings = { ...EMPTY_MODEL_SETTINGS };
  try {
    modelSettings = await getModelSettingsForRun(reviewRunId);
    // SNAPSHOT the resolved model set onto the run BEFORE the billing gate, so the gate, the worker's
    // later key resolution, and settlement all classify coverage from the SAME models this response hands
    // the worker. WRITE-ONCE + adopt the returned value: a rerun reuses the run row, so the FIRST
    // snapshot stays authoritative and this response's payload matches it (never a fresher live read).
    modelSettings = await saveRunModelSettingsSnapshot(reviewRunId, modelSettings);
  } catch (error) {
    console.warn("model_settings_lookup_failed", {
      review_run_id: reviewRunId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // FINDING 2: PREPARE is the single billing enforcement point. Under "on", a denied gate returns 402
  // and the review does not proceed (blocked VISIBLY — a terminal blocked_insufficient_credits run +
  // progress comment); "shadow"/"off" never block. prepareRunBilling never throws. FINDING 4: the gate
  // helper first reopens a rerun that reused a blocked run's idempotency key.
  if (billing) {
    const gate = await runPrepareBillingGate(reviewRunId, triggerRunId, billing);
    if (gate.blocked) {
      throw new ApiError(402, "insufficient credits to run this review", {
        reason: gate.reason,
        review_run_id: reviewRunId,
      });
    }
  }

  console.info("prepared_review_run", { review_run_id: reviewRunId, trigger_run_id: triggerRunId });

  return c.json({ ok: true, review_run_id: reviewRunId, model_settings: modelSettings, message: "review run accepted" });
}

/** Preserve authorized manual-review identity and guidance on the durable product run. */
export function reviewCommandFieldsFromPayload(
  payload: Record<string, unknown>,
): Partial<Pick<CreateReviewRunInput, "manualCommandTag" | "reviewInstructions">> {
  const manualCommandTag = stringAt(payload, ["manual_command_tag"]);
  const reviewInstructions = stringAt(payload, ["review_instructions"]);
  return {
    ...(manualCommandTag ? { manualCommandTag } : {}),
    ...(reviewInstructions ? { reviewInstructions } : {}),
  };
}

export async function reconcileReviewTerminal(
  c: Context,
  config: AppConfig,
  billing?: BillingService,
): Promise<Response> {
  authorizeInternal(c, config);
  const body = await readJson(c);
  const boardWorkflowId = stringValue(body.board_workflow_id);
  const triggerRunId = stringValue(body.trigger_run_id);
  const providerStatus = stringValue(body.provider_status);
  const diagnostic = stringValue(body.diagnostic)?.slice(0, 2_000);
  if (!boardWorkflowId || !triggerRunId || !providerStatus || !diagnostic) {
    throw new ApiError(
      400,
      "board_workflow_id, trigger_run_id, provider_status, and diagnostic are required",
    );
  }
  const status = reviewTerminalProductStatus(providerStatus);
  if (!status) throw new ApiError(400, "provider_status is not a failed terminal Trigger status");
  let result: Awaited<ReturnType<typeof reconcileBoardReviewTerminal>>;
  try {
    result = await reconcileBoardReviewTerminal({
      boardWorkflowId,
      triggerRunId,
      providerStatus,
      status,
      diagnostic,
    });
  } catch (error) {
    if (error instanceof ReviewDispatchProvenanceError) {
      throw new ApiError(409, "review dispatch provenance check failed", {
        code: "review_dispatch_conflict",
      });
    }
    throw error;
  }
  if (result.outcome === "updated" && result.reviewRunId && billing) {
    await billing.settleReviewOutcome(result.reviewRunId, status);
  }
  console.info("reconciled_review_terminal", {
    board_workflow_id: boardWorkflowId,
    trigger_run_id: triggerRunId,
    provider_status: providerStatus,
    outcome: result.outcome,
  });
  return c.json({ ok: true, outcome: result.outcome });
}

export function reviewTerminalProductStatus(value: string): "failed" | "canceled" | undefined {
  if (value === "CANCELED") return "canceled";
  if (["FAILED", "CRASHED", "SYSTEM_FAILURE", "EXPIRED", "TIMED_OUT"].includes(value)) {
    return "failed";
  }
  return undefined;
}

/**
 * FINDING 4 store seam for runPrepareBillingGate — the three run-state mutations it performs. Injectable
 * (defaults to the real store) so the reopen-then-pass / reopen-then-block-again flows are unit-testable
 * without a database.
 */
export interface PrepareGateStore {
  reopenBlockedReviewRun: (reviewRunId: string) => Promise<boolean>;
  completeReviewRun: typeof completeReviewRun;
  recordReviewEvent: typeof storeRecordReviewEvent;
}

const defaultPrepareGateStore: PrepareGateStore = {
  reopenBlockedReviewRun,
  completeReviewRun,
  recordReviewEvent: storeRecordReviewEvent,
};

/**
 * The single prepare-time billing enforcement point (FINDING 2), extracted from prepareReview so it is
 * unit-testable. Two steps:
 *  1. FINDING 4: reopen a rerun that reused a blocked run's idempotency key. createReviewRun's
 *     `on conflict` returns the SAME row for the same PR head, so a previously terminal
 *     'blocked_insufficient_credits' run is a dead row whose later event/completion writes the terminal
 *     guard ignores. Reopening resets it to 'queued' (and drops its pinned billing row) so this attempt
 *     proceeds live. Only blocked runs reopen; other terminal statuses keep their reuse behavior.
 *  2. Run the prepare gate. If blocked, finalize the run terminal as 'blocked_insufficient_credits'
 *     (FINDING 5: its 'blocked' bot_status flows through settlement's not-completed waive branch, so it
 *     is never billed) + append a 'billing_blocked' audit event, then return { blocked }. The caller
 *     turns blocked into a 402. Finalization must not turn the 402 into a 500 — any failure is swallowed
 *     and the drain/backstop reconciles. A reopen-then-block-again re-completes as blocked (idempotent).
 */
export async function runPrepareBillingGate(
  reviewRunId: string,
  triggerRunId: string | undefined,
  billing: Pick<BillingService, "prepareRunBilling">,
  store: PrepareGateStore = defaultPrepareGateStore,
): Promise<{ blocked: boolean; reason?: string }> {
  if (await store.reopenBlockedReviewRun(reviewRunId)) {
    console.info("reopened_blocked_review_run", { review_run_id: reviewRunId });
  }

  const gate = await billing.prepareRunBilling(reviewRunId);
  if (!gate.blocked) {
    return { blocked: false };
  }

  const reason = gate.reason ?? "billing_blocked";
  try {
    await store.completeReviewRun(
      reviewRunId,
      "blocked_insufficient_credits",
      botStatusFor("blocked_insufficient_credits"),
      null,
      reason,
      triggerRunId,
    );
    await store.recordReviewEvent(
      reviewRunId,
      "billing_blocked",
      botStatusFor("billing_blocked"),
      { reason },
      triggerRunId,
    );
  } catch (error) {
    console.warn("prepared_review_run_block_finalize_failed", {
      review_run_id: reviewRunId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  console.info("prepared_review_run_blocked", { review_run_id: reviewRunId, reason });
  return { blocked: true, reason };
}

export async function recordReviewEvent(c: Context, config: AppConfig): Promise<Response> {
  authorizeInternal(c, config);
  const reviewRunId = requiredParam(c, "reviewRunId");
  const body = await readJson(c);
  const status = stringValue(body.status) ?? "event";
  const payload = body.payload;

  await storeRecordReviewEvent(reviewRunId, status, botStatusFor(status), payload, stringValue(body.trigger_run_id));

  // Finding persistence is secondary. A persist failure must not 500 the event
  // callback and break the review pipeline.
  if (shouldPersistFindings(status, payload)) {
    try {
      await persistReviewFindings(reviewRunId, payload);
    } catch (error) {
      console.warn("finding_persist_failed", {
        review_run_id: reviewRunId,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.info("recorded_review_event", { review_run_id: reviewRunId, status });

  return c.json({ ok: true, review_run_id: reviewRunId });
}

export async function reviewSupersession(c: Context, config: AppConfig): Promise<Response> {
  authorizeInternal(c, config);
  const reviewRunId = requiredParam(c, "reviewRunId");
  return c.json({ superseded: (await getReviewSupersession(reviewRunId)) ?? null });
}

export async function completeReview(
  c: Context,
  config: AppConfig,
  billing?: BillingService,
): Promise<Response> {
  authorizeInternal(c, config);
  const reviewRunId = requiredParam(c, "reviewRunId");
  const body = await readJson(c);
  const completion = objectAt(body, ["payload"]);
  const status = stringAt(completion, ["status"]) ?? "completed";
  const botStatus = botStatusFor(status);

  const updated = await completeReviewRun(
    reviewRunId,
    status,
    botStatus,
    body.payload,
    stringAt(completion, ["error"]),
    stringValue(body.trigger_run_id),
  );

  try {
    await persistReviewFindings(reviewRunId, body.payload);
  } catch (error) {
    console.warn("finding_persist_failed", {
      review_run_id: reviewRunId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // The completion payload may carry a usage fallback channel: `usage_records_fallback` is an array of
  // { stage, sandbox_id, key_source, usage_records } batches (the same shape the usage endpoint takes),
  // delivered here when the live per-stage usage POST failed. Persist each batch BEFORE settlement so
  // its rows are billed in the same terminal transition. Idempotent dedupe on (review_run_id,
  // dedupe_key) makes replays safe, and a persist failure must never fail completion (the scheduled
  // drain reconciles). Runs the SAME billingActive flag as recordReviewUsage so shadow/off stays inert.
  const fallbackResult = await persistUsageFallback(reviewRunId, completion, billing);

  if (!updated) {
    // FINDING 2: late fallback usage on an ALREADY-terminal run persists above, but the terminal
    // transition happened on an earlier completion (updated===false), so the settlement below is
    // skipped and the rows would sit pending_outcome until the 15-min drain. The dedicated /usage
    // route settles such arrivals immediately; the fallback channel must match. Settle whenever the
    // payload CARRIED fallback entries — not only when new rows inserted: a prior /complete attempt
    // may have persisted the same rows and crashed before settling; this replay then dedupes to zero
    // inserts but the rows still need settlement (idempotent either way — PR #141 re-review finding).
    if (billing && fallbackResult.attempted) {
      await settleTerminalArrival(reviewRunId, billing);
    }
    console.info("ignored_terminal_review_completion", { review_run_id: reviewRunId, status });
    return c.json({ ok: true, review_run_id: reviewRunId, updated, message: "review run already terminal" });
  }

  // Settle billing ONLY on the first terminal transition (updated===true) — that is the infra-charge
  // idempotency hook. settleReviewOutcome never throws: a billing failure must never fail completion.
  if (billing) {
    await billing.settleReviewOutcome(reviewRunId, botStatus);
  }

  console.info("completed_review_run", { review_run_id: reviewRunId, status });

  return c.json({ ok: true, review_run_id: reviewRunId, updated, message: "review run completed" });
}

export async function acceptBackfill(
  c: Context,
  config: AppConfig,
  billing?: InstallationCustomerProvisioner,
  store: InstallationBackfillStore = installationBackfillStore,
): Promise<Response> {
  authorizeInternal(c, config);
  const body = await readJson(c);
  const payload = objectAt(body, ["payload"]);
  const account = objectAt(payload, ["account"]);
  const repositories = [...(arrayAt(payload, ["repositories"]) ?? []), ...(arrayAt(payload, ["repositories_added"]) ?? [])];
  const removedRepositories = arrayAt(payload, ["repositories_removed"]) ?? [];

  const accountId = numberAt(account, ["github_account_id"]);
  const accountLogin = stringAt(account, ["login"]);
  const accountType = stringAt(account, ["type"]);
  const sender = objectAt(payload, ["sender"]);
  const installationId = numberAt(payload, ["github_installation_id"]);
  const installerId = numberAt(sender, ["github_user_id"]);
  const installerLogin = stringAt(sender, ["login"]);
  const sourceEvent = stringAt(payload, ["source_event"]);
  const action = stringAt(payload, ["action"]);
  const lifecycle: InstallationLifecycle | undefined = sourceEvent === "installation"
    ? action === "suspended"
      ? "suspended"
      : action === "deleted"
        ? "deleted"
        : action === "created" || action === "unsuspended"
          ? "active"
          : undefined
    : undefined;
  if (!installationId || !accountId || !accountLogin || (accountType !== "Organization" && accountType !== "User")) {
    throw new ApiError(400, "installation backfill requires a complete GitHub installation account identity");
  }
  if (accountType === "Organization" && (!installerId || !installerLogin)) {
    throw new ApiError(400, "organization installation backfill requires the GitHub webhook sender");
  }
  const tenantId = await store.recordInstallation({
    installationId,
    account: {
      id: accountId,
      login: accountLogin,
      type: accountType,
    },
    installer: {
      id: installerId,
      login: installerLogin,
    },
    lifecycle,
    repositories: repositories.map(toInstallationRepository),
    removedRepositories: removedRepositories.map(toInstallationRepository),
  });

  const billingIdentity = lifecycle === "suspended" || lifecycle === "deleted"
    ? undefined
    : await store.getTenantBillingIdentity(tenantId);
  const customerProvisioned = billing && billingIdentity
    ? await billing.provisionTenantCustomer(tenantId, `${billingIdentity.name} (${billingIdentity.kind})`, {
        jina_tenant_id: tenantId,
        jina_tenant_name: billingIdentity.name,
        jina_tenant_kind: billingIdentity.kind,
      })
    : false;

  console.info("accepted_installation_backfill", {
    trigger_run_id: body.trigger_run_id,
    customer_provisioned: customerProvisioned,
  });

  return c.json({ ok: true, customer_provisioned: customerProvisioned });
}

export async function resolveIntegrations(
  c: Context,
  config: AppConfig,
  loadOpenAiPricing: () => Promise<Record<string, OpenAiModelPrice>> = getOpenAiModelPricing,
): Promise<Response> {
  authorizeInternal(c, config);
  const body = await readJson(c);
  // Resolution is bound to the persisted review run: the run row is the source of truth for the
  // tenant, so keys can only be read for that run's owner (prevents IDOR via client-supplied ids) AND
  // the tenant's model-provider preference is honored (resolveIntegrationKeysForRun applies it). The
  // worker always sends review_run_id (see trigger resolveProviderKeys); the old installation/account
  // fallback resolved only the OpenRouter key and IGNORED the provider preference, so a tenant set to
  // 'managed'/'openai' could still leak its OpenRouter key as a "user" run. Require the run id instead.
  const reviewRunId = stringValue(body.review_run_id);
  if (!reviewRunId) {
    throw new ApiError(400, "review_run_id is required to resolve integration keys");
  }
  const keys = await resolveIntegrationKeysForRun(reviewRunId);
  const routing = await getReviewProviderResolution(reviewRunId);
  const providerUnavailable =
    routing.provider !== "managed" &&
    !keys.codexHarnessAuth &&
    !keys.openrouter &&
    !keys.openaiApiKey &&
    routing.fallbackPolicy !== "managed";
  // A managed run (no author harness, no tenant OpenRouter key, no tenant BYOK OpenAI key) is the only
  // run wired to the managed OPENAI_API_KEY, so it is the only one that carries the native-OpenAI pricing
  // map — the capture proxy needs it to compute native-route cost (api.openai.com returns tokens but no
  // cost). A BYOK OpenAI run routes natively under the TENANT's own key and is billed infra-only, so it
  // needs neither the managed key nor its pricing. A catalog outage degrades to {} (native cost then
  // recorded missing) rather than failing key resolution.
  const managedRun = !keys.codexHarnessAuth && !keys.openrouter && !keys.openaiApiKey;
  const openaiModelPricing = managedRun ? await loadOpenAiPricing() : {};
  // codex_harness_auth carries the PR author's own-harness credential (the decrypted auth.json blob)
  // to the trigger worker, which treats its presence as the highest-precedence credential. This
  // internal endpoint is internal-token authorized; the blob is intended for the worker here and,
  // unlike the dashboard GET path, is deliberately returned.
  return c.json({
    openrouter_api_key: keys.openrouter ?? null,
    // Tenant BYOK native OpenAI key. When present (and no author harness), the worker routes openai/*
    // review models natively to api.openai.com under this key and classifies the run BYOK ("user"),
    // billed infra-only. Precedence in the worker: harness > openrouter > openai(native) > managed.
    openai_api_key: keys.openaiApiKey ?? null,
    codex_harness_auth: keys.codexHarnessAuth ?? null,
    // Opaque millisecond revision for the exact harness blob returned above. Runtime failure events
    // echo it so a stale in-flight run can never invalidate credentials connected after that run.
    codex_harness_connected_at_ms: keys.codexHarnessConnectedAtMs ?? null,
    // Native-OpenAI per-token pricing keyed by `openai/<model>` slug; {} for BYOK/harness runs (which
    // don't use the managed OpenAI key) or on a catalog outage.
    openai_model_pricing: openaiModelPricing,
    provider_unavailable_reason: providerUnavailable
      ? `The selected ${routing.provider} provider has no usable credential and managed fallback is disabled.`
      : null,
  });
}

/** Return the write-once provider/model profile used by one Context build. */
export async function resolveContextExecutionProfile(c: Context, config: AppConfig): Promise<Response> {
  authorizeInternal(c, config);
  const body = await readJson(c);
  const tenantId = stringValue(body.tenant_id);
  const buildId = stringValue(body.build_id);
  if (!tenantId || !buildId) {
    throw new ApiError(400, "tenant_id and build_id are required");
  }
  return c.json(await getOrCreateContextExecutionProfile(tenantId, buildId));
}

/**
 * Persist exact LLM usage for a run. Unlike recordReviewEvent (which swallows secondary
 * persist failures to protect the pipeline), this endpoint returns 5xx on persist failure
 * so Trigger's retry machinery re-posts — losing usage data means silently lost revenue.
 * Replays are safe because rows dedupe on (review_run_id, dedupe_key).
 */
export async function recordReviewUsage(c: Context, config: AppConfig, billing?: BillingService): Promise<Response> {
  authorizeInternal(c, config);
  const reviewRunId = requiredParam(c, "reviewRunId");
  const body = await readJson(c);
  const input = parseUsageRequestBody(body);

  let result: { persisted: number; deduped: number };
  try {
    // FINDING 2: when billing is inactive (enforce=off or no secret) managed rows persist as
    // 'not_billable' — telemetry only — so a later flip to 'on' never back-bills them. Active
    // billing (shadow/on) keeps managed rows 'pending_outcome' for the accrue-then-drain path.
    result = await persistReviewUsageRecords(reviewRunId, input, billing?.isActive() ?? false);
  } catch (error) {
    if (error instanceof ReviewRunNotFoundError) {
      throw new ApiError(404, "review run not found");
    }
    // Deliberately let persistence failures propagate to a 5xx so the caller retries.
    throw error;
  }

  console.info("recorded_review_usage", {
    review_run_id: reviewRunId,
    persisted: result.persisted,
    deduped: result.deduped,
  });

  // FINDING 4: reconcile the run-level key_source with the key actually posted for these rows. prepare
  // pinned it from tenant state, but the key used at stage time can differ (e.g. a user key deleted
  // between prepare and stage); the run column then misreports while the usage rows carry the truth.
  // Overwrite the run record with the posted value on arrival and warn (billing_key_source_drift) when
  // it differed, so the usage rows and the run record agree and the drift is visible for ops. Never
  // fail the response on a reconcile hiccup — persistence already succeeded.
  await reconcileRunKeySource(reviewRunId, input.key_source);

  // FINDING B: usage can arrive after the run is already terminal (generation-stats backfills, late
  // stage callbacks). Such rows land as pending_outcome and would sit unbilled until a drain runs.
  // Settle them on arrival with the SAME run-level helper the retry drain uses (completed -> compute +
  // bill with entitlement recheck; failed/superseded -> waive). Persist already succeeded, so a
  // settlement failure must NOT fail this response — catch and warn; the scheduled drain is the backstop.
  if (billing) {
    await settleTerminalArrival(reviewRunId, billing);
  }

  return c.json({ ok: true, persisted: result.persisted, deduped: result.deduped });
}

/**
 * Persist any usage batches carried on the completion payload's fallback channel. Each entry is the
 * same { stage, sandbox_id, key_source, usage_records } shape the usage endpoint validates. Failures
 * (malformed entry, persist error) are caught + warned so completion never fails; dedupe makes replays
 * safe. billingActive mirrors recordReviewUsage so inactive billing persists telemetry only.
 */
async function persistUsageFallback(
  reviewRunId: string,
  completion: Record<string, unknown>,
  billing?: BillingService,
): Promise<{ attempted: boolean; persisted: number }> {
  const fallback = completion.usage_records_fallback;
  if (!Array.isArray(fallback) || fallback.length === 0) {
    return { attempted: false, persisted: 0 };
  }
  const billingActive = billing?.isActive() ?? false;
  let persisted = 0;
  for (const entry of fallback) {
    try {
      const input = parseUsageRequestBody(entry);
      const result = await persistReviewUsageRecords(reviewRunId, input, billingActive);
      persisted += result.persisted;
      // FINDING 4: fallback usage carries the runtime key_source too — reconcile the run record so it
      // agrees with the posted rows even when the live per-stage POST failed and only the fallback landed.
      await reconcileRunKeySource(reviewRunId, input.key_source);
    } catch (error) {
      console.warn("usage_fallback_persist_failed", {
        review_run_id: reviewRunId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { attempted: true, persisted };
}

/**
 * FINDING 2: shared arrival-settlement wrapper used by BOTH the /usage route and the completion
 * fallback channel so late usage on an already-terminal run settles identically on either path. Fetches
 * the run's stored status and, if terminal, settles the outcome. Persistence already succeeded, so a
 * settlement (or status-lookup) failure must NOT fail the caller's response — catch and warn; the
 * scheduled drain is the backstop.
 */
async function settleTerminalArrival(
  reviewRunId: string,
  billing: Pick<BillingService, "settleReviewOutcome">,
): Promise<void> {
  try {
    const status = await getReviewRunStatus(reviewRunId);
    await settleIfTerminalRun(reviewRunId, status, billing);
  } catch (error) {
    console.warn("arrival_settlement_failed", {
      review_run_id: reviewRunId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Pure settle-decision core (no DB fetch, no catch) so it is unit-testable: settle a run's billing
 * outcome iff the run is in a terminal status. Extracted from settleTerminalArrival's DB/error glue.
 */
export async function settleIfTerminalRun(
  reviewRunId: string,
  status: string | undefined,
  billing: Pick<BillingService, "settleReviewOutcome">,
): Promise<void> {
  if (status && isTerminalReviewRunStatus(status)) {
    await billing.settleReviewOutcome(reviewRunId, status);
  }
}

/**
 * FINDING 4: reconcile review_run_billing.key_source with the posted runtime value and emit
 * billing_key_source_drift when it differed from the prepare-time pin. Never throws — reconciliation
 * is best-effort telemetry, not on the persistence path.
 */
async function reconcileRunKeySource(reviewRunId: string, keySource: "user" | "managed" | "harness"): Promise<void> {
  try {
    const reconciled = await reconcileReviewRunBillingKeySource(reviewRunId, keySource);
    if (reconciled && keySourceDrifted(reconciled.pinned, keySource)) {
      console.warn("billing_key_source_drift", {
        review_run_id: reviewRunId,
        tenant_id: reconciled.tenantId,
        pinned: reconciled.pinned,
        actual: keySource,
      });
    }
  } catch (error) {
    console.warn("billing_key_source_reconcile_failed", {
      review_run_id: reviewRunId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** True when a run's pinned key_source is present and disagrees with the runtime-posted value. */
export function keySourceDrifted(pinned: string | null, actual: string): boolean {
  return pinned !== null && pinned !== actual;
}

/** Validate the Trigger usage payload contract. Throws ApiError(400) on any shape violation. */
export function parseUsageRequestBody(body: unknown): ReviewUsageInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "usage request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  if (record.stage !== "summary" && record.stage !== "runtime") {
    throw new ApiError(400, "usage request stage must be 'summary' or 'runtime'");
  }
  if (typeof record.sandbox_id !== "string" || record.sandbox_id.length === 0) {
    throw new ApiError(400, "usage request sandbox_id is required");
  }
  // 'harness' mirrors the runtime credential precedence (author harness > tenant openrouter > managed);
  // the trigger types already admit it, so the parser must not reject it if native/own-harness usage
  // ever posts. Like 'user', it is non-billable (see usageBillingStatus).
  if (record.key_source !== "user" && record.key_source !== "managed" && record.key_source !== "harness") {
    throw new ApiError(400, "usage request key_source must be 'user', 'managed', or 'harness'");
  }
  if (!Array.isArray(record.usage_records)) {
    throw new ApiError(400, "usage request usage_records must be an array");
  }
  return {
    stage: record.stage,
    sandbox_id: record.sandbox_id,
    key_source: record.key_source,
    usage_records: record.usage_records.map((value, index) => parseUsageRecord(value, index)),
  };
}

function parseUsageRecord(value: unknown, index: number): ReviewUsageRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, `usage_records[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.operation !== "string" || record.operation.length === 0) {
    throw new ApiError(400, `usage_records[${index}].operation is required`);
  }
  // FINDING C: request_seq feeds an integer column — Number.isFinite let 1.5 through, causing a
  // deterministic DB error and a 5xx retry loop. Require a safe non-negative integer up front.
  if (!Number.isSafeInteger(record.request_seq) || (record.request_seq as number) < 0) {
    throw new ApiError(400, `usage_records[${index}].request_seq must be a non-negative integer`);
  }
  if (!record.raw_usage || typeof record.raw_usage !== "object" || Array.isArray(record.raw_usage)) {
    throw new ApiError(400, `usage_records[${index}].raw_usage must be an object`);
  }
  return {
    operation: record.operation,
    request_seq: record.request_seq as number,
    model: stringValue(record.model),
    generation_id: stringValue(record.generation_id),
    prompt_tokens: optionalTokenCount(record.prompt_tokens, index, "prompt_tokens"),
    completion_tokens: optionalTokenCount(record.completion_tokens, index, "completion_tokens"),
    total_tokens: optionalTokenCount(record.total_tokens, index, "total_tokens"),
    reasoning_tokens: optionalTokenCount(record.reasoning_tokens, index, "reasoning_tokens"),
    cached_tokens: optionalTokenCount(record.cached_tokens, index, "cached_tokens"),
    cache_write_tokens: optionalTokenCount(record.cache_write_tokens, index, "cache_write_tokens"),
    // cost fields are decimal strings; keep them as strings for the numeric columns.
    cost: optionalDecimalString(record.cost, index, "cost"),
    upstream_inference_cost: optionalDecimalString(record.upstream_inference_cost, index, "upstream_inference_cost"),
    // OpenRouter usage.is_byok: optional boolean, defaults to false. Drives the BYOK billing basis
    // server-side (persistReviewUsageRecords). A present non-boolean is a contract violation -> 400.
    is_byok: optionalBoolean(record.is_byok, index, "is_byok"),
    raw_usage: record.raw_usage,
    raw_response_metadata:
      record.raw_response_metadata && typeof record.raw_response_metadata === "object" && !Array.isArray(record.raw_response_metadata)
        ? record.raw_response_metadata
        : undefined,
  };
}

/**
 * FINDING C: token counts feed bigint columns. Absent (null/undefined) is fine, but a present value
 * must be a safe non-negative integer — a float or negative would fail the insert and 5xx-loop.
 */
function optionalTokenCount(value: unknown, index: number, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(400, `usage_records[${index}].${field} must be a non-negative integer`);
  }
  return value;
}

/**
 * FINDING C/5: cost fields feed numeric(18,8) columns. Absent (null/undefined/empty) is fine, but a
 * present value must be a non-negative decimal the column can accept. The proxy preserves the wire
 * numeric literal, which may be scientific notation ("1.5e-7") or higher precision than numeric(18,8);
 * normalizeDecimalLiteral expands such literals EXACTLY into a plain decimal string (no float, no
 * lossy truncation — numeric(18,8) rounds on insert) that both the column and billing-math's
 * creditsForCost parse. A malformed value ('not-a-number', a signed/negative literal) -> 400.
 */
function optionalDecimalString(value: unknown, index: number, field: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ApiError(400, `usage_records[${index}].${field} must be a non-negative decimal string`);
  }
  const normalized = normalizeDecimalLiteral(value);
  if (normalized === undefined) {
    throw new ApiError(400, `usage_records[${index}].${field} must be a non-negative decimal string`);
  }
  return normalized;
}

/**
 * A wire flag (is_byok). Absent (null/undefined) defaults to false. A present value MUST be a real
 * boolean — a non-boolean is a contract violation (400) rather than a silently-coerced value, so a
 * malformed proxy payload can never quietly flip the billing basis.
 */
function optionalBoolean(value: unknown, index: number, field: string): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new ApiError(400, `usage_records[${index}].${field} must be a boolean`);
  }
  return value;
}

/** Drain pending billing events (scheduled/ops job). Internal-token authorized; returns counts. */
export async function retryBilling(c: Context, config: AppConfig, billing?: BillingService): Promise<Response> {
  authorizeInternal(c, config);
  const counts = billing
    ? await billing.retryPendingBillingEvents()
    : {
        usage_billed: 0,
        usage_failed: 0,
        runs_settled: 0,
        runs_failed: 0,
        infra_billed: 0,
        infra_failed: 0,
        stale_usage_rebilled: 0,
        stale_infra_rebilled: 0,
      };
  return c.json({ ok: true, ...counts });
}

function toInstallationRepository(value: unknown): InstallationRepository {
  const repo = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    githubRepoId: numberAt(repo, ["id"]) ?? numberAt(repo, ["github_repo_id"]),
    owner: stringAt(repo, ["owner"]),
    name: stringAt(repo, ["name"]),
    fullName: stringAt(repo, ["full_name"]),
    private: booleanAt(repo, ["private"]),
  };
}

export function authorizeInternal(c: Context, config: AppConfig): void {
  const provided = Buffer.from(c.req.header("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${config.internalApiToken}`);
  // Length guard before timingSafeEqual (it throws on length mismatch); constant-time
  // compare avoids leaking the token byte-by-byte through response timing.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new ApiError(401, "invalid internal token");
  }
}

/**
 * Schedule endpoints accept a Google-signed OIDC identity token when scheduler
 * OIDC is configured, so Cloud Scheduler never stores a copy of the internal
 * API token in its job resource. The internal bearer keeps working for
 * operators and for deployments that have not switched the scheduler yet.
 */
export async function authorizeSchedule(c: Context, config: AppConfig): Promise<void> {
  const authorization = c.req.header("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  if (config.schedulerOidc && token && looksLikeJwt(token)) {
    try {
      await verifyGoogleIdToken(token, config.schedulerOidc);
      return;
    } catch {
      // Fall through to the internal bearer; either credential is sufficient.
    }
  }
  authorizeInternal(c, config);
}

function requiredParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (!value) {
    throw new ApiError(400, `missing route parameter ${name}`);
  }
  return value;
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  const body = (await c.req.json().catch(() => undefined)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

// The worker names failure events with an exact "failed"/"error" status or a "_failed"/
// "_error" suffix. Match that convention precisely
// instead of an open substring includes(), which would also flag statuses that merely
// contain the word (e.g. a hypothetical "error_recovered").
function isFailureStatus(status: string): boolean {
  if (NON_FATAL_FAILURE_EVENTS.has(status)) {
    return false;
  }
  return (
    status === "failed" ||
    status === "error" ||
    status.endsWith("_failed") ||
    status.endsWith("_error")
  );
}

const NON_FATAL_FAILURE_EVENTS = new Set([
  "github_review_progress_comment_update_failed",
  "github_runtime_review_publish_failed",
]);

export function botStatusFor(status: string): string {
  // A run blocked at prepare for billing is terminal but bills nothing (FINDING 5): a distinct
  // 'blocked' bot_status displays sensibly and is not 'completed', so settlement waives it.
  if (status === "blocked_insufficient_credits") {
    return "blocked";
  }
  if (isFailureStatus(status)) {
    return "failed";
  }
  if (status === "completed" || status === "superseded" || status.startsWith("completed")) {
    return status;
  }
  if (status === "superseded" || status === "cancelled" || status === "canceled") {
    return status;
  }
  return "running";
}

function shouldPersistFindings(status: string, payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const record = payload as Record<string, unknown>;
  return Array.isArray(record.findings);
}

function objectAt(value: unknown, path: string[]): Record<string, unknown> {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return {};
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
}

function arrayAt(value: unknown, path: string[]): unknown[] | undefined {
  const target = path.length === 0 ? value : objectAt(value, path.slice(0, -1))[path[path.length - 1] ?? ""];
  return Array.isArray(target) ? target : undefined;
}

function stringAt(value: unknown, path: string[]): string | undefined {
  const target = path.length === 0 ? value : objectAt(value, path.slice(0, -1))[path[path.length - 1] ?? ""];
  return stringValue(target);
}

function numberAt(value: unknown, path: string[]): number | undefined {
  const target = path.length === 0 ? value : objectAt(value, path.slice(0, -1))[path[path.length - 1] ?? ""];
  return typeof target === "number" && Number.isFinite(target) ? target : undefined;
}

function booleanAt(value: unknown, path: string[]): boolean | undefined {
  const target = path.length === 0 ? value : objectAt(value, path.slice(0, -1))[path[path.length - 1] ?? ""];
  return typeof target === "boolean" ? target : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
