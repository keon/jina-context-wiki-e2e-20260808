import { logger } from "./logger.js";

/** Thrown by the internal-API helpers on a non-2xx response. Carries the HTTP
 *  `status` so callers can branch on it (e.g. a 402 billing block) instead of
 *  treating every failure as a generic, retryable infrastructure error. */
export class InternalApiError extends Error {
  readonly status: number;
  readonly response: unknown;

  constructor(path: string, status: number, preview: string, response?: unknown) {
    super(`API ${path} returned ${status}: ${preview}`);
    this.name = "InternalApiError";
    this.status = status;
    this.response = response;
  }
}

export async function postInternal<TResponse = JsonValue>(path: string, body: unknown): Promise<TResponse> {
  const apiBaseUrl = requiredEnv("API_BASE_URL", process.env.JINA_API_URL).replace(/\/$/, "");
  const internalToken = requiredEnv("JINA_PRODUCT_INTERNAL_API_TOKEN", process.env.INTERNAL_API_TOKEN);
  const startedAt = Date.now();

  try {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const text = await response.text();
    const durationMs = Date.now() - startedAt;
    const parsed = parseJsonOrText(text);
    if (!response.ok) {
      logger.warn(
        "internal_api_post_failed",
        internalApiLogPayload({
          path,
          status: response.status,
          durationMs,
          response: parsed
        })
      );
      throw new InternalApiError(path, response.status, safeLogPreview(parsed), parsed);
    }

    logger.info(
      "internal_api_post_completed",
      internalApiLogPayload({
        path,
        status: response.status,
        durationMs,
        response: parsed
      })
    );
    return parsed as TResponse;
  } catch (error) {
    if (error instanceof InternalApiError) {
      throw error;
    }
    logger.warn(
      "internal_api_post_failed",
      internalApiLogPayload({
        path,
        durationMs: Date.now() - startedAt,
        error
      })
    );
    throw error;
  }
}

export function internalApiLogPayload(input: {
  path: string;
  status?: number;
  durationMs: number;
  response?: unknown;
  error?: unknown;
}): Record<string, unknown> {
  return {
    path: input.path,
    status: input.status,
    duration_ms: input.durationMs,
    success: input.error === undefined && input.status !== undefined && input.status >= 200 && input.status < 300,
    response_preview: input.response === undefined ? undefined : safeLogPreview(input.response),
    error_preview: input.error === undefined ? undefined : safeLogPreview(errorPreviewValue(input.error))
  };
}

export function safeLogPreview(value: unknown, maxLength = 500): string {
  const sanitized = sanitizeForLog(value);
  const serialized = typeof sanitized === "string" ? sanitized : (JSON.stringify(sanitized) ?? String(sanitized));
  const cleaned = serialized.replace(/\s+/g, " ").trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, Math.max(0, maxLength - 3))}...` : cleaned;
}

function parseJsonOrText(text: string): unknown {
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorPreviewValue(error: unknown): unknown {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return error;
}

function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > 4) {
    return "[truncated]";
  }
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeForLog(item, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isSensitiveLogKey(key)) {
      output[key] = "***REDACTED***";
      continue;
    }
    output[key] = sanitizeForLog(nested, depth + 1);
  }
  return output;
}

function isSensitiveLogKey(key: string): boolean {
  // "harness"/"auth" cover codex_harness_auth: the resolve endpoint returns the
  // decrypted Codex auth.json blob for harness runs, and it must never reach
  // response_preview logs (PR #141 review finding).
  return /authorization|auth|cookie|token|secret|api[_-]?key|provider[_-]?key|openai|anthropic|claude|harness/i.test(
    key
  );
}

function redactSensitiveText(value: string): string {
  return (
    value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***REDACTED***")
      .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, "sk-***REDACTED***")
      .replace(/\bgh[opsru]_[A-Za-z0-9_]{8,}\b/g, "***REDACTED***")
      .replace(
        /\b(?:token|secret|api[_-]?key|authorization|openai_api_key|anthropic_api_key)\s*[:=]\s*[^,\s}]+/gi,
        (match) => {
          const separator = match.includes("=") ? "=" : ":";
          return `${match.slice(0, match.indexOf(separator) + 1)}***REDACTED***`;
        }
      )
      // JSON-serialized credential fields ("refresh_token":"...", "codex_harness_auth":"{...}")
      // are not caught by the bare pattern above because a closing quote sits between the
      // key and the colon. Redact any quoted key that smells sensitive along with its value.
      .replace(/"([^"]*(?:token|secret|auth|key)[^"]*)"\s*:\s*"(?:[^"\\]|\\.)*"/gi, '"$1":"***REDACTED***"')
  );
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function requiredEnv(name: string, fallback?: string): string {
  const value = process.env[name] || fallback;
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable ${name}`);
  }

  return value;
}
