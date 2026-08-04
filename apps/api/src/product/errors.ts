import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ApiError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function jsonError(c: Context, error: unknown): Response {
  if (error instanceof ApiError) {
    return c.json({ error: error.message, details: error.details }, error.status);
  }

  const message = error instanceof Error ? error.message : "unknown error";
  console.error("unhandled_error", { message, error });
  return c.json({ error: "internal server error" }, 500);
}
