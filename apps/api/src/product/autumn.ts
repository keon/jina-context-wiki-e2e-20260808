import type { BillingConfig } from "./config.js";

/**
 * Minimal Autumn (useautumn.com) client built on plain fetch — no new npm dependencies.
 *
 * Verified against https://docs.useautumn.com (2026-07):
 *  - check:  POST {apiUrl}/balances.check  { customer_id, feature_id, required_balance }
 *            -> { allowed, balance?: { remaining, granted, ... } }
 *  - track:  POST {apiUrl}/balances.track  { customer_id, feature_id, value, idempotency_key? }
 *            The idempotency_key appears in Autumn's SDK examples but is NOT in the published
 *            OpenAPI schema. The billing service's guarantee is AT-LEAST-ONCE with same-key retries:
 *            each row/run is claimed ('pending' -> 'tracking', single-flight) before its one track,
 *            so concurrent drains never double-track. The normal path charges exactly once. The only
 *            re-track is when a crash lands between a successful track and the 'billed' persist — the
 *            retry job re-sends with the SAME idempotency_key and logs `possible_duplicate_charge`
 *            with the event id. So: exactly-once if Autumn honors the key; otherwise a loudly-flagged
 *            duplicate carrying everything ops needs to reconcile a manual credit.
 *  - create: POST {apiUrl}/customers.get_or_create { customer_id, name?, stripe_id? }
 *  - update: POST {apiUrl}/customers.update { customer_id, name?, metadata? }
 *  - attach: POST {apiUrl}/billing.attach   { customer_id, plan_id, redirect_mode? }
 *            -> { payment_url | url | checkout_url }
 *  - get:    POST {apiUrl}/customers.get     { customer_id } -> { subscriptions }
 */

/** Distinguishes a retryable outage ("Autumn down": network/timeout/5xx) from a 4xx caller bug. */
export class AutumnError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    // The Autumn endpoint path that failed — surfaced in billing_config_error logs (FINDING 4).
    public readonly endpoint?: string,
  ) {
    super(message);
    this.name = "AutumnError";
  }
}

export type CheckResult = {
  allowed: boolean;
  // Remaining balance for the feature (Autumn balance.remaining), when present.
  balance?: number;
  // Current-cycle granted allowance (Autumn balance.granted) and used amount (balance.usage), when
  // present. Surfaced so the dashboard can show the granted/remaining/used cycle breakdown and so the
  // auto-review cap can read current-cycle used credits without a second call.
  granted?: number;
  usage?: number;
  // When the current cycle's balance resets (Autumn balance.next_reset_at, ISO string), when present.
  nextResetAt?: string;
};

/** A recent invoice as surfaced to the dashboard (from getCustomer expand=invoices). */
export type AutumnInvoice = { date: string | null; amount: string; status: string; url?: string };

export type CustomerSummary = {
  planId: string | null;
  // Present only when getCustomer is called with { expandInvoices: true } AND Autumn returned an invoices
  // array; otherwise the key is absent (never fabricated).
  invoices?: AutumnInvoice[];
};

/** Auto top-up (auto-reload) configuration for one feature, applied per customer at runtime. */
type AutoTopupInput = {
  featureId: string;
  enabled: boolean;
  // Balance level that triggers a top-up, and how many units to purchase each time. Ignored by Autumn
  // when disabling (enabled=false), but always sent for a consistent payload.
  threshold: number;
  quantity: number;
};

export interface AutumnClient {
  ensureCustomer(
    customerId: string,
    name?: string,
    stripeId?: string,
    metadata?: Record<string, string>,
  ): Promise<void>;
  updateCustomer(customerId: string, name?: string, metadata?: Record<string, string>): Promise<void>;
  check(customerId: string, featureId: string, requiredBalance?: number): Promise<CheckResult>;
  track(customerId: string, featureId: string, value: number, idempotencyKey: string): Promise<void>;
  checkoutUrl(
    customerId: string,
    productId: string,
    opts?: { successUrl?: string; featureQuantities?: Array<{ feature_id: string; quantity: number }> },
  ): Promise<string>;
  getCustomer(customerId: string, opts?: { expandInvoices?: boolean }): Promise<CustomerSummary>;
  setAutoTopup(customerId: string, input: AutoTopupInput): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 10_000;
const AUTUMN_API_VERSION = "2.3.0";

export function createAutumnClient(config: BillingConfig): AutumnClient | undefined {
  const secretKey = config.autumnSecretKey;
  if (!secretKey) {
    return undefined; // billing disabled — callers must handle an absent client
  }
  return new HttpAutumnClient(config.autumnApiUrl, secretKey, config.checkoutSuccessUrl);
}

class HttpAutumnClient implements AutumnClient {
  constructor(
    private readonly apiUrl: string,
    private readonly secretKey: string,
    private readonly checkoutSuccessUrl?: string,
  ) {}

  async ensureCustomer(
    customerId: string,
    name?: string,
    stripeId?: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    await this.post("/customers.get_or_create", {
      customer_id: customerId,
      name: name ?? undefined,
      stripe_id: stripeId ?? undefined,
      // Tag the customer with its tenant identity (github login/id/type) so a personal customer and an
      // org customer created for the same person are distinguishable in Autumn/Stripe. undefined is
      // stripped by the request layer, so this is a no-op when no metadata is supplied.
      metadata: metadata && Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  async updateCustomer(customerId: string, name?: string, metadata?: Record<string, string>): Promise<void> {
    await this.post("/customers.update", {
      customer_id: customerId,
      name: name ?? undefined,
      metadata: metadata && Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  async check(customerId: string, featureId: string, requiredBalance = 1): Promise<CheckResult> {
    const body = await this.post("/balances.check", {
      customer_id: customerId,
      feature_id: featureId,
      required_balance: requiredBalance,
    });
    // FINDING 1: shape-validate a schema-invalid 2xx before it becomes a billing decision. A missing
    // or non-boolean `allowed` was silently coerced to false, which under enforcement-on BLOCKS the
    // tenant on nothing more than an Autumn schema drift. Treat it as a RETRYABLE outage (naming the
    // field) so the fail-open / leave-pending paths handle it instead of enforcing a phantom denial.
    if (typeof body.allowed !== "boolean") {
      throw new AutumnError(
        "Autumn /balances.check response has a missing or non-boolean 'allowed' field",
        true,
        undefined,
        "/balances.check",
      );
    }
    let balance: number | undefined;
    let granted: number | undefined;
    let usage: number | undefined;
    let nextResetAt: string | undefined;
    if (body.balance && typeof body.balance === "object" && !Array.isArray(body.balance)) {
      const balanceObj = body.balance as Record<string, unknown>;
      const remaining = balanceObj.remaining;
      // `remaining`, when present, must be a finite number. A present-but-malformed value is a schema
      // violation, not "balance unknown" — throw retryable rather than silently dropping it to undefined.
      if (remaining !== undefined && remaining !== null) {
        const numeric = numberOrUndefined(remaining);
        if (numeric === undefined) {
          throw new AutumnError(
            "Autumn /balances.check response has a non-numeric 'balance.remaining' field",
            true,
            undefined,
            "/balances.check",
          );
        }
        balance = numeric;
      }
      // granted/usage/next_reset_at power the dashboard cycle breakdown and the auto-review cap. Unlike
      // `remaining` these are non-load-bearing display fields, so a malformed value is dropped (undefined)
      // rather than thrown — a missing cycle detail must never turn a healthy check into a phantom outage.
      granted = numberOrUndefined(balanceObj.granted);
      usage = numberOrUndefined(balanceObj.usage);
      nextResetAt = stringOrUndefined(balanceObj.next_reset_at);
    }
    // Only attach the cycle fields when present so callers/tests that compare the lean { allowed, balance }
    // shape are unaffected; the fields appear exactly when Autumn returned them.
    const result: CheckResult = { allowed: body.allowed, balance };
    if (granted !== undefined) {
      result.granted = granted;
    }
    if (usage !== undefined) {
      result.usage = usage;
    }
    if (nextResetAt !== undefined) {
      result.nextResetAt = nextResetAt;
    }
    return result;
  }

  async track(customerId: string, featureId: string, value: number, idempotencyKey: string): Promise<void> {
    await this.post("/balances.track", {
      customer_id: customerId,
      feature_id: featureId,
      value,
      idempotency_key: idempotencyKey,
    });
  }

  async checkoutUrl(
    customerId: string,
    productId: string,
    opts?: { successUrl?: string; featureQuantities?: Array<{ feature_id: string; quantity: number }> },
  ): Promise<string> {
    const body = await this.post("/billing.attach", {
      customer_id: customerId,
      plan_id: productId,
      redirect_mode: "always",
      // Return the buyer to our dashboard after checkout; without this Autumn
      // redirects to its own landing site. Caller override wins, else the
      // configured dashboard success URL.
      success_url: opts?.successUrl ?? this.checkoutSuccessUrl,
      // Prepaid products (the overage top-up) need the purchased quantity or
      // Stripe checkout has no line items and 400s ("line_items required").
      feature_quantities: opts?.featureQuantities,
    });
    const url =
      stringOrUndefined(body.payment_url) ??
      stringOrUndefined(body.paymentUrl) ??
      stringOrUndefined(body.url) ??
      stringOrUndefined(body.checkout_url) ??
      stringOrUndefined((body.stripe as Record<string, unknown> | undefined)?.url);
    return validateCheckoutUrl(url);
  }

  async getCustomer(customerId: string, opts?: { expandInvoices?: boolean }): Promise<CustomerSummary> {
    // Autumn's getCustomer supports `expand: ["invoices"]` to return recent invoices in one call. Only
    // request it when the caller wants invoices, so the default gate/overview path stays a lean lookup.
    const body = await this.post(
      "/customers.get",
      opts?.expandInvoices ? { customer_id: customerId, expand: ["invoices"] } : { customer_id: customerId },
    );
    // Autumn returns active subscriptions; the first non-add-on entry is the tenant plan.
    // FINDING 1: shape-validate the plan field before deriving a plan from it. When `subscriptions`
    // is PRESENT but not the expected shape (not an array, or an entry that is not an object), the
    // old code silently degraded to planId:null — a schema drift then reads as "no plan". Treat a
    // present-but-malformed field as a RETRYABLE outage so the dashboard reports 'unavailable' rather
    // than a wrong plan. An ABSENT field stays planId:null (a customer with no subscription).
    if (body.subscriptions !== undefined && !Array.isArray(body.subscriptions)) {
      throw new AutumnError(
        "Autumn /customers.get response has a malformed 'subscriptions' field",
        true,
        undefined,
        "/customers.get",
      );
    }
    const subscriptions = Array.isArray(body.subscriptions) ? body.subscriptions : [];
    let planId: string | null = null;
    for (const entry of subscriptions) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new AutumnError(
          "Autumn /customers.get response has a malformed 'subscriptions' entry",
          true,
          undefined,
          "/customers.get",
        );
      }
      const record = entry as Record<string, unknown>;
      if (record.addOn === true || record.add_on === true || record.is_add_on === true) {
        continue;
      }
      const id =
        stringOrUndefined(record.planId) ??
        stringOrUndefined(record.plan_id) ??
        stringOrUndefined(record.id);
      if (id) {
        planId = id;
        break;
      }
    }
    // Only surface invoices when the caller asked to expand them. A malformed/absent invoices field is
    // NOT an outage (display-only), so it simply yields no invoices key rather than throwing.
    if (opts?.expandInvoices && Array.isArray(body.invoices)) {
      return { planId, invoices: body.invoices.flatMap(parseInvoice) };
    }
    return { planId };
  }

  async setAutoTopup(customerId: string, input: AutoTopupInput): Promise<void> {
    // Per-customer auto top-up (auto-reload) via Autumn's customer-update endpoint. Requires the plan to
    // carry a one-off prepaid item for the feature and a saved payment method on the customer (Autumn
    // enforces both server-side). Sent as a billing_controls.auto_topups entry for the credits feature.
    await this.post("/customers.update", {
      customer_id: customerId,
      billing_controls: {
        auto_topups: [
          {
            feature_id: input.featureId,
            enabled: input.enabled,
            threshold: input.threshold,
            quantity: input.quantity,
          },
        ],
      },
    });
  }

  private post(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", path, payload);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    payload?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${this.apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.secretKey}`,
          "content-type": "application/json",
          "x-api-version": AUTUMN_API_VERSION,
        },
        body: payload ? JSON.stringify(stripUndefined(payload)) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      // Network failure or timeout — retryable. Never surface the raw error (could echo the URL
      // with the bearer token); only its class-level message.
      const reason = controller.signal.aborted ? "timeout" : "network error";
      throw new AutumnError(`Autumn request to ${path} failed: ${reason}`, true, undefined, path);
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      // Some endpoints (async track) return 204/empty — tolerate an empty body.
      const text = await response.text().catch(() => "");
      if (!text) {
        return {};
      }
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        // FINDING 3: a 2xx carrying a non-empty body that fails to parse is an integration failure,
        // not a billing decision. Returning {} here silently degraded check() -> allowed:false
        // (blocking tenants under 'on') and getCustomer() -> planId:null. Throw a RETRYABLE error so
        // the fail-open / leave-pending paths handle it as an outage instead of a real answer.
        throw new AutumnError(`Autumn request to ${path} returned invalid JSON`, true, response.status, path);
      }
    }

    // 5xx (and 408/429) are transient; 4xx is a bug in our request. Drain the body but never
    // include secrets in the thrown message.
    await response.text().catch(() => "");
    const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
    throw new AutumnError(`Autumn request to ${path} failed: ${response.status}`, retryable, response.status, path);
  }
}

/**
 * FINDING D: validate the checkout URL before returning it — the dashboard redirects the browser
 * straight to whatever comes back, so a malformed or non-http(s) value (e.g. a `javascript:` scheme
 * or garbage from a broken upstream) is an open-redirect / XSS vector. Treat an unparseable or
 * non-http(s) URL as an invalid upstream response: a non-retryable AutumnError (retrying can't fix
 * a bad payload). Only http:/https: absolute URLs are accepted.
 */
export function validateCheckoutUrl(rawUrl: string | undefined): string {
  if (!rawUrl) {
    throw new AutumnError("Autumn checkout returned no url", false);
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AutumnError("Autumn checkout returned an invalid url", false);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AutumnError("Autumn checkout returned a non-http(s) url", false);
  }
  return rawUrl;
}

function stripUndefined(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Parse one Autumn invoice entry defensively into the dashboard shape. Autumn's invoice field names are
 * not fully pinned in the published schema, so each field is read from the most likely name(s) with a
 * fallback and DROPPED (flatMap -> []) if the entry is not an object. `amount` is kept as a string (money
 * is never floated); the amount is read from `total`/`amount` and stringified without float math.
 */
function parseInvoice(entry: unknown): AutumnInvoice[] {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return [];
  }
  const record = entry as Record<string, unknown>;
  const rawAmount = record.total ?? record.amount ?? record.amount_due;
  const amount =
    typeof rawAmount === "number" && Number.isFinite(rawAmount)
      ? String(rawAmount)
      : (stringOrUndefined(rawAmount) ?? "0");
  const invoice: AutumnInvoice = {
    date: stringOrUndefined(record.created_at) ?? stringOrUndefined(record.date) ?? null,
    amount,
    status: stringOrUndefined(record.status) ?? "unknown",
  };
  const url = stringOrUndefined(record.hosted_invoice_url) ?? stringOrUndefined(record.url);
  if (url !== undefined) {
    invoice.url = url;
  }
  return [invoice];
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
