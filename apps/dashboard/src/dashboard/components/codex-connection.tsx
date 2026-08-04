"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl, safeHref } from "../lib/api";
import { Badge } from "./ui";
import { formatDate } from "../lib/presentation";
import {
  CODEX_CLIENT_ID,
  CODEX_SECURITY_SETTINGS_URL,
  CODEX_VERIFY_URL,
  DEVICE_ENDPOINTS,
  assembleAuthJson,
  boundedInterval,
  classifyPollStatus,
  decodeAccountId,
  handshakeErrorMessage,
  parseCodeSuccess,
  parseOAuthTokens,
  parseUsercodeResponse,
  type StoredCodexDeviceFlow,
} from "../lib/codex-device-flow";
import {
  clearCodexDeviceFlow,
  createCodexFlowId,
  loadCodexDeviceFlow,
  reportCodexConnectEvent,
  saveCodexDeviceFlow,
} from "../lib/codex-connect-session";
import {
  COPY_CONFIRM_MS,
  codexConnectionAccepted,
  codexModalCanDismiss,
  connectedLabel,
  handshakeErrorAction,
} from "../lib/codex-connect";
import { normalizeCodexHarnessInfo, precheckCodexAuth, type CodexHarnessInfo } from "../lib/codex-harness";
import { useTenant, useTenantFence } from "../providers";

function CloseGlyph() {
  return (
    <svg className="codex-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function CopyGlyph() {
  return (
    <svg className="codex-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function CheckSmallGlyph() {
  return (
    <svg className="codex-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-6.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CodexConnection({
  info,
  onChanged,
  openRequest = 0,
}: {
  info: CodexHarnessInfo;
  onChanged: (next: CodexHarnessInfo) => void;
  openRequest?: number;
}) {
  // The connect experience lives in a centered modal (capy-style). The card only opens it.
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [freshReconnect, setFreshReconnect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { selected } = useTenant();
  const isCurrentTenant = useTenantFence();

  useEffect(() => {
    if (openRequest <= 0) return;
    setModalOpen(true);
    setError(null);
    setMessage(null);
  }, [openRequest]);

  // Only an actual tenant change invalidates a pending credential action. `useTenantFence` changes
  // identity during harmless viewer/session refreshes (including returning from another browser
  // tab), so depending on it here used to make the modal disappear mid-sign-in.
  const previousTenantId = useRef(selected?.tenantId ?? null);
  useEffect(() => {
    const nextTenantId = selected?.tenantId ?? null;
    if (previousTenantId.current === nextTenantId) return;
    previousTenantId.current = nextTenantId;
    setModalOpen(false);
    setBusy(null);
    setConfirmDisconnect(false);
    setFreshReconnect(false);
    setError(null);
    setMessage(null);
  }, [selected?.tenantId]);

  const cancelDeviceSignIn = () => {
    const tenantId = selected?.tenantId;
    const flow = tenantId ? loadCodexDeviceFlow(tenantId) : null;
    if (flow) {
      reportCodexConnectEvent({
        event: "flow_cancelled",
        flow_id: flow.flowId,
        stage: "ui",
        reason: "user_cancelled",
        elapsed_ms: Math.max(0, Date.now() - flow.startedAtMs),
      });
      clearCodexDeviceFlow(flow.flowId);
    }
    setModalOpen(false);
    setFreshReconnect(false);
    setError(null);
  };

  // Success handler for either connect path (device or manual): mark connected. The modal
  // stays open and flips to its in-place connected state (capy transitions in place); the
  // card underneath is now connected too, so closing the modal reveals the connected card.
  const markConnected = useCallback((next: CodexHarnessInfo) => {
    onChanged(next);
    setFreshReconnect(false);
    setError(null);
    setMessage("Connected");
  }, [onChanged]);

  /**
   * A reconnect is a clean replacement, not an update layered over the rejected credential. This
   * deliberately mirrors the manual disconnect + connect sequence that proved reliable in
   * production, while keeping it behind one user action.
   */
  const beginReconnect = async () => {
    const requestTenantId = selected?.tenantId ?? null;
    setBusy("connect");
    setError(null);
    setMessage("Preparing a fresh Codex sign-in…");
    const existing = selected?.tenantId ? loadCodexDeviceFlow(selected.tenantId) : null;
    if (existing) clearCodexDeviceFlow(existing.flowId);
    try {
      const response = await fetch(apiUrl("/dashboard/integrations"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ codex_harness_auth: "" }),
      });
      if (!response.ok) throw new Error(`Reset failed (${response.status})`);
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!isCurrentTenant(requestTenantId)) return;
      onChanged(normalizeCodexHarnessInfo(data.codex_harness));
      setFreshReconnect(true);
      setMessage(null);
      setModalOpen(true);
    } catch (resetError) {
      if (!isCurrentTenant(requestTenantId)) return;
      setMessage(resetError instanceof Error ? resetError.message : "Could not reset the Codex connection");
    } finally {
      if (isCurrentTenant(requestTenantId)) setBusy(null);
    }
  };

  const post = async (value: string, mode: "connect" | "disconnect") => {
    const requestTenantId = selected?.tenantId ?? null;
    // Give instant, local feedback before the API roundtrip on connect.
    if (mode === "connect") {
      const check = precheckCodexAuth(value);
      if (!check.ok) {
        setError(check.reason);
        setMessage(null);
        return;
      }
    }
    setBusy(mode);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(apiUrl("/dashboard/integrations"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ codex_harness_auth: value }),
      });
      if (response.status === 400) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "That auth.json wasn't accepted.");
      }
      if (!response.ok) throw new Error(`Save failed (${response.status})`);
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!isCurrentTenant(requestTenantId)) return;
      onChanged(normalizeCodexHarnessInfo(data.codex_harness));
      setConfirmDisconnect(false);
      setMessage(mode === "disconnect" ? "Disconnected" : "Connected");
      // Disconnecting empties the connection — leave the modal (nothing left to show there).
      if (mode === "disconnect") setModalOpen(false);
    } catch (postError) {
      if (!isCurrentTenant(requestTenantId)) return;
      setError(postError instanceof Error ? postError.message : "Save failed");
    } finally {
      if (isCurrentTenant(requestTenantId)) setBusy(null);
    }
  };

  return (
    <div className="harness-connect">
      <div className="harness-connect__row">
        {info.configured ? (
          <>
            {info.reconnect_required ? (
              <>
                <Badge tone="bad">Reconnect required</Badge>
                <span className="cell-meta">OpenAI rejected the saved sign-in.</span>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => void beginReconnect()}
                  disabled={busy !== null}
                >
                  {busy === "connect" ? "Preparing…" : "Reconnect"}
                </button>
              </>
            ) : (
              <>
                <Badge tone="ok">Connected</Badge>
                <span className="cell-meta">
                  {info.connected_at ? `Connected ${formatDate(info.connected_at)}` : "Connected"}
                </span>
              </>
            )}
            {confirmDisconnect ? (
              <span className="sub-card__actions">
                <button type="button" className="btn btn--sm" onClick={() => void post("", "disconnect")} disabled={busy !== null}>
                  {busy === "disconnect" ? "Disconnecting…" : "Are you sure?"}
                </button>
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirmDisconnect(false)} disabled={busy !== null}>
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirmDisconnect(true)} disabled={busy !== null}>
                Disconnect
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => {
              setModalOpen(true);
              setError(null);
              setMessage(null);
            }}
          >
            Connect
          </button>
        )}
        {message && !modalOpen ? <span className="cell-meta">{message}</span> : null}
      </div>

      {modalOpen ? (
        <CodexConnectModal
          info={info}
          busy={busy}
          error={error}
          freshReconnect={freshReconnect}
          onConnected={markConnected}
          onManualConnect={(value) => void post(value, "connect")}
          onDisconnect={() => void post("", "disconnect")}
          onCancel={cancelDeviceSignIn}
          onClose={() => {
            setModalOpen(false);
            setFreshReconnect(false);
            setError(null);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Centered modal (capy "Connect Codex" replica) that hosts the device-code handshake. A dimmed
 * backdrop covers the page; the dialog is centered. An active sign-in is intentionally not
 * dismissible by backdrop click or Escape — cancellation is an explicit action. The
 * body is either the numbered device-code steps + manual fallback (not yet connected) or an
 * in-place connected success state — the transition happens without leaving the modal.
 */
function CodexConnectModal({
  info,
  busy,
  error,
  freshReconnect,
  onConnected,
  onManualConnect,
  onDisconnect,
  onCancel,
  onClose,
}: {
  info: CodexHarnessInfo;
  busy: "connect" | "disconnect" | null;
  error: string | null;
  freshReconnect: boolean;
  onConnected: (info: CodexHarnessInfo) => void;
  onManualConnect: (auth: string) => void;
  onDisconnect: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const reconnecting = freshReconnect || (info.configured && info.reconnect_required);
  const connected = codexModalCanDismiss(info.configured, info.reconnect_required === true);

  return (
    <div className="codex-modal" role="dialog" aria-modal="true" aria-labelledby="codex-modal-title">
      <div className="codex-modal__backdrop" aria-hidden="true" />
      <div className="codex-modal__dialog">
        {connected ? (
          <button type="button" className="codex-modal__close" aria-label="Close" onClick={onClose}>
            <CloseGlyph />
          </button>
        ) : null}
        <div className="codex-modal__head">
          <h2 id="codex-modal-title" className="codex-modal__title">
            {reconnecting ? "Reconnect Codex" : "Connect Codex"}
          </h2>
          <p className="codex-modal__subtitle">Route OpenAI models through your ChatGPT subscription</p>
        </div>
        <div className="codex-modal__body">
          {connected ? (
            <CodexConnectedPanel info={info} busy={busy} onDisconnect={onDisconnect} />
          ) : (
            <>
              {reconnecting ? (
                <div className="notice notice--bad">
                  Your saved Codex sign-in expired. Sign in again to resume reviews on your ChatGPT subscription.
                </div>
              ) : null}
              {/* Primary path: integrated device-code flow — no local `codex login` needed. */}
              <CodexDeviceFlow onConnected={onConnected} />

              {/* Fallback for users whose org blocks device auth, or who prefer to paste credentials. */}
              <CodexManualFallback busy={busy} error={error} onConnect={onManualConnect} />

              <p className="codex-modal__note cell-meta">
                Connecting uses your ChatGPT subscription for reviews of PRs you author. This is an unofficial
                integration and may stop working if OpenAI changes their auth.
              </p>
              <div className="codex-modal__footer">
                <button type="button" className="btn btn--sm btn--ghost" onClick={onCancel}>
                  Cancel sign-in
                </button>
                <span className="cell-meta">You can safely switch tabs while this stays open.</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** In-place connected success state shown inside the modal after a successful handshake. */
function CodexConnectedPanel({
  info,
  busy,
  onDisconnect,
}: {
  info: CodexHarnessInfo;
  busy: "connect" | "disconnect" | null;
  onDisconnect: () => void;
}) {
  const label = connectedLabel(info.connected_at ? formatDate(info.connected_at) : null);
  return (
    <div className="codex-connected">
      <span className="codex-connected__check" aria-hidden="true">
        <CheckSmallGlyph />
      </span>
      <div className="codex-connected__label">{label}</div>
      <button
        type="button"
        className="btn btn--sm btn--ghost"
        onClick={onDisconnect}
        disabled={busy !== null}
      >
        {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
      </button>
    </div>
  );
}

/** Collapsed, secondary "paste credentials manually" fallback shown under the device steps. */
function CodexManualFallback({
  busy,
  error,
  onConnect,
}: {
  busy: "connect" | "disconnect" | null;
  error: string | null;
  onConnect: (auth: string) => void;
}) {
  const [showManual, setShowManual] = useState(false);
  const [auth, setAuth] = useState("");
  const precheck = precheckCodexAuth(auth);

  return (
    <div className="codex-fallback">
      <button
        type="button"
        className="codex-fallback__toggle"
        aria-expanded={showManual}
        onClick={() => setShowManual((prev) => !prev)}
      >
        {showManual ? "Hide manual credentials" : "Paste credentials manually instead"}
      </button>
      {showManual ? (
        <div className="codex-fallback__body">
          <p className="sub-card__hint">
            Run <code>codex login</code> on your machine and sign in with ChatGPT, then paste the contents of{" "}
            <code>~/.codex/auth.json</code> below.
          </p>
          <label className="form-field form-field--wide">
            <span className="form-field__label">auth.json contents</span>
            <textarea
              className="textarea"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              rows={6}
              placeholder={'{ "tokens": { … } }'}
              value={auth}
              onChange={(event) => setAuth(event.target.value)}
            />
          </label>
          <p className="cell-meta">
            This content contains sign-in tokens for your ChatGPT account. It is stored encrypted and never shown
            again.
          </p>
          {error ? <span className="error-text">{error}</span> : null}
          <div className="sub-card__actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => onConnect(auth.trim())}
              disabled={busy !== null || !precheck.ok}
            >
              {busy === "connect" ? "Connecting…" : "Connect"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Browser-side Codex device-code connect flow.
 *
 * The ENTIRE OpenAI device handshake runs here in the user's browser: auth.openai.com answers our
 * cross-origin requests with `access-control-allow-origin: *`, whereas our server's POSTs are blocked
 * by Cloudflare's TLS-fingerprint challenge. On mount it fetches a user_code directly from OpenAI,
 * shows the numbered steps + a copy button, polls the token endpoint at the returned interval, then
 * (on approval) exchanges the code for tokens, assembles auth.json, and POSTs ONLY that blob to our
 * existing encrypted /dashboard/integrations endpoint. No token material touches our server until
 * the final assembled auth.json.
 */
type DeviceFlowState =
  | { phase: "starting" }
  | { phase: "waiting"; flow: StoredCodexDeviceFlow }
  | { phase: "error"; reason: string; message: string };

/** Build the error phase from a handshake reason, resolving its user-facing message once. */
function deviceError(reason: string): DeviceFlowState {
  return { phase: "error", reason, message: handshakeErrorMessage(reason) };
}

// OpenAI caps the whole device login at 15 minutes.
const CODEX_FLOW_TTL_MS = 15 * 60 * 1000;

// How long an unbroken run of "not approved yet" is allowed before the likely cause is named.
// Long enough to cover reading the steps, switching tab, and signing in; far short of the expiry,
// which is the only other feedback the flow would otherwise ever give.
const CODEX_STALL_HINT_MS = 90 * 1000;

/** POST form-urlencoded to OpenAI. Body triggers a CORS preflight which OpenAI answers. */
async function openaiJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function CodexDeviceFlow({ onConnected }: { onConnected: (info: CodexHarnessInfo) => void }) {
  const [state, setState] = useState<DeviceFlowState>({ phase: "starting" });
  const [stalled, setStalled] = useState(false);
  const [copied, setCopied] = useState(false);
  const activeRef = useRef(true);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { selected } = useTenant();
  const currentFence = useTenantFence();
  const currentFenceRef = useRef(currentFence);
  currentFenceRef.current = currentFence;
  const requestTenantId = useRef<string | null>(null);
  const selectedTenantId = selected?.tenantId ?? null;

  const report = useCallback((flow: Pick<StoredCodexDeviceFlow, "flowId" | "startedAtMs">, event: Omit<Parameters<typeof reportCodexConnectEvent>[0], "flow_id" | "elapsed_ms">) => {
    reportCodexConnectEvent({
      ...event,
      flow_id: flow.flowId,
      elapsed_ms: Math.max(0, Date.now() - flow.startedAtMs),
    });
  }, []);

  const fail = useCallback((
    flow: Pick<StoredCodexDeviceFlow, "flowId" | "startedAtMs">,
    reason: string,
    stage: "ui" | "start" | "poll" | "exchange" | "save",
    details: { http_status?: number; attempt?: number } = {},
  ) => {
    clearCodexDeviceFlow(flow.flowId);
    report(flow, { event: "flow_failed", stage, reason, ...details });
    if (activeRef.current) setState(deviceError(reason));
  }, [report]);

  const start = useCallback(async () => {
    if (!selectedTenantId) {
      setState(deviceError("no_tenant"));
      return;
    }
    const existing = loadCodexDeviceFlow(selectedTenantId);
    if (existing) clearCodexDeviceFlow(existing.flowId);
    const pendingFlow = { flowId: createCodexFlowId(), startedAtMs: Date.now() };
    requestTenantId.current = selectedTenantId;
    setStalled(false);
    setState({ phase: "starting" });
    report(pendingFlow, { event: "flow_started", stage: "start" });
    try {
      const response = await openaiJson(DEVICE_ENDPOINTS.usercode, { client_id: CODEX_CLIENT_ID });
      if (!response.ok) {
        fail(pendingFlow, "start_http_error", "start", { http_status: response.status });
        return;
      }
      const parsed = parseUsercodeResponse(await response.json().catch(() => null));
      if (!parsed) {
        fail(pendingFlow, "start_invalid_response", "start");
        return;
      }
      if (!activeRef.current) return;
      const flow: StoredCodexDeviceFlow = {
        version: 1,
        flowId: pendingFlow.flowId,
        tenantId: selectedTenantId,
        startedAtMs: pendingFlow.startedAtMs,
        start: parsed,
      };
      saveCodexDeviceFlow(flow);
      report(flow, { event: "user_code_received", stage: "start", http_status: response.status });
      setState({ phase: "waiting", flow });
    } catch {
      fail(pendingFlow, "openai_unreachable", "start");
    }
  }, [fail, report, selectedTenantId]);

  // Resume a still-valid device flow after an explicit close/reopen or same-tab navigation. This
  // avoids minting a different code while the user is approving the one already on screen.
  useEffect(() => {
    activeRef.current = true;
    if (!selectedTenantId) {
      setState(deviceError("no_tenant"));
    } else {
      requestTenantId.current = selectedTenantId;
      const stored = loadCodexDeviceFlow(selectedTenantId);
      if (stored) {
        report(stored, { event: "flow_resumed", stage: "ui" });
        setState({ phase: "waiting", flow: stored });
      } else {
        void start();
      }
    }
    return () => {
      activeRef.current = false;
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, [report, selectedTenantId, start]);

  // Poll OpenAI while waiting for the user to approve the code. A single self-scheduling chain
  // (setTimeout at the server interval); 403/404 = pending (keep polling), 200 = run the exchange +
  // persist, other statuses end the chain with an error. Times out at the 15-minute TTL.
  useEffect(() => {
    if (state.phase !== "waiting") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Consecutive fetch THROWS (TypeError = CORS/network/Cloudflare challenge, distinct from an
    // app-level 403 "pending" which resolves normally). A run of these means the browser genuinely
    // can't reach OpenAI's approval service — surface it instead of spinning as fake-pending forever.
    let hardFailures = 0;
    const MAX_HARD_FAILURES = 6;
    const { flow } = state;
    const { deviceAuthId, userCode, intervalSeconds, expiresAtMs } = flow.start;
    const delayMs = boundedInterval(intervalSeconds) * 1000;
    const deadline = Math.min(flow.startedAtMs + CODEX_FLOW_TTL_MS, expiresAtMs ?? Number.POSITIVE_INFINITY);
    let attempt = 0;

    const onVisibilityChange = () => {
      report(flow, {
        event: "visibility_changed",
        stage: "ui",
        visibility: document.visibilityState === "hidden" ? "hidden" : "visible",
      });
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    // Approved: exchange the authorization code for tokens, assemble auth.json, persist it.
    const finish = async (code: { authorizationCode: string; codeVerifier: string }) => {
      let authJson: string;
      try {
        const form = new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CODEX_CLIENT_ID,
          code: code.authorizationCode,
          code_verifier: code.codeVerifier,
          redirect_uri: DEVICE_ENDPOINTS.redirectUri,
        });
        const tokenResponse = await fetch(DEVICE_ENDPOINTS.oauthToken, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        });
        if (!tokenResponse.ok) {
          fail(flow, "exchange_http_error", "exchange", { http_status: tokenResponse.status, attempt });
          return;
        }
        const tokens = parseOAuthTokens(await tokenResponse.json().catch(() => null));
        if (!tokens) {
          fail(flow, "exchange_invalid_response", "exchange", { attempt });
          return;
        }
        const accountId = decodeAccountId(tokens.idToken);
        authJson = assembleAuthJson({ ...tokens, accountId });
        report(flow, { event: "token_exchange_succeeded", stage: "exchange", http_status: tokenResponse.status, attempt });
      } catch {
        if (!cancelled) fail(flow, "exchange_unreachable", "exchange", { attempt });
        return;
      }
      // Persist via our EXISTING encrypted harness endpoint — the only server touchpoint.
      // A fence rejection here means OpenAI accepted the sign-in but the tenant it was for is no
      // longer the selected one, so the credential is deliberately not written. Say so: silently
      // dropping a completed authorization leaves the spinner running with nothing to explain it.
      try {
        if (cancelled) return;
        if (!currentFenceRef.current(requestTenantId.current)) {
          fail(flow, "tenant_changed", "save", { attempt });
          return;
        }
        report(flow, { event: "credential_save_started", stage: "save", attempt });
        const saved = await fetch(apiUrl("/dashboard/integrations"), {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ codex_harness_auth: authJson, codex_harness_flow_id: flow.flowId }),
        });
        if (!saved.ok) {
          fail(flow, "save_http_error", "save", { http_status: saved.status, attempt });
          return;
        }
        const savedBody = (await saved.json().catch(() => null)) as Record<string, unknown> | null;
        const savedInfo = normalizeCodexHarnessInfo(savedBody?.codex_harness);
        if (!codexConnectionAccepted(savedInfo.configured, savedInfo.reconnect_required === true)) {
          fail(flow, "save_not_effective", "save", { http_status: saved.status, attempt });
          return;
        }
        clearCodexDeviceFlow(flow.flowId);
        report(flow, { event: "credential_save_succeeded", stage: "save", http_status: saved.status, attempt });
        if (!cancelled && currentFenceRef.current(requestTenantId.current)) onConnected(savedInfo);
      } catch {
        if (!cancelled) fail(flow, "save_unreachable", "save", { attempt });
      }
    };

    const poll = async () => {
      if (cancelled) return;
      if (Date.now() >= deadline) {
        fail(flow, "expired", "poll", { attempt });
        return;
      }
      attempt += 1;
      let status: "success" | "pending" | "error" = "pending";
      let code: { authorizationCode: string; codeVerifier: string } | null = null;
      let httpStatus: number | undefined;
      try {
        const response = await openaiJson(DEVICE_ENDPOINTS.token, {
          device_auth_id: deviceAuthId,
          user_code: userCode,
        });
        httpStatus = response.status;
        status = classifyPollStatus(response.status);
        hardFailures = 0; // a real HTTP response (even a 403-pending) means we CAN reach OpenAI
        if (status === "success") {
          code = parseCodeSuccess(await response.json().catch(() => null));
          if (!code) status = "error";
        }
      } catch {
        // A THROW is CORS/network/Cloudflare-challenge, not app-level pending. Tolerate a few
        // (transient), but a sustained run means the browser can't reach auth.openai.com at all.
        hardFailures += 1;
        if (hardFailures >= MAX_HARD_FAILURES) {
          if (!cancelled) fail(flow, "openai_unreachable", "poll", { attempt });
          return;
        }
        status = "pending";
      }
      if (cancelled) return;
      if (status === "success" && code) {
        report(flow, { event: "authorization_approved", stage: "poll", attempt });
        await finish(code);
        return;
      }
      if (status === "error") {
        fail(flow, "poll_http_error", "poll", { attempt, ...(httpStatus ? { http_status: httpStatus } : {}) });
        return;
      }
      timer = setTimeout(() => void poll(), delayMs);
    };

    timer = setTimeout(() => void poll(), delayMs);
    const stallTimer = setTimeout(() => setStalled(true), CODEX_STALL_HINT_MS);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer) clearTimeout(timer);
      clearTimeout(stallTimer);
    };
  }, [fail, onConnected, report, state]);

  const copyCode = (code: string) => {
    const done = () => {
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), COPY_CONFIRM_MS);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(done).catch(done);
    } else {
      done();
    }
  };

  if (state.phase === "error") {
    // Expired codes can't be retried as-is — the button reads "Generate a new code"; every other
    // failure is a plain "Try again". Both simply restart the handshake.
    const action = handshakeErrorAction(state.reason);
    return (
      <div className="codex-device">
        <p className="notice notice--bad">{state.message}</p>
        <div className="sub-card__actions">
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void start()}>
            {action.label}
          </button>
        </div>
      </div>
    );
  }

  if (state.phase === "starting") {
    return (
      <div className="codex-device">
        <span className="codex-device__waiting">
          <span className="codex-spinner" aria-hidden="true" />
          Starting secure sign-in…
        </span>
      </div>
    );
  }

  const { flow } = state;
  const info = flow.start;
  const settingsHref = safeHref(CODEX_SECURITY_SETTINGS_URL);
  const verifyHref = safeHref(CODEX_VERIFY_URL);

  return (
    <div className="codex-device">
      <ol className="codex-steps">
        <li className="codex-step">
          <div className="codex-step__body">
            <span className="codex-step__text">Enable device code authorization in your security settings:</span>
            {settingsHref ? (
              <a className="btn btn--sm btn--ghost codex-step__action" href={settingsHref} target="_blank" rel="noreferrer">
                Security settings ↗
              </a>
            ) : null}
          </div>
        </li>
        <li className="codex-step">
          <div className="codex-step__body">
            <span className="codex-step__text">Copy this code:</span>
            <div className="codex-code-box">
              <code className="codex-code-box__value">{info.userCode}</code>
              <button
                type="button"
                className="codex-copy"
                aria-label={copied ? "Copied" : "Copy code"}
                onClick={() => copyCode(info.userCode)}
              >
                {copied ? <CheckSmallGlyph /> : <CopyGlyph />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        </li>
        <li className="codex-step">
          <div className="codex-step__body">
            <span className="codex-step__text">Open the verification page and paste the code:</span>
            {verifyHref ? (
              <a
                className="btn btn--sm btn--ghost codex-step__action"
                href={verifyHref}
                target="_blank"
                rel="noreferrer"
                onClick={() => report(flow, { event: "verification_opened", stage: "ui" })}
              >
                Verification page ↗
              </a>
            ) : null}
          </div>
        </li>
      </ol>
      <div className="codex-device__waiting">
        <span className="codex-spinner" aria-hidden="true" />
        Waiting for authentication…
      </div>
      {/* OpenAI returns the same "not yet" response whether approval is pending or can never
          arrive, so a long silence is the only signal that the account setting is off. Say so
          rather than spinning to the 15-minute expiry with nothing to act on. Signing in still
          appears to succeed in that case: the ChatGPT session is created, only the device
          approval is not. */}
      {stalled ? (
        <div className="notice notice--bad codex-device__stalled" role="status">
          No approval seen yet. If you already entered the code and ChatGPT said you were signed
          in, <strong>Device code authorization for Codex</strong> is probably off — the session
          signs in but the approval never reaches us.
          {settingsHref ? (
            <>
              {" "}
              Turn it on in{" "}
              <a href={settingsHref} target="_blank" rel="noreferrer">
                ChatGPT security settings
              </a>
              , then start over. On a managed workspace an admin has to enable it for you.
            </>
          ) : null}
        </div>
      ) : null}
      <p className="codex-device__note cell-meta">
        Still spinning? Enable <strong>Device code authorization for Codex</strong> in your ChatGPT
        security settings <em>first</em> (step 1), then enter the code on the verification page —
        approval silently fails if that setting is off.
      </p>
    </div>
  );
}
