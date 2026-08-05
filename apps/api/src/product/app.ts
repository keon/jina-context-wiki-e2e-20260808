import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import type { Context, Next } from "hono";
import { cors } from "hono/cors";

import {
  githubCallback,
  githubLogin,
  logout,
  me,
  refreshMe,
  requireDashboardSession,
  sessionAccessibleNames,
  teamAllowsProject,
  visibleProjects,
  type DashboardProject,
  type DashboardSession,
  type DashboardTeam,
} from "./auth.js";
import { createBillingService, normalizeTopupCredits } from "./billing.js";
import { admitScheduledBillingRetry } from "./billing-board-admission.js";
import {
  getRelationalBoardDashboardOverview,
  mergeDashboardWorkOverviews,
  type DashboardWorkOverview,
} from "./board-dashboard.js";
import { parseCodexConnectTelemetry } from "./codex-connect-telemetry.js";
import { normalizeCodexHarnessAuthInput, normalizeHarnessModelInput } from "./codex-harness.js";
import { dashboardOriginAllowed, type AppConfig } from "./config.js";
import { ApiError, jsonError } from "./errors.js";
import { handleGithubWebhook } from "./github.js";
import {
  canUserAdministerInstallation,
  getInstallationForApp,
  listInstallationRepositories,
} from "./github-app.js";
import { GraphApiClient } from "./graph-client.js";
import {
  acceptBackfill,
  authorizeInternal,
  authorizeSchedule,
  completeReview,
  prepareReview,
  recordReviewEvent,
  recordReviewUsage,
  resolveIntegrations,
  resolveContextExecutionProfile,
  retryBilling,
} from "./internal.js";
import {
  getModels,
  getModelSettings,
  parseModelSettingsBody,
  putModelSettings,
  validateModelSettingsSlugs,
} from "./model-settings.js";
import { openRouterOAuthCallback, startOpenRouterOAuth } from "./openrouter-oauth.js";
import { buildDashboard } from "./records.js";
import { ReviewOrchestratorDispatcher } from "./review-dispatcher.js";
import {
  connectGithubInstallationToTenant,
  createJinaOrganization,
  ensurePersonalTenantId,
  getReviewFindingRecords,
  getReviewGraphTarget,
  getReviewRunRecord,
  getReviewRunRecords,
  getScenarioLineageReviewRunRecords,
  getGithubTenantAdminRefreshRequirement,
  getTenantBillingPolicy,
  getTenantBillingIdentity,
  getTenantIdForUser,
  getTenantMemberStats,
  getTenantMembershipRole,
  getTenantIntegrations,
  getTenantModelProvider,
  getTenantModelSettingsById,
  getTenantReviewTriggerMode,
  getTenantUsageSummary,
  getUserIntegrations,
  InstallationTenantMoveConflictError,
  isGithubInstallationInstaller,
  isGithubInstallationRecorded,
  knownProjects,
  listTenantRepositoryAccess,
  listTenantGithubConnections,
  listManualReviewRuns,
  listViewerTenants,
  normalizeModelProvider,
  normalizeReviewTriggerMode,
  refreshGithubTenantAdminMembership,
  saveTenantAutoReviewLimit,
  saveTenantModelProvider,
  saveTenantModelSettingsById,
  saveTenantOpenRouterIntegration,
  saveTenantProviderKey,
  saveTenantReviewTriggerMode,
  saveUserHarnessIntegration,
  type TenantRole,
  updateJinaOrganizationName,
} from "./store.js";
import type { DashboardSession as Session } from "./auth.js";

const FLOW_ID_LOG_VALUE = /^[a-zA-Z0-9_-]{8,80}$/;

export function createApp(config: AppConfig): Hono {
  const reviewDispatcher = new ReviewOrchestratorDispatcher();
  const billing = createBillingService(config);
  const graphs = new GraphApiClient(config.graph);
  const app = new Hono();
  // Credentialed CORS requires an explicit allowlist. When DASHBOARD_ORIGIN is "*"/unset
  // we must NOT reflect an arbitrary origin together with credentials:true (that would let
  // any site make authenticated requests). Fail closed: reflect only allowlisted origins
  // with credentials; otherwise emit a non-credentialed wildcard.
  const hasExplicitAllowlist = config.dashboardAllowedOrigins !== "*";
  const dashboardCors = hasExplicitAllowlist
    ? cors({
        origin: (origin) => (dashboardOriginAllowed(config.dashboardAllowedOrigins, origin) ? origin : ""),
        allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
        allowHeaders: ["content-type"],
        exposeHeaders: ["server-timing"],
        credentials: true,
      })
    : cors({
        origin: "*",
        allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
        allowHeaders: ["content-type"],
        exposeHeaders: ["server-timing"],
        credentials: false,
      });

  app.onError((error, c) => jsonError(c, error));
  app.use("/dashboard/*", dashboardCors);
  app.use("/auth/*", dashboardCors);

  // FINDING 1 (credentialed CSRF): every credentialed, state-changing dashboard route must reject a
  // cross-site forgery. With SameSite=None cookies a cross-site `text/plain` "simple request" carries
  // the session cookie, so without these guards an attacker's page could overwrite or disconnect a
  // user's OpenRouter key (POST integrations), mutate model settings (PUT model-settings), or start an
  // OAuth flow. Two shared guards, applied to ALL credentialed writes (round 4 only guarded topup):
  //   requireDashboardOrigin — Origin present but not in the allowlist -> 403; absent Origin passes
  //     (non-browser clients omit it); a "*" allowlist permits any origin (dev/non-credentialed mode).
  //   requireJsonContentType — body-accepting writes must send application/json (415 otherwise), which
  //     closes the text/plain simple-request vector (a cross-site fetch cannot set application/json
  //     without a CORS preflight, which the credentialed allowlist already gates).
  const requireDashboardOrigin = async (c: Context, next: Next) => {
    const origin = c.req.header("origin");
    if (origin && !dashboardOriginAllowed(config.dashboardAllowedOrigins, origin)) {
      return c.json({ error: "origin not allowed" }, 403);
    }
    return next();
  };
  const requireJsonContentType = async (c: Context, next: Next) => {
    const contentType = c.req.header("content-type");
    if (!contentType || !contentType.toLowerCase().includes("application/json")) {
      return c.json({ error: "content-type must be application/json" }, 415);
    }
    return next();
  };

  app.get("/auth/github/login", (c) => githubLogin(c, config));
  app.get("/auth/github/callback", (c) => githubCallback(c, config));
  app.post("/auth/logout", (c) => logout(c, config));

  app.get("/dashboard/me", (c) => me(c, config));
  app.post("/dashboard/session/refresh", requireDashboardOrigin, (c) => refreshMe(c, config));
  app.get("/dashboard/review-runs", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = session ? await getTenantIdForUser(session.user.id, session.userId) : undefined;
    const project = c.req.query("project")?.trim();
    const teamId = c.req.query("team")?.trim();
    const limit = numberQuery(c.req.query("limit"));
    if (session && !tenantId) {
      return c.json({
        ...buildDashboard([], [], { limit: limit ?? 50 }),
        projects: [],
        teams: [],
        filters: {
          project: project || undefined,
        },
      });
    }

    const projects = tenantId ? await tenantDashboardProjects(tenantId) : await visibleProjects(session);
    const teams = tenantId ? tenantDashboardTeams(session, projects) : (session?.teams ?? []);
    const team = teamId ? teams.find((item) => item.id === teamId) : undefined;
    const allowedFullNames = tenantId
      ? (team?.project_full_names.map((name) => name.toLowerCase()) ?? null)
      : allowedDashboardProjectNames(session, team);

    const page = await getReviewRunRecords({
      tenantId,
      allowedFullNames,
      project: project || undefined,
      limit,
      cursor: c.req.query("cursor")?.trim() || undefined,
    });

    const findings = await getReviewFindingRecords({
      tenantId,
      allowedFullNames,
      project: project || undefined,
    });

    return c.json({
      ...buildDashboard(page.records, findings, {
        limit: page.limit,
        next_cursor: page.nextCursor,
      }),
      projects,
      teams,
      filters: {
        project: project || undefined,
        team: team?.id,
      },
    });
  });

  app.get("/dashboard/review-runs/:reviewRunId/scenario-lineage/:lineageKey", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = session ? await getTenantIdForUser(session.user.id, session.userId) : undefined;
    if (session && !tenantId) {
      return c.json({ review_runs: [] });
    }
    const records = await getScenarioLineageReviewRunRecords({
      reviewRunId: c.req.param("reviewRunId"),
      lineageKey: c.req.param("lineageKey"),
      tenantId,
      allowedFullNames: tenantId ? undefined : sessionAccessibleNames(session),
      limit: numberQuery(c.req.query("limit")),
    });
    return c.json({ review_runs: records });
  });

  app.get("/dashboard/review-runs/:reviewRunId", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = session ? await getTenantIdForUser(session.user.id, session.userId) : undefined;
    if (session && !tenantId) {
      return c.json({ error: "review run not found" }, 404);
    }
    const record = await getReviewRunRecord({
      reviewRunId: c.req.param("reviewRunId"),
      tenantId,
      allowedFullNames: tenantId ? undefined : sessionAccessibleNames(session),
    });
    if (!record) {
      return c.json({ error: "review run not found" }, 404);
    }
    return c.json({ review_run: record });
  });

  // Tenant-scoped review endpoints use the selected Jina organization as the
  // workspace boundary. The viewer-scoped forms above serve personal accounts
  // and local fixtures only.
  app.get("/dashboard/tenants/:tenantId/review-runs", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    const projects = await tenantDashboardProjects(tenantId);
    const teams = tenantDashboardTeams(session, projects);
    const project = c.req.query("project")?.trim();
    const teamId = c.req.query("team")?.trim();
    const team = teamId ? teams.find((item) => item.id === teamId) : undefined;
    const allowedFullNames = team ? team.project_full_names.map((name) => name.toLowerCase()) : null;

    const page = await getReviewRunRecords({
      tenantId,
      allowedFullNames,
      project: project || undefined,
      limit: numberQuery(c.req.query("limit")),
      cursor: c.req.query("cursor")?.trim() || undefined,
    });
    const findings = await getReviewFindingRecords({
      tenantId,
      allowedFullNames,
      project: project || undefined,
    });

    return c.json({
      ...buildDashboard(page.records, findings, {
        limit: page.limit,
        next_cursor: page.nextCursor,
      }),
      projects,
      teams,
      filters: {
        project: project || undefined,
        team: team?.id,
      },
    });
  });

  app.get("/dashboard/tenants/:tenantId/review-runs/:reviewRunId/scenario-lineage/:lineageKey", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    const records = await getScenarioLineageReviewRunRecords({
      reviewRunId: c.req.param("reviewRunId"),
      lineageKey: c.req.param("lineageKey"),
      tenantId,
      limit: numberQuery(c.req.query("limit")),
    });
    return c.json({ review_runs: records });
  });

  app.get("/dashboard/tenants/:tenantId/review-runs/:reviewRunId", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    const record = await getReviewRunRecord({
      reviewRunId: c.req.param("reviewRunId"),
      tenantId,
    });
    if (!record) {
      return c.json({ error: "review run not found" }, 404);
    }
    return c.json({ review_run: record });
  });

  const emptyIntegrations = {
    openrouter: { configured: false },
    openai: { configured: false },
    anthropic: { configured: false },
    codex_harness: { configured: false },
    codex_harness_model: null,
  };

  app.get("/dashboard/integrations", async (c) => {
    const session = await requireDashboardSession(c, config);
    if (!session) {
      return c.json(emptyIntegrations);
    }
    return c.json(await getUserIntegrations(session.user.id));
  });

  app.post(
    "/dashboard/integrations/codex/events",
    requireDashboardOrigin,
    requireJsonContentType,
    async (c) => {
      const session = await requireDashboardSession(c, config);
      if (!session) return c.body(null, 204);
      const event = parseCodexConnectTelemetry(await c.req.json().catch(() => null));
      const details = { user_id: session.user.id, ...event };
      if (event.event === "flow_failed") {
        console.warn("codex_connect_flow", details);
      } else {
        console.info("codex_connect_flow", details);
      }
      return c.body(null, 204);
    },
  );

  app.post("/dashboard/integrations", requireDashboardOrigin, requireJsonContentType, async (c) => {
    const session = await requireDashboardSession(c, config);
    if (!session) {
      return c.json(emptyIntegrations);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    // Legacy viewer-scoped save, kept for deploy skew. openrouter_api_key now writes the viewer's
    // PERSONAL tenant's tenant_integrations; the Codex harness fields (auth blob + model preference)
    // stay INDIVIDUAL on user_integrations. Any legacy provider-key fields are ignored. Both harness
    // fields are validated (throws 400) BEFORE anything is persisted; the submitted blob is never echoed.
    const codexHarnessAuth = normalizeCodexHarnessAuthInput(body.codex_harness_auth);
    const harnessModel = normalizeHarnessModelInput(body.codex_harness_model, "codex_harness_model" in body);
    await saveUserHarnessIntegration(session.user.id, {
      codexHarnessAuth,
      codexHarnessModel: harnessModel.model,
      codexHarnessModelProvided: harnessModel.provided,
      // Stamp the current login on every save so run-time author-login resolution can find this harness.
      githubLogin: session.user.login,
    });
    if (codexHarnessAuth !== undefined) {
      console.info("codex_harness_connection_saved", {
        user_id: session.user.id,
        action: codexHarnessAuth === "" ? "disconnected" : "connected",
        flow_id:
          typeof body.codex_harness_flow_id === "string" && FLOW_ID_LOG_VALUE.test(body.codex_harness_flow_id)
            ? body.codex_harness_flow_id
            : undefined,
      });
    }
    // A provided openrouter_api_key / openai_api_key / anthropic_api_key writes the personal tenant's key;
    // an explicit empty string disconnects it, and an omitted field leaves the stored key untouched. Only
    // ensure the personal tenant once, and only if at least one tenant-scoped key field was provided.
    const wantsOpenRouter = typeof body.openrouter_api_key === "string";
    const wantsOpenAi = typeof body.openai_api_key === "string";
    const wantsAnthropic = typeof body.anthropic_api_key === "string";
    if (wantsOpenRouter || wantsOpenAi || wantsAnthropic) {
      const tenantId = await ensurePersonalTenantId(session.user.id, session.user.login);
      if (tenantId) {
        if (wantsOpenRouter) {
          await saveTenantOpenRouterIntegration(tenantId, {
            openrouter: body.openrouter_api_key as string,
            openrouterSource: "manual",
            configuredByUserId: session.user.id,
            configuredByLogin: session.user.login,
          });
        }
        if (wantsOpenAi) {
          await saveTenantProviderKey(tenantId, "openai", {
            key: body.openai_api_key as string,
            configuredByUserId: session.user.id,
            configuredByLogin: session.user.login,
          });
        }
        if (wantsAnthropic) {
          await saveTenantProviderKey(tenantId, "anthropic", {
            key: body.anthropic_api_key as string,
            configuredByUserId: session.user.id,
            configuredByLogin: session.user.login,
          });
        }
      }
    }
    return c.json(await getUserIntegrations(session.user.id));
  });

  app.post("/dashboard/integrations/openrouter/oauth/start", requireDashboardOrigin, (c) =>
    startOpenRouterOAuth(c, config),
  );
  app.get("/dashboard/integrations/openrouter/oauth/callback", (c) => openRouterOAuthCallback(c, config));

  app.get("/dashboard/model-settings", (c) => getModelSettings(c, config));
  app.put("/dashboard/model-settings", requireDashboardOrigin, requireJsonContentType, (c) =>
    putModelSettings(c, config),
  );
  app.get("/dashboard/models", (c) => getModels(c));

  const unconfiguredBilling = {
    configured: false,
    status: "not_configured" as const,
    plan_id: null,
    credits_balance: null,
    managed_ai_access: null,
  };

  // NON-BLOCKING ADOPTED (a): a tenant-lookup EXCEPTION is an outage, not a missing account, so it must
  // read as 'unavailable' rather than 'not_configured'. Same null-field shape, distinct status.
  const unavailableBilling = { ...unconfiguredBilling, status: "unavailable" as const };

  // Billing overview: 'not_configured' when Autumn is unset or the viewer genuinely has no tenant;
  // 'unavailable' when the tenant lookup itself fails (outage) or Autumn errors; 'ok' with live data.
  app.get("/dashboard/billing", async (c) => {
    const session = await requireDashboardSession(c, config);
    if (!session) {
      return c.json(unconfiguredBilling);
    }
    // Distinguish a lookup FAILURE (exception -> outage -> unavailable) from a successful lookup that
    // returns no tenant (undefined -> not_configured, handled inside billing.overview).
    let tenantId: string | undefined;
    try {
      tenantId = await getTenantIdForUser(session.user.id, session.userId);
    } catch (error) {
      console.warn("billing_tenant_lookup_failed", {
        user: session.user.login,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(unavailableBilling);
    }
    // Name the Autumn customer from the TENANT identity (login + org/personal), never the person who
    // happens to open the page — a person-named customer is indistinguishable from their org's.
    const overviewIdentity = tenantId ? await tenantAutumnIdentity(tenantId) : {};
    return c.json(await billing.overview(tenantId, overviewIdentity.name, overviewIdentity.metadata));
  });

  // Overage-credit top-up checkout. 200 { url } or 409 { error } when billing is not configured.
  // The shared requireDashboardOrigin guard (FINDING 1) fronts this credentialed POST; it takes no
  // body, so no content-type guard is needed.
  app.post("/dashboard/billing/topup", requireDashboardOrigin, async (c) => {
    const session = await requireDashboardSession(c, config);
    if (!session || !billing.billingConfigured()) {
      return c.json({ error: "billing is not configured" }, 409);
    }
    // NON-BLOCKING ADOPTED (b): mirror the overview route's round-4 distinction — a tenant-lookup
    // EXCEPTION is an outage (502/unavailable), NOT a missing account. Only a successful lookup that
    // returns no tenant is "billing not configured for this account" (409).
    let tenantId: string | undefined;
    try {
      tenantId = await getTenantIdForUser(session.user.id, session.userId);
    } catch (error) {
      console.warn("billing_topup_tenant_lookup_failed", {
        user: session.user.login,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "billing is temporarily unavailable" }, 502);
    }
    if (!tenantId) {
      return c.json({ error: "billing is not configured for this account" }, 409);
    }
    try {
      // Optional { credits } body: the user's chosen top-up amount (validated/clamped). A missing or
      // invalid amount falls back to the default pack. Parsed leniently — the route has no content-type
      // guard (it historically took no body), and the origin guard already fronts CSRF.
      const credits = normalizeTopupCredits(((await c.req.json().catch(() => ({}))) as Record<string, unknown>).credits);
      const identity = await tenantAutumnIdentity(tenantId);
      const url = await billing.topupUrl(tenantId, identity.name, credits, identity.metadata);
      if (!url) {
        return c.json({ error: "billing is not configured" }, 409);
      }
      return c.json({ url });
    } catch (error) {
      console.warn("billing_topup_failed", {
        user: session.user.login,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "could not create checkout session" }, 502);
    }
  });

  /* ----------------------------------------------- tenant-scoped surfaces --- */
  // These make org tenants first-class. Access is gated by tenant_members: any member may READ, only
  // an 'admin' may WRITE. State-changing routes additionally carry the shared CSRF guards.

  // The set of tenants the viewer belongs to (personal first), for the tenant switcher.
  app.get("/dashboard/tenants", async (c) => {
    const session = await requireDashboardSession(c, config);
    if (!session) {
      return c.json({ tenants: [] });
    }
    return c.json({ tenants: await listViewerTenants(session.user.id, session.userId) });
  });

  app.post(
    "/dashboard/tenants",
    requireDashboardOrigin,
    requireJsonContentType,
    async (c) => {
      if (config.auth.mode === "clerk") {
        throw new ApiError(409, "Organizations are managed through Clerk");
      }
      const session = await requireDashboardSession(c, config);
      if (!session) {
        throw new ApiError(401, "dashboard authentication required");
      }
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const tenant = await createJinaOrganization({
        name: parseJinaOrganizationName(body.name),
        creatorGithubUserId: session.user.id,
        creatorGithubLogin: session.user.login,
        creatorUserId: session.userId,
      });
      return c.json({ tenant }, 201);
    },
  );

  app.patch(
    "/dashboard/tenants/:tenantId",
    requireDashboardOrigin,
    requireJsonContentType,
    async (c) => {
      if (config.auth.mode === "clerk") {
        throw new ApiError(409, "Organizations are managed through Clerk");
      }
      const session = await requireDashboardSession(c, config);
      const tenantId = tenantIdParam(c);
      await requireTenantMembership(session, tenantId, { requireAdmin: true });
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const tenant = await updateJinaOrganizationName(
        tenantId,
        parseJinaOrganizationName(body.name),
      );
      if (!tenant) {
        throw new ApiError(404, "organization not found");
      }
      return c.json({ tenant });
    },
  );

  app.get("/dashboard/tenants/:tenantId/graphs", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    const context = await tenantGraphContext(tenantId);
    const [list, overview] = await Promise.all([
      graphs.listGraphs(context),
      graphs.getWorkOverview(context, c.req.raw.signal)
        .then((workOverview) => ({ workOverview, unavailable: false }))
        .catch((error: unknown) => {
          console.warn("graph_work_overview_unavailable", {
            tenantId,
            error: error instanceof Error ? error.message : String(error),
          });
          return {
            workOverview: { board: { tasks: [], dependencies: [], outbox: [] }, events: [] },
            unavailable: true,
          };
        }),
    ]);
    return c.json({
      ...list,
      workOverview: overview.workOverview,
      workOverviewUnavailable: overview.unavailable,
    });
  });

  app.post(
    "/dashboard/tenants/:tenantId/graphs/index",
    requireDashboardOrigin,
    requireJsonContentType,
    async (c) => {
      const session = await requireDashboardSession(c, config);
      const tenantId = tenantIdParam(c);
      await requireTenantMembership(session, tenantId, { requireAdmin: true });
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const repository = typeof body.repository === "string" ? body.repository.trim() : "";
      const fullHistory = body.fullHistory === true;
      const historyLimit = parseGraphHistoryLimit(body.historyLimit);
      if (!repository) throw new ApiError(400, "repository is required");
      const context = await tenantGraphContext(tenantId, repository);
      return c.json(await graphs.buildDashboardGraph(context, {
        repository,
        snapshotFirst: !fullHistory,
        requestKey: `dashboard:${tenantId}:${randomUUID()}`,
        metadata: {
          source: "jina-dashboard",
          indexMode: fullHistory ? "full-history" : "snapshot-first",
          historyLimit,
          senderGithubUserId: session!.user.id,
          senderLogin: session!.user.login,
        },
      }), 202);
    },
  );

  // The context plane: knowledge documents, browsable as a tree. `logicalId` is
  // `kind:repository:subject`, so the client can build the folder structure
  // without a second round trip per level.
  app.get("/dashboard/tenants/:tenantId/context/repositories", async (c) => {
    const startedAt = Date.now();
    const session = await requireDashboardSession(c, config);
    const sessionMs = Date.now() - startedAt;
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    const membershipMs = Date.now() - startedAt - sessionMs;
    const context = await tenantGraphContext(tenantId);
    const repositoriesMs = Date.now() - startedAt - sessionMs - membershipMs;
    const totalMs = Date.now() - startedAt;
    c.header(
      "Server-Timing",
      `session;dur=${sessionMs}, membership;dur=${membershipMs}, repositories;dur=${repositoriesMs}, total;dur=${totalMs}`,
    );
    console.info("context_repositories_profile", {
      tenant_id: tenantId,
      repository_count: context.repositories.length,
      session_ms: sessionMs,
      membership_ms: membershipMs,
      repositories_ms: repositoriesMs,
      total_ms: totalMs,
    });
    return c.json({ repositories: context.repositories });
  });

  app.get("/dashboard/tenants/:tenantId/context/documents", async (c) => {
    const startedAt = Date.now();
    const session = await requireDashboardSession(c, config);
    const sessionMs = Date.now() - startedAt;
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    const membershipMs = Date.now() - startedAt - sessionMs;
    const repository = c.req.query("repository")?.trim();
    const ref = c.req.query("ref")?.trim();
    const context = await tenantGraphContext(tenantId, repository || undefined);
    const repositoriesMs = Date.now() - startedAt - sessionMs - membershipMs;
    const documents = await graphs.listDocuments(
      context,
      repository || undefined,
      ref || undefined,
    );
    const contextApiMs = Date.now() - startedAt - sessionMs - membershipMs - repositoriesMs;
    const totalMs = Date.now() - startedAt;
    c.header(
      "Server-Timing",
      `session;dur=${sessionMs}, membership;dur=${membershipMs}, repositories;dur=${repositoriesMs}, context-api;dur=${contextApiMs}, total;dur=${totalMs}`,
    );
    console.info("context_documents_profile", {
      tenant_id: tenantId,
      repository: repository || "all",
      ref: ref || "default",
      document_count: documents.length,
      session_ms: sessionMs,
      membership_ms: membershipMs,
      repositories_ms: repositoriesMs,
      context_api_ms: contextApiMs,
      total_ms: totalMs,
    });
    return c.json({
      documents,
      repositories: context.repositories.map((entry) => ({
        name: entry.name,
        defaultBranch: entry.defaultBranch,
      })),
    });
  });

  // Polled by the context page while a build runs, so the wiki can be watched
  // appearing instead of waiting on a spinner for ninety minutes.
  app.get("/dashboard/tenants/:tenantId/context/builds/:buildId/progress", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    const buildId = c.req.param("buildId");
    if (!buildId) throw new ApiError(400, "missing build id");
    return c.json(await graphs.contextBuildProgress(await tenantGraphContext(tenantId), buildId));
  });

  app.post(
    "/dashboard/tenants/:tenantId/context/builds/:buildId/cancel",
    requireDashboardOrigin,
    requireJsonContentType,
    async (c) => {
      const session = await requireDashboardSession(c, config);
      const tenantId = tenantIdParam(c);
      await requireTenantMembership(session, tenantId, { requireAdmin: true });
      const buildId = c.req.param("buildId");
      if (!buildId) throw new ApiError(400, "missing build id");
      return c.json(await graphs.cancelContextBuild(await tenantGraphContext(tenantId), buildId));
    },
  );

  app.get("/dashboard/tenants/:tenantId/context/builds", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    return c.json({
      builds: await graphs.listContextBuilds(await tenantGraphContext(tenantId)),
    });
  });

  app.get("/dashboard/tenants/:tenantId/context/documents/:documentId", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    const documentId = c.req.param("documentId");
    if (!documentId) throw new ApiError(400, "missing document id");
    const repository = c.req.query("repository")?.trim();
    const releaseId = c.req.query("releaseId")?.trim();
    if (!repository || !releaseId) throw new ApiError(400, "repository and releaseId are required");
    return c.json({
      document: await graphs.getDocument(await tenantGraphContext(tenantId, repository), {
        repository,
        releaseId,
        documentId,
      }),
    });
  });

  // Triggering a build from the context page. Same operation the indexing route
  // performs; named for what it does rather than for the old graph framing.
  app.post(
    "/dashboard/tenants/:tenantId/context/build",
    requireDashboardOrigin,
    requireJsonContentType,
    async (c) => {
      const session = await requireDashboardSession(c, config);
      const tenantId = tenantIdParam(c);
      await requireTenantMembership(session, tenantId, { requireAdmin: true });
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const repository = typeof body.repository === "string" ? body.repository.trim() : "";
      const fullHistory = body.fullHistory === true;
      const historyLimit = parseGraphHistoryLimit(body.historyLimit);
      if (!repository) throw new ApiError(400, "repository is required");
      const context = await tenantGraphContext(tenantId, repository);
      return c.json(
        await graphs.buildDashboardGraph(context, {
          repository,
          snapshotFirst: !fullHistory,
          requestKey: `dashboard:${tenantId}:${randomUUID()}`,
          metadata: {
            source: "jina-dashboard",
            indexMode: fullHistory ? "full-history" : "snapshot-first",
            historyLimit,
            senderGithubUserId: session!.user.id,
            senderLogin: session!.user.login,
          },
        }),
        202,
      );
    },
  );

  app.get("/dashboard/tenants/:tenantId/work-overview", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    const context = await tenantGraphContext(tenantId);
    const [legacy, relational] = await Promise.all([
      graphs.getWorkOverview(context).catch((error): DashboardWorkOverview => {
        console.warn("legacy_board_overview_unavailable", {
          tenant_id: tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
        return { board: { tasks: [], dependencies: [] }, events: [] };
      }),
      getRelationalBoardDashboardOverview(tenantId),
    ]);
    return c.json(mergeDashboardWorkOverviews(legacy, relational));
  });

  app.get("/dashboard/tenants/:tenantId/operations/task-types", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    return c.json(await graphs.listTaskTypes(await tenantGraphContext(tenantId)));
  });

  app.get("/dashboard/tenants/:tenantId/operations/causal-graph", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    const repository = requiredDashboardQuery(c, "repository");
    const ref = requiredDashboardQuery(c, "ref");
    return c.json(
      await graphs.getCausalGraph(await tenantGraphContext(tenantId, repository), {
        repository,
        ref,
      }),
    );
  });

  app.get("/dashboard/tenants/:tenantId/operations/context/releases", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    const repository = c.req.query("repository")?.trim();
    return c.json(
      await graphs.listContextReleases(
        await tenantGraphContext(tenantId, repository || undefined),
        repository || undefined,
      ),
    );
  });

  app.get("/dashboard/tenants/:tenantId/operations/context/list", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    const repository = requiredDashboardQuery(c, "repository");
    const releaseId = requiredDashboardQuery(c, "releaseId");
    return c.json(
      await graphs.listContextCatalog(await tenantGraphContext(tenantId, repository), {
        repository,
        releaseId,
      }),
    );
  });

  app.get("/dashboard/tenants/:tenantId/operations/context/read", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    const repository = requiredDashboardQuery(c, "repository");
    const releaseId = requiredDashboardQuery(c, "releaseId");
    const documentId = requiredDashboardQuery(c, "document");
    return c.json(
      await graphs.readContextCatalogDocument(await tenantGraphContext(tenantId, repository), {
        repository,
        releaseId,
        documentId,
      }),
    );
  });

  app.get("/dashboard/tenants/:tenantId/operations/context/diff", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    const repository = requiredDashboardQuery(c, "repository");
    const fromReleaseId = requiredDashboardQuery(c, "fromReleaseId");
    const toReleaseId = requiredDashboardQuery(c, "toReleaseId");
    return c.json(
      await graphs.diffContextReleases(await tenantGraphContext(tenantId, repository), {
        repository,
        fromReleaseId,
        toReleaseId,
      }),
    );
  });

  app.post(
    "/dashboard/tenants/:tenantId/operations/context/search",
    requireDashboardOrigin,
    requireJsonContentType,
    async (c) => {
      const session = await requireDashboardSession(c, config);
      const tenantId = tenantIdParam(c);
      await requireTenantMembership(session, tenantId, { requireAdmin: false });
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const repository = typeof body.repository === "string" ? body.repository.trim() : "";
      const releaseId = typeof body.releaseId === "string" ? body.releaseId.trim() : "";
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (!repository || !releaseId || !query) {
        throw new ApiError(400, "repository, releaseId, and query are required");
      }
      if (query.length > 4_000) throw new ApiError(400, "query must not exceed 4000 characters");
      return c.json(
        await graphs.searchContextCatalog(await tenantGraphContext(tenantId, repository), {
          repository,
          releaseId,
          query,
        }),
      );
    },
  );

  app.get("/dashboard/tenants/:tenantId/graphs/:graphId", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    const graphId = c.req.param("graphId");
    if (!graphId) throw new ApiError(400, "missing graph id");
    return c.json(await graphs.getGraph(await tenantGraphContext(tenantId), graphId));
  });

  app.post(
    "/dashboard/tenants/:tenantId/graph/query",
    requireDashboardOrigin,
    requireJsonContentType,
    async (c) => {
      const session = await requireDashboardSession(c, config);
      const tenantId = tenantIdParam(c);
      await requireTenantMembership(session, tenantId, { requireAdmin: false });
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const graphId = typeof body.graph_id === "string" ? body.graph_id.trim() : "";
      const repository = typeof body.repository === "string" ? body.repository.trim() : "";
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (!graphId) throw new ApiError(400, "graph_id is required");
      if (!repository) throw new ApiError(400, "repository is required");
      if (!query) throw new ApiError(400, "query is required");
      if (query.length > 4_000) throw new ApiError(400, "query must not exceed 4000 characters");
      return c.json(await graphs.queryGraph(
        await tenantGraphContext(tenantId),
        { graphId, repository, query },
      ));
    },
  );

  // Tenant OpenRouter integration: member read, admin write. Same shape/validation as the legacy route.
  app.get("/dashboard/tenants/:tenantId/integrations", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    return c.json(await getTenantIntegrations(tenantId));
  });

  app.get("/dashboard/tenants/:tenantId/github/installations", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    return c.json({ installations: await listTenantGithubConnections(tenantId) });
  });

  app.post(
    "/dashboard/tenants/:tenantId/github/installations",
    requireDashboardOrigin,
    requireJsonContentType,
    async (c) => {
      const session = await requireDashboardSession(c, config);
      const tenantId = tenantIdParam(c);
      await requireTenantMembership(session, tenantId, { requireAdmin: true });
      if (!session?.accessToken) {
        throw new ApiError(401, "GitHub authentication is required to connect an installation");
      }
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const installationId = body.installation_id;
      if (!Number.isSafeInteger(installationId) || Number(installationId) <= 0) {
        throw new ApiError(400, "installation_id must be a positive integer");
      }

      // GitHub's setup redirect parameters are untrusted. Verify both our App's
      // installation and the signed-in OAuth user's account-admin authority.
      const installation = await getInstallationForApp(Number(installationId));
      if (!installation) {
        throw new ApiError(403, "GitHub installation does not belong to this app");
      }
      const oauthAdmin = await canUserAdministerInstallation(
        session.accessToken,
        session.user.id,
        installation,
      );
      const signedWebhookInstaller = oauthAdmin
        ? false
        : await isGithubInstallationInstaller(installation.id, session.user.id);
      if (!oauthAdmin && !signedWebhookInstaller) {
        if (!await isGithubInstallationRecorded(installation.id)) {
          throw new ApiError(409, "GitHub installation is still syncing; retry shortly");
        }
        throw new ApiError(403, "GitHub account admin access is required to connect this installation");
      }
      const repositories = await listInstallationRepositories(installation.id);
      if (repositories.some((repository) => !repository.githubRepoId)) {
        throw new ApiError(502, "GitHub installation repository response omitted repository ids");
      }

      try {
        const result = await connectGithubInstallationToTenant({
          tenantId,
          installationId: installation.id,
          account: installation.account,
          repositories: repositories.map((repository) => ({
            githubRepoId: repository.githubRepoId,
            owner: repository.owner,
            name: repository.repositoryName,
            fullName: repository.name,
            defaultBranch: repository.defaultBranch,
            private: repository.private,
          })),
          movedByUserId: session.userId,
          movedByGithubUserId: session.user.id,
        });
        return c.json({
          ok: true,
          tenant_id: result.tenantId,
          installation_id: installation.id,
          moved: result.moved,
          repositories: repositories.length,
        });
      } catch (error) {
        if (error instanceof InstallationTenantMoveConflictError) {
          throw new ApiError(409, error.message);
        }
        throw error;
      }
    },
  );

  app.post(
    "/dashboard/tenants/:tenantId/integrations",
    requireDashboardOrigin,
    requireJsonContentType,
    async (c) => {
      const session = await requireDashboardSession(c, config);
      const tenantId = tenantIdParam(c);
      await requireTenantMembership(session, tenantId, { requireAdmin: true });
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      // The tenant-scoped gateway/BYOK keys live here (OpenRouter + native OpenAI/Anthropic); harness
      // fields stay on the legacy personal route (harness is individual). For each, a provided key saves
      // and an empty string disconnects; an omitted field leaves the stored key untouched.
      if (typeof body.openrouter_api_key === "string") {
        await saveTenantOpenRouterIntegration(tenantId, {
          openrouter: body.openrouter_api_key,
          openrouterSource: "manual",
          configuredByUserId: session!.user.id,
          configuredByLogin: session!.user.login,
        });
      }
      if (typeof body.openai_api_key === "string") {
        await saveTenantProviderKey(tenantId, "openai", {
          key: body.openai_api_key,
          configuredByUserId: session!.user.id,
          configuredByLogin: session!.user.login,
        });
      }
      if (typeof body.anthropic_api_key === "string") {
        await saveTenantProviderKey(tenantId, "anthropic", {
          key: body.anthropic_api_key,
          configuredByUserId: session!.user.id,
          configuredByLogin: session!.user.login,
        });
      }
      return c.json(await getTenantIntegrations(tenantId));
    },
  );

  // Tenant model settings keyed directly by tenant id: member read, admin write (same catalog validation).
  app.get("/dashboard/tenants/:tenantId/model-settings", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    return c.json(await getTenantModelSettingsById(tenantId));
  });

  app.put(
    "/dashboard/tenants/:tenantId/model-settings",
    requireDashboardOrigin,
    requireJsonContentType,
    async (c) => {
      const session = await requireDashboardSession(c, config);
      const tenantId = tenantIdParam(c);
      await requireTenantMembership(session, tenantId, { requireAdmin: true });
      const input = parseModelSettingsBody((await c.req.json().catch(() => ({}))) as unknown);
      // Any catalog model may be picked; the whole-run managed fallback (resolveRunKeys) handles a model
      // the tenant's keys can't serve at run time — no per-model disallow here.
      await validateModelSettingsSlugs(input);
      await saveTenantModelSettingsById(tenantId, input, session!.userId);
      return c.json(await getTenantModelSettingsById(tenantId));
    },
  );

  // Tenant review-trigger mode: member read, admin write. Reviews every update, the initial PR only,
  // or only an explicit @usejina command in a PR comment.
  app.get("/dashboard/tenants/:tenantId/review-trigger", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    return c.json({ mode: await getTenantReviewTriggerMode(tenantId) });
  });

  app.put(
    "/dashboard/tenants/:tenantId/review-trigger",
    requireDashboardOrigin,
    requireJsonContentType,
    async (c) => {
      const session = await requireDashboardSession(c, config);
      const tenantId = tenantIdParam(c);
      await requireTenantMembership(session, tenantId, { requireAdmin: true });
      const mode = normalizeReviewTriggerMode(((await c.req.json().catch(() => ({}))) as Record<string, unknown>).mode);
      await saveTenantReviewTriggerMode(tenantId, mode);
      return c.json({ mode: await getTenantReviewTriggerMode(tenantId) });
    },
  );

  // Tenant model-provider selection: member read, admin write. Chooses which credential the tenant's
  // runs use (managed / company OpenAI key / company OpenRouter key), decoupled from the per-stage model.
  app.get("/dashboard/tenants/:tenantId/model-provider", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    return c.json({ provider: await getTenantModelProvider(tenantId) });
  });

  app.put(
    "/dashboard/tenants/:tenantId/model-provider",
    requireDashboardOrigin,
    requireJsonContentType,
    async (c) => {
      const session = await requireDashboardSession(c, config);
      const tenantId = tenantIdParam(c);
      await requireTenantMembership(session, tenantId, { requireAdmin: true });
      const provider = normalizeModelProvider(((await c.req.json().catch(() => ({}))) as Record<string, unknown>).provider);
      await saveTenantModelProvider(tenantId, provider, session!.userId);
      return c.json({ provider: await getTenantModelProvider(tenantId) });
    },
  );

  // Tenant billing: member read (overview), admin top-up. Reuses billing.overview/topupUrl keyed by the
  // tenant uuid (the Autumn customer id). Enriched with member counts and the auto-review cap (both pure
  // store reads) alongside the Autumn-derived overview (cycle + billing_activity live inside overview()).
  app.get("/dashboard/tenants/:tenantId/billing", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    const identity = await tenantAutumnIdentity(tenantId);
    const [overview, members, policy] = await Promise.all([
      billing.overview(tenantId, identity.name, identity.metadata),
      getTenantMemberStats(tenantId),
      getTenantBillingPolicy(tenantId),
    ]);
    return c.json({
      ...overview,
      members,
      auto_review_limit: {
        enabled: policy.auto_review_limit_enabled,
        limit_credits: policy.auto_review_limit_credits,
      },
    });
  });

  // Tenant usage summary over a trailing window (member read). days validated to {7,30,90} (default 30).
  app.get("/dashboard/tenants/:tenantId/usage", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: false });
    const days = parseUsageDays(c.req.query("days"));
    return c.json(await getTenantUsageSummary(tenantId, days));
  });

  // Set the tenant's auto-review credit cap (admin write). Validated body { enabled, limit_credits }.
  app.put(
    "/dashboard/tenants/:tenantId/billing/limits",
    requireDashboardOrigin,
    requireJsonContentType,
    async (c) => {
      const session = await requireDashboardSession(c, config);
      const tenantId = tenantIdParam(c);
      await requireTenantMembership(session, tenantId, { requireAdmin: true });
      const input = parseAutoReviewLimitBody((await c.req.json().catch(() => ({}))) as unknown);
      await saveTenantAutoReviewLimit(tenantId, input);
      const policy = await getTenantBillingPolicy(tenantId);
      return c.json({
        auto_review_limit: {
          enabled: policy.auto_review_limit_enabled,
          limit_credits: policy.auto_review_limit_credits,
        },
      });
    },
  );

  // Subscribe the tenant to a plan (admin write). Returns an Autumn checkout url, mirroring topup.
  app.post(
    "/dashboard/tenants/:tenantId/billing/subscribe",
    requireDashboardOrigin,
    requireJsonContentType,
    async (c) => {
      const session = await requireDashboardSession(c, config);
      const tenantId = tenantIdParam(c);
      await requireTenantMembership(session, tenantId, { requireAdmin: true });
      const planId = parseSubscribePlanId((await c.req.json().catch(() => ({}))) as unknown);
      if (!billing.billingConfigured()) {
        return c.json({ error: "billing is not configured" }, 409);
      }
      try {
        const identity = await tenantAutumnIdentity(tenantId);
        const url = await billing.subscribeUrl(tenantId, planId, identity.name, identity.metadata);
        if (!url) {
          return c.json({ error: "billing is not configured" }, 409);
        }
        return c.json({ url });
      } catch (error) {
        console.warn("billing_subscribe_failed", {
          tenant_id: tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
        return c.json({ error: "could not create checkout session" }, 502);
      }
    },
  );

  // Configure per-customer auto-reload (auto top-up) wired to Autumn (admin write).
  app.put(
    "/dashboard/tenants/:tenantId/billing/auto-reload",
    requireDashboardOrigin,
    requireJsonContentType,
    async (c) => {
      const session = await requireDashboardSession(c, config);
      const tenantId = tenantIdParam(c);
      await requireTenantMembership(session, tenantId, { requireAdmin: true });
      const input = parseAutoReloadBody((await c.req.json().catch(() => ({}))) as unknown);
      if (!billing.billingConfigured()) {
        return c.json({ error: "billing is not configured" }, 409);
      }
      try {
        const identity = await tenantAutumnIdentity(tenantId);
        const applied = await billing.setAutoReload(tenantId, input, identity.name, identity.metadata);
        if (!applied) {
          return c.json({ error: "billing is not configured" }, 409);
        }
        return c.json({ auto_reload: input });
      } catch (error) {
        console.warn("billing_auto_reload_failed", {
          tenant_id: tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
        return c.json({ error: "could not update auto-reload" }, 502);
      }
    },
  );

  // LEGACY personal-tenant fallbacks (production fix): the dashboard falls back to these paths when
  // no tenant is selected (single/zero-tenant viewers with the switcher hidden). They resolve the
  // viewer's PERSONAL tenant and delegate to the same logic as the tenant-scoped routes above —
  // the viewer is implicitly admin of their own personal tenant, so no membership check is needed.
  app.get("/dashboard/usage", async (c) => {
    const session = await requireDashboardSession(c, config);
    const days = parseUsageDays(c.req.query("days"));
    const tenantId = session
      ? await getTenantIdForUser(session.user.id, session.userId).catch(() => undefined)
      : undefined;
    if (!tenantId) {
      return c.json({
        period: { days },
        totals: {
          runs: 0,
          completed_runs: 0,
          infra_credits: 0,
          ai_credits: 0,
          total_credits: 0,
          model_cost_usd: "0",
          byok_runs: 0,
          harness_runs: 0,
        },
        daily: [],
        recent_runs: [],
      });
    }
    return c.json(await getTenantUsageSummary(tenantId, days));
  });

  app.get("/dashboard/review-trigger", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = session ? await ensurePersonalTenantId(session.user.id, session.user.login) : undefined;
    if (!tenantId) {
      return c.json({ mode: "every_commit" });
    }
    return c.json({ mode: await getTenantReviewTriggerMode(tenantId) });
  });

  app.put("/dashboard/review-trigger", requireDashboardOrigin, requireJsonContentType, async (c) => {
    const session = await requireDashboardSession(c, config);
    if (!session) {
      return c.json({ error: "authentication required" }, 401);
    }
    const mode = normalizeReviewTriggerMode(((await c.req.json().catch(() => ({}))) as Record<string, unknown>).mode);
    const tenantId = await ensurePersonalTenantId(session.user.id, session.user.login);
    if (!tenantId) {
      return c.json({ error: "no personal tenant" }, 409);
    }
    await saveTenantReviewTriggerMode(tenantId, mode);
    return c.json({ mode: await getTenantReviewTriggerMode(tenantId) });
  });

  app.get("/dashboard/model-provider", async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = session ? await ensurePersonalTenantId(session.user.id, session.user.login) : undefined;
    if (!tenantId) {
      return c.json({ provider: "auto" });
    }
    return c.json({ provider: await getTenantModelProvider(tenantId) });
  });

  app.put("/dashboard/model-provider", requireDashboardOrigin, requireJsonContentType, async (c) => {
    const session = await requireDashboardSession(c, config);
    if (!session) {
      return c.json({ error: "authentication required" }, 401);
    }
    const provider = normalizeModelProvider(((await c.req.json().catch(() => ({}))) as Record<string, unknown>).provider);
    const tenantId = await ensurePersonalTenantId(session.user.id, session.user.login);
    if (!tenantId) {
      return c.json({ error: "no personal tenant" }, 409);
    }
    await saveTenantModelProvider(tenantId, provider, session.userId);
    return c.json({ provider: await getTenantModelProvider(tenantId) });
  });

  app.put("/dashboard/billing/limits", requireDashboardOrigin, requireJsonContentType, async (c) => {
    const session = await requireDashboardSession(c, config);
    if (!session) {
      return c.json({ error: "authentication required" }, 401);
    }
    const input = parseAutoReviewLimitBody((await c.req.json().catch(() => ({}))) as unknown);
    const tenantId = await ensurePersonalTenantId(session.user.id, session.user.login);
    if (!tenantId) {
      return c.json({ error: "no personal tenant" }, 409);
    }
    await saveTenantAutoReviewLimit(tenantId, input);
    const policy = await getTenantBillingPolicy(tenantId);
    return c.json({
      auto_review_limit: {
        enabled: policy.auto_review_limit_enabled,
        limit_credits: policy.auto_review_limit_credits,
      },
    });
  });

  app.post("/dashboard/billing/subscribe", requireDashboardOrigin, requireJsonContentType, async (c) => {
    const session = await requireDashboardSession(c, config);
    if (!session) {
      return c.json({ error: "authentication required" }, 401);
    }
    const planId = parseSubscribePlanId((await c.req.json().catch(() => ({}))) as unknown);
    if (!billing.billingConfigured()) {
      return c.json({ error: "billing is not configured" }, 409);
    }
    // Bug fix (org billing landed on personal): this legacy fallback MUST NOT mint a personal tenant and
    // attach a plan to it. Use a read-only lookup; a viewer with no existing personal tenant is directed
    // to the tenant-scoped route (they should pick the org/account explicitly). Existing personal-only
    // viewers still subscribe their real personal tenant. The customer is named by TENANT identity, not
    // the person, so a personal customer is distinguishable from that person's org customer in Autumn.
    const tenantId = await getTenantIdForUser(session.user.id, session.userId).catch(() => undefined);
    if (!tenantId) {
      return c.json({ error: "select an account to subscribe" }, 409);
    }
    try {
      const identity = await tenantAutumnIdentity(tenantId);
      const url = await billing.subscribeUrl(tenantId, planId, identity.name, identity.metadata);
      if (!url) {
        return c.json({ error: "billing is not configured" }, 409);
      }
      return c.json({ url });
    } catch (error) {
      console.warn("billing_subscribe_failed", {
        tenant_id: tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "could not start checkout" }, 502);
    }
  });

  app.put("/dashboard/billing/auto-reload", requireDashboardOrigin, requireJsonContentType, async (c) => {
    const session = await requireDashboardSession(c, config);
    if (!session) {
      return c.json({ error: "authentication required" }, 401);
    }
    const input = parseAutoReloadBody((await c.req.json().catch(() => ({}))) as unknown);
    if (!billing.billingConfigured()) {
      return c.json({ error: "billing is not configured" }, 409);
    }
    const tenantId = await ensurePersonalTenantId(session.user.id, session.user.login);
    if (!tenantId) {
      return c.json({ error: "no personal tenant" }, 409);
    }
    try {
      const identity = await tenantAutumnIdentity(tenantId);
      const applied = await billing.setAutoReload(tenantId, input, identity.name, identity.metadata);
      if (!applied) {
        return c.json({ error: "billing is not configured" }, 409);
      }
      return c.json({ auto_reload: input });
    } catch (error) {
      console.warn("billing_auto_reload_failed", {
        tenant_id: tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "could not update auto-reload" }, 502);
    }
  });

  app.post("/dashboard/tenants/:tenantId/billing/topup", requireDashboardOrigin, async (c) => {
    const session = await requireDashboardSession(c, config);
    const tenantId = tenantIdParam(c);
    await requireTenantMembership(session, tenantId, { requireAdmin: true });
    if (!billing.billingConfigured()) {
      return c.json({ error: "billing is not configured" }, 409);
    }
    try {
      const credits = normalizeTopupCredits(((await c.req.json().catch(() => ({}))) as Record<string, unknown>).credits);
      const identity = await tenantAutumnIdentity(tenantId);
      const url = await billing.topupUrl(tenantId, identity.name, credits, identity.metadata);
      if (!url) {
        return c.json({ error: "billing is not configured" }, 409);
      }
      return c.json({ url });
    } catch (error) {
      console.warn("billing_topup_failed", {
        tenant_id: tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "could not create checkout session" }, 502);
    }
  });

  app.post("/webhooks/github", async (c) => {
    const rawBody = await c.req.text();
    const response = await handleGithubWebhook({
      config,
      trigger: reviewDispatcher,
      headers: c.req.raw.headers,
      rawBody,
      billing,
    });
    try {
      await graphs.relayGithubContext(c.req.raw.headers, rawBody);
    } catch (error) {
      console.warn("context_event_relay_failed", {
        delivery_id: c.req.header("x-github-delivery"),
        error: error instanceof Error ? error.message : String(error),
      });
      // The review was already admitted. Preserve a non-2xx GitHub delivery so
      // operators can redeliver Context while accurately identifying the
      // Context admission stage as the failed dependency.
      throw new ApiError(424, "Context event relay failed");
    }

    return c.json(response);
  });

  app.post("/internal/reviews/prepare", (c) => prepareReview(c, config, billing));
  app.post("/internal/reviews/manual-runs", async (c) => {
    authorizeInternal(c, config);
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    const scopeTag = typeof body?.scope_tag === "string" ? body.scope_tag.trim() : "";
    if (!/^manual-pr:[1-9][0-9]*:[1-9][0-9]*:[1-9][0-9]*$/.test(scopeTag)) {
      throw new ApiError(400, "scope_tag is invalid");
    }
    return c.json(await listManualReviewRuns(scopeTag));
  });
  app.post("/internal/reviews/:reviewRunId/events", (c) => recordReviewEvent(c, config));
  app.post("/internal/reviews/:reviewRunId/complete", (c) => completeReview(c, config, billing));
  app.post("/internal/reviews/:reviewRunId/usage", (c) => recordReviewUsage(c, config, billing));
  app.post("/internal/graph/availability", async (c) => {
    authorizeInternal(c, config);
    const input = parseReviewGraphAvailabilityBody(await c.req.json().catch(() => undefined));
    const target = await getReviewGraphTarget(input);
    if (!target || !graphs.configured) {
      return c.json({ available: false });
    }
    const available = await graphs.hasRepositoryGraph(
      {
        tenantId: target.tenantId,
        repositories: [{ name: target.repository, defaultBranch: target.defaultBranch }],
      },
      target.repository,
    );
    return c.json({ available });
  });
  app.post("/internal/context/mcp-access", async (c) => {
    authorizeInternal(c, config);
    const input = parseReviewGraphMcpAccessBody(await c.req.json().catch(() => undefined));
    const target = await getReviewGraphTarget(input);
    if (!target || !graphs.configured) {
      return c.json({ available: false });
    }
    const available = await graphs.hasRepositoryGraph(
      {
        tenantId: target.tenantId,
        repositories: [{ name: target.repository, defaultBranch: target.defaultBranch }],
      },
      target.repository,
    );
    if (!available) return c.json({ available: false });

    const access = await graphs.createReviewMcpAccess(
      {
        tenantId: target.tenantId,
        repositories: [{ name: target.repository, defaultBranch: target.defaultBranch }],
      },
      {
        repository: target.repository,
        reviewRunId: input.reviewRunId,
      },
    );
    return c.json({
      available: true,
      mcp_url: access.mcpUrl,
      access_token: access.accessToken,
      token_type: "Bearer",
      expires_at: access.expiresAt,
    });
  });
  app.post("/internal/installations/backfill", (c) => acceptBackfill(c, config, billing));
  app.post("/internal/schedules/billing-retry", async (c) => {
    await authorizeSchedule(c, config);
    const body = await c.req.json().catch(() => ({}));
    const workflow = await admitScheduledBillingRetry(body);
    return c.json({ accepted: true, workflow_id: workflow.id, replayed: workflow.replayed }, 202);
  });
  app.post("/internal/integrations/resolve", (c) => resolveIntegrations(c, config));
  app.post("/internal/context/execution-profile", (c) => resolveContextExecutionProfile(c, config));
  app.post("/internal/billing/retry", (c) => retryBilling(c, config, billing));

  return app;
}

export function parseReviewGraphAvailabilityBody(body: unknown): {
  installationId: number;
  githubRepoId: number;
  repository: string;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "graph availability request must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  const installationId = record.installation_id;
  const githubRepoId = record.github_repository_id;
  const repository = typeof record.repository === "string" ? record.repository.trim() : "";
  if (!Number.isSafeInteger(installationId) || Number(installationId) <= 0) {
    throw new ApiError(400, "installation_id must be a positive integer");
  }
  if (!Number.isSafeInteger(githubRepoId) || Number(githubRepoId) <= 0) {
    throw new ApiError(400, "github_repository_id must be a positive integer");
  }
  if (!/^[^\s/]+\/[^\s/]+$/.test(repository)) {
    throw new ApiError(400, "repository must be an owner/name string");
  }
  return {
    installationId: Number(installationId),
    githubRepoId: Number(githubRepoId),
    repository,
  };
}

export function parseReviewGraphMcpAccessBody(body: unknown): {
  installationId: number;
  githubRepoId: number;
  repository: string;
  pullRequestNumber: number;
  reviewRunId: string;
} {
  const scope = parseReviewGraphAvailabilityBody(body);
  const record = body as Record<string, unknown>;
  const pullRequestNumber = record.pull_request_number;
  const reviewRunId = typeof record.review_run_id === "string" ? record.review_run_id.trim() : "";
  if (!Number.isSafeInteger(pullRequestNumber) || Number(pullRequestNumber) <= 0) {
    throw new ApiError(400, "pull_request_number must be a positive integer");
  }
  if (!reviewRunId || reviewRunId.length > 500) {
    throw new ApiError(400, "review_run_id is required");
  }
  return {
    ...scope,
    pullRequestNumber: Number(pullRequestNumber),
    reviewRunId,
  };
}

async function tenantGraphContext(tenantId: string, repositoryName?: string) {
  const access = await listTenantRepositoryAccess(tenantId);
  const selected = repositoryName
    ? access.find((repository) => repository.name.toLowerCase() === repositoryName.toLowerCase())
    : undefined;
  return {
    tenantId,
    ...(selected ? { installationId: selected.githubInstallationId } : {}),
    // Jina tenant membership is the workspace boundary; repository writes use
    // the selected repository's exact GitHub installation.
    repositories: access.map(({ name, defaultBranch }) => ({ name, defaultBranch })),
  };
}

function allowedDashboardProjectNames(
  session: DashboardSession | undefined,
  team: DashboardTeam | undefined,
): string[] | null {
  const allowed = sessionAccessibleNames(session);
  if (!allowed || !team) {
    return allowed;
  }
  return allowed.filter((name) => teamAllowsProject(team, name));
}

async function tenantDashboardProjects(tenantId: string): Promise<DashboardProject[]> {
  return (await knownProjects(tenantId)).map((project) => ({
    id: project.full_name,
    github_repo_id: project.github_repo_id,
    full_name: project.full_name,
    owner: project.owner,
    name: project.name,
    private: project.private,
    source: "observed",
  }));
}

function tenantDashboardTeams(
  session: DashboardSession | undefined,
  projects: DashboardProject[],
): DashboardTeam[] {
  const projectNames = new Set(projects.map((project) => project.full_name.toLowerCase()));
  return (session?.teams ?? [])
    .map((team) => ({
      ...team,
      project_full_names: team.project_full_names.filter((name) => projectNames.has(name.toLowerCase())),
    }))
    .filter((team) => team.project_full_names.length > 0);
}

/**
 * requireTenantAccess: gate a tenant-scoped route on tenant_members. The viewer must have a membership
 * row (any role) to READ; writes pass { requireAdmin: true } and additionally require 'admin'. A missing
 * session (auth disabled / not signed in) is 401; a non-member is 403; a non-admin write is 403. Throws
 * ApiError (caught by app.onError), so handlers can await it and proceed once it returns.
 */
/** Read the required :tenantId route param, 400 when absent (defensive — the route pattern supplies it). */
function tenantIdParam(c: Context): string {
  const tenantId = c.req.param("tenantId");
  if (!tenantId) {
    throw new ApiError(400, "missing tenant id");
  }
  return tenantId;
}

function requiredDashboardQuery(c: Context, name: string): string {
  const value = c.req.query(name)?.trim();
  if (!value) throw new ApiError(400, `${name} is required`);
  return value;
}

/**
 * Pure tenant-access decision (exported for testing): given the viewer's resolved role (undefined =
 * not a member) and whether the route is a write, return the 403 denial to raise, or undefined to allow.
 * A missing session is handled by the caller (401) — this only decides member vs admin vs none.
 */
export function tenantAccessDenial(
  role: TenantRole | undefined,
  requireAdmin: boolean,
): { status: 403; message: string } | undefined {
  if (!role) {
    return { status: 403, message: "tenant access required" };
  }
  if (requireAdmin && role !== "admin") {
    return { status: 403, message: "tenant admin access required" };
  }
  return undefined;
}

async function requireTenantMembership(
  session: Session | undefined,
  tenantId: string,
  opts: { requireAdmin: boolean },
): Promise<TenantRole> {
  if (!session) {
    throw new ApiError(401, "dashboard authentication required");
  }
  const role = await getTenantMembershipRole(session.user.id, tenantId, session.userId);
  const denial = tenantAccessDenial(role, opts.requireAdmin);
  if (denial) {
    throw new ApiError(denial.status, denial.message);
  }
  if (opts.requireAdmin && role === "admin") {
    const refresh = await getGithubTenantAdminRefreshRequirement(
      session.user.id,
      tenantId,
      session.userId,
    );
    if (refresh) {
      if (!session.accessToken || !refresh.account) {
        throw new ApiError(403, "fresh GitHub organization admin access is required");
      }
      const verified = await canUserAdministerInstallation(
        session.accessToken,
        session.user.id,
        { id: 0, account: refresh.account },
      );
      if (!verified) {
        throw new ApiError(403, "fresh GitHub organization admin access is required");
      }
      await refreshGithubTenantAdminMembership(session.user.id, tenantId, session.userId);
    }
  }
  return role as TenantRole;
}

function numberQuery(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The Autumn customer name + metadata for a tenant, so its Stripe/Autumn customer is labeled by the
 *  TENANT (org vs personal), not the person who happens to run checkout. Degrades to {} when the tenant
 *  identity can't be read, so billing still works (just unlabeled) rather than failing checkout. */
async function tenantAutumnIdentity(
  tenantId: string,
): Promise<{ name?: string; metadata?: Record<string, string> }> {
  const identity = await getTenantBillingIdentity(tenantId).catch(() => undefined);
  if (!identity) {
    return {};
  }
  const kind = identity.kind === "team" ? "team" : "personal";
  return {
    name: `${identity.name} (${kind})`,
    metadata: {
      jina_tenant_id: tenantId,
      jina_tenant_kind: identity.kind,
      jina_tenant_name: identity.name,
    },
  };
}

export function parseJinaOrganizationName(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "organization name is required");
  }
  if (!value.trim()) {
    throw new ApiError(400, "organization name is required");
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new ApiError(400, "organization name cannot contain control characters");
  }
  const name = value.trim().replace(/[ \t]+/g, " ");
  if (name.length > 80) {
    throw new ApiError(400, "organization name must not exceed 80 characters");
  }
  return name;
}

/** Allowed usage windows. Absent -> 30; a present value must be one of these (else 400). */
const USAGE_DAYS_ALLOWED = [7, 30, 90] as const;

export const DEFAULT_GRAPH_HISTORY_LIMIT = 500;
export const MAX_GRAPH_HISTORY_LIMIT = 10_000;

export function parseGraphHistoryLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_GRAPH_HISTORY_LIMIT;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_GRAPH_HISTORY_LIMIT) {
    throw new ApiError(400, `historyLimit must be an integer from 1 to ${MAX_GRAPH_HISTORY_LIMIT}`);
  }
  return value;
}

/** Parse+validate the ?days query for the usage endpoint. Default 30; reject anything not in {7,30,90}. */
export function parseUsageDays(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) {
    return 30;
  }
  const parsed = Number(value);
  if (!USAGE_DAYS_ALLOWED.includes(parsed as (typeof USAGE_DAYS_ALLOWED)[number])) {
    throw new ApiError(400, "days must be one of 7, 30, 90");
  }
  return parsed;
}

/** The plans a tenant may self-subscribe to. Enterprise/custom plans are attached by ops, not here. */
export const SUBSCRIBE_PLAN_IDS = ["startup", "growth"] as const;

/** Validate the subscribe body's plan_id against the static allowlist. Throws ApiError(400) otherwise. */
export function parseSubscribePlanId(body: unknown): (typeof SUBSCRIBE_PLAN_IDS)[number] {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const planId = record.plan_id;
  if (typeof planId !== "string" || !SUBSCRIBE_PLAN_IDS.includes(planId as (typeof SUBSCRIBE_PLAN_IDS)[number])) {
    throw new ApiError(400, `plan_id must be one of ${SUBSCRIBE_PLAN_IDS.join(", ")}`);
  }
  return planId as (typeof SUBSCRIBE_PLAN_IDS)[number];
}

/**
 * Validate the auto-review-limit body { enabled: boolean, limit_credits: number|null }. enabled must be a
 * boolean; limit_credits must be a non-negative safe integer OR null. When enabled is true a non-null
 * limit is required (an enabled cap with no number is meaningless). Throws ApiError(400) on any violation.
 */
export function parseAutoReviewLimitBody(body: unknown): { enabled: boolean; limit_credits: number | null } {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if (typeof record.enabled !== "boolean") {
    throw new ApiError(400, "enabled must be a boolean");
  }
  const rawLimit = record.limit_credits;
  let limit_credits: number | null;
  if (rawLimit === null || rawLimit === undefined) {
    limit_credits = null;
  } else if (typeof rawLimit === "number" && Number.isSafeInteger(rawLimit) && rawLimit >= 0) {
    limit_credits = rawLimit;
  } else {
    throw new ApiError(400, "limit_credits must be a non-negative integer or null");
  }
  if (record.enabled === true && limit_credits === null) {
    throw new ApiError(400, "limit_credits is required when the cap is enabled");
  }
  return { enabled: record.enabled, limit_credits };
}

/**
 * Validate the auto-reload body { enabled, threshold_credits, reload_credits }. enabled must be a
 * boolean; the two credit amounts must be non-negative safe integers. When enabling, reload_credits must
 * be positive (a zero-unit reload is meaningless). Throws ApiError(400) on any violation.
 */
export function parseAutoReloadBody(body: unknown): { enabled: boolean; thresholdCredits: number; reloadCredits: number } {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if (typeof record.enabled !== "boolean") {
    throw new ApiError(400, "enabled must be a boolean");
  }
  const thresholdCredits = nonNegativeIntField(record.threshold_credits, "threshold_credits");
  const reloadCredits = nonNegativeIntField(record.reload_credits, "reload_credits");
  if (record.enabled === true && reloadCredits <= 0) {
    throw new ApiError(400, "reload_credits must be positive when auto-reload is enabled");
  }
  return { enabled: record.enabled, thresholdCredits, reloadCredits };
}

function nonNegativeIntField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(400, `${field} must be a non-negative integer`);
  }
  return value;
}
