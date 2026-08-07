import { apiUrl } from "./api";
import {
  parseStoredCodexDeviceFlow,
  type CodexConnectTelemetryEvent,
  type StoredCodexDeviceFlow,
} from "./codex-device-flow";

const STORAGE_KEY = "jina.codex.device-flow.v1";

export function createCodexFlowId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `flow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export function loadCodexDeviceFlow(tenantId: string): StoredCodexDeviceFlow | null {
  try {
    return parseStoredCodexDeviceFlow(window.sessionStorage.getItem(STORAGE_KEY), tenantId);
  } catch {
    return null;
  }
}

export function saveCodexDeviceFlow(flow: StoredCodexDeviceFlow): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(flow));
  } catch {
    // Storage can be disabled. The live in-memory flow still works.
  }
}

export function clearCodexDeviceFlow(flowId?: string): void {
  try {
    if (flowId) {
      const current = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "null") as { flowId?: unknown } | null;
      if (current?.flowId !== flowId) return;
    }
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best effort only.
  }
}

/** Fire-and-forget, privacy-safe telemetry. The API independently re-validates every field. */
export function reportCodexConnectEvent(event: CodexConnectTelemetryEvent): void {
  void fetch(apiUrl("/dashboard/integrations/codex/events"), {
    method: "POST",
    credentials: "include",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  }).catch(() => undefined);
}
