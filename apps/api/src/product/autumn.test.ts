import assert from "node:assert/strict";
import { test } from "node:test";

import { AutumnError, createAutumnClient, validateCheckoutUrl } from "./autumn.js";
import type { BillingConfig } from "./config.js";

/* --------------------------------------------------- test helpers --- */

function autumnConfig(): BillingConfig {
  return {
    autumnSecretKey: "sk_test",
    autumnApiUrl: "https://api.useautumn.com/v1",
    creditsFeatureId: "jina_credits",
    managedAiFeatureId: "managed_ai_access",
    enforce: "on",
  };
}

type FetchCall = {
  url: string;
  init: RequestInit | undefined;
};

function withStubbedFetch(
  responder: () => Partial<Response> & { ok: boolean },
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => responder() as Response) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function withCapturedFetch(
  responder: () => Partial<Response> & { ok: boolean },
  run: (calls: FetchCall[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return responder() as Response;
  }) as typeof fetch;
  return run(calls).finally(() => {
    globalThis.fetch = original;
  });
}

function requestJson(call: FetchCall): unknown {
  const body = call.init?.body;
  assert.equal(typeof body, "string");
  return JSON.parse(body as string);
}

function requestHeaders(call: FetchCall): Record<string, string> {
  assert.ok(call.init?.headers);
  return call.init.headers as Record<string, string>;
}

/* --------------------------------------------------- Autumn API contract --- */

test("ensureCustomer uses Autumn get_or_create and sends the API version header", async () => {
  const client = createAutumnClient(autumnConfig())!;

  await withCapturedFetch(
    () => ({ ok: true, status: 200, text: async () => "{}" }),
    async (calls) => {
      await client.ensureCustomer("cust-1", "Tenant One", "cus_123");

      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.url, "https://api.useautumn.com/v1/customers.get_or_create");
      assert.equal(calls[0]!.init?.method, "POST");
      assert.deepEqual(requestJson(calls[0]!), {
        customer_id: "cust-1",
        name: "Tenant One",
        stripe_id: "cus_123",
      });
      assert.equal(requestHeaders(calls[0]!)["x-api-version"], "2.3.0");
    },
  );
});

test("ensureCustomer tags the customer with tenant metadata (org vs personal differentiator)", async () => {
  const client = createAutumnClient(autumnConfig())!;

  await withCapturedFetch(
    () => ({ ok: true, status: 200, text: async () => "{}" }),
    async (calls) => {
      await client.ensureCustomer("org-tenant-1", "Pistachio-Wallet (org)", undefined, {
        github_account_id: "97225700",
        github_account_type: "Organization",
        github_login: "Pistachio-Wallet",
      });

      assert.deepEqual(requestJson(calls[0]!), {
        customer_id: "org-tenant-1",
        name: "Pistachio-Wallet (org)",
        metadata: {
          github_account_id: "97225700",
          github_account_type: "Organization",
          github_login: "Pistachio-Wallet",
        },
      });
    },
  );
});

test("updateCustomer repairs an existing customer's name and tenant metadata", async () => {
  const client = createAutumnClient(autumnConfig())!;

  await withCapturedFetch(
    () => ({ ok: true, status: 200, text: async () => "{}" }),
    async (calls) => {
      await client.updateCustomer("org-tenant-1", "Metopian (org)", {
        github_account_id: "107232189",
        github_account_type: "Organization",
        github_login: "Metopian",
      });

      assert.equal(calls[0]!.url, "https://api.useautumn.com/v1/customers.update");
      assert.deepEqual(requestJson(calls[0]!), {
        customer_id: "org-tenant-1",
        name: "Metopian (org)",
        metadata: {
          github_account_id: "107232189",
          github_account_type: "Organization",
          github_login: "Metopian",
        },
      });
    },
  );
});

test("checkoutUrl uses Autumn billing.attach and accepts payment_url", async () => {
  const client = createAutumnClient(autumnConfig())!;

  await withCapturedFetch(
    () => ({ ok: true, status: 200, text: async () => JSON.stringify({ payment_url: "https://checkout.stripe.com/session/abc" }) }),
    async (calls) => {
      const url = await client.checkoutUrl("cust-1", "overage_credits");

      assert.equal(url, "https://checkout.stripe.com/session/abc");
      assert.equal(calls[0]!.url, "https://api.useautumn.com/v1/billing.attach");
      assert.deepEqual(requestJson(calls[0]!), {
        customer_id: "cust-1",
        plan_id: "overage_credits",
        redirect_mode: "always",
      });
    },
  );
});

test("checkoutUrl sends the configured success_url so Stripe returns to the dashboard", async () => {
  const client = createAutumnClient({ ...autumnConfig(), checkoutSuccessUrl: "https://app.usejina.com/billing?checkout=success" })!;

  await withCapturedFetch(
    () => ({ ok: true, status: 200, text: async () => JSON.stringify({ url: "https://checkout.stripe.com/session/xyz" }) }),
    async (calls) => {
      await client.checkoutUrl("cust-1", "startup");
      assert.equal(
        (requestJson(calls[0]!) as Record<string, unknown>).success_url,
        "https://app.usejina.com/billing?checkout=success",
      );
    },
  );
});

test("getCustomer uses customers.get and reads the active non-add-on subscription plan", async () => {
  const client = createAutumnClient(autumnConfig())!;

  await withCapturedFetch(
    () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          subscriptions: [
            { planId: "overage_credits", addOn: true },
            { planId: "startup", addOn: false },
          ],
        }),
    }),
    async (calls) => {
      assert.deepEqual(await client.getCustomer("cust-1"), { planId: "startup" });
      assert.equal(calls[0]!.url, "https://api.useautumn.com/v1/customers.get");
      assert.deepEqual(requestJson(calls[0]!), { customer_id: "cust-1" });
    },
  );
});

/* --------------------------------------------------- malformed 2xx (FINDING 3) --- */

test("check() on a 2xx with invalid JSON throws a RETRYABLE AutumnError (not a billing decision)", async () => {
  const client = createAutumnClient(autumnConfig())!;
  await withStubbedFetch(
    () => ({ ok: true, status: 200, text: async () => "<html>gateway</html>" }),
    async () => {
      await assert.rejects(
        client.check("cust-1", "jina_credits"),
        (error: unknown) => error instanceof AutumnError && error.retryable === true && error.endpoint === "/balances.check",
      );
    },
  );
});

test("getCustomer() on a 2xx with invalid JSON throws retryable rather than reporting planId:null", async () => {
  const client = createAutumnClient(autumnConfig())!;
  await withStubbedFetch(
    () => ({ ok: true, status: 200, text: async () => "not json" }),
    async () => {
      await assert.rejects(
        client.getCustomer("cust-1"),
        (error: unknown) => error instanceof AutumnError && error.retryable === true,
      );
    },
  );
});

test("track() tolerates an empty-body 2xx (endpoints that return no content)", async () => {
  const client = createAutumnClient(autumnConfig())!;
  await withStubbedFetch(
    () => ({ ok: true, status: 204, text: async () => "" }),
    async () => {
      await assert.doesNotReject(client.track("cust-1", "jina_credits", 5, "evt-1"));
    },
  );
});

/* --------------------------------------------------- schema-invalid 2xx (FINDING 1) --- */

test("check() reads a well-formed allowed + balance shape", async () => {
  const client = createAutumnClient(autumnConfig())!;
  await withStubbedFetch(
    () => ({ ok: true, status: 200, text: async () => JSON.stringify({ allowed: true, balance: { remaining: 42 } }) }),
    async () => {
      assert.deepEqual(await client.check("cust-1", "jina_credits"), { allowed: true, balance: 42 });
    },
  );
});

test("check() accepts a well-formed allowed with no balance object (managed-access shape)", async () => {
  const client = createAutumnClient(autumnConfig())!;
  await withStubbedFetch(
    () => ({ ok: true, status: 200, text: async () => JSON.stringify({ allowed: false }) }),
    async () => {
      assert.deepEqual(await client.check("cust-1", "managed_ai_access"), { allowed: false, balance: undefined });
    },
  );
});

test("check() on a 2xx missing 'allowed' throws RETRYABLE (never coerces to a false denial)", async () => {
  const client = createAutumnClient(autumnConfig())!;
  await withStubbedFetch(
    () => ({ ok: true, status: 200, text: async () => JSON.stringify({ balance: { remaining: 5 } }) }),
    async () => {
      await assert.rejects(
        client.check("cust-1", "jina_credits"),
        (error: unknown) =>
          error instanceof AutumnError && error.retryable === true && /allowed/.test(error.message),
      );
    },
  );
});

test("check() on a 2xx with a non-boolean 'allowed' throws RETRYABLE", async () => {
  const client = createAutumnClient(autumnConfig())!;
  await withStubbedFetch(
    () => ({ ok: true, status: 200, text: async () => JSON.stringify({ allowed: "yes" }) }),
    async () => {
      await assert.rejects(
        client.check("cust-1", "jina_credits"),
        (error: unknown) => error instanceof AutumnError && error.retryable === true,
      );
    },
  );
});

test("check() on a 2xx with a present-but-non-numeric balance.remaining throws RETRYABLE", async () => {
  const client = createAutumnClient(autumnConfig())!;
  await withStubbedFetch(
    () => ({ ok: true, status: 200, text: async () => JSON.stringify({ allowed: true, balance: { remaining: "lots" } }) }),
    async () => {
      await assert.rejects(
        client.check("cust-1", "jina_credits"),
        (error: unknown) =>
          error instanceof AutumnError && error.retryable === true && /balance\.remaining/.test(error.message),
      );
    },
  );
});

test("getCustomer() on a 2xx with a non-array 'subscriptions' throws RETRYABLE (not planId:null)", async () => {
  const client = createAutumnClient(autumnConfig())!;
  await withStubbedFetch(
    () => ({ ok: true, status: 200, text: async () => JSON.stringify({ subscriptions: { plan_id: "startup" } }) }),
    async () => {
      await assert.rejects(
        client.getCustomer("cust-1"),
        (error: unknown) =>
          error instanceof AutumnError && error.retryable === true && error.endpoint === "/customers.get",
      );
    },
  );
});

test("getCustomer() on a 2xx with a malformed subscription entry throws RETRYABLE", async () => {
  const client = createAutumnClient(autumnConfig())!;
  await withStubbedFetch(
    () => ({ ok: true, status: 200, text: async () => JSON.stringify({ subscriptions: ["startup"] }) }),
    async () => {
      await assert.rejects(
        client.getCustomer("cust-1"),
        (error: unknown) => error instanceof AutumnError && error.retryable === true,
      );
    },
  );
});

test("getCustomer() treats an absent 'subscriptions' field as planId:null (no plan, not malformed)", async () => {
  const client = createAutumnClient(autumnConfig())!;
  await withStubbedFetch(
    () => ({ ok: true, status: 200, text: async () => JSON.stringify({}) }),
    async () => {
      assert.deepEqual(await client.getCustomer("cust-1"), { planId: null });
    },
  );
});

/* --------------------------------------------------- checkout url (FINDING D) --- */

test("validateCheckoutUrl accepts https and http absolute urls", () => {
  assert.equal(validateCheckoutUrl("https://checkout.stripe.com/session/abc"), "https://checkout.stripe.com/session/abc");
  assert.equal(validateCheckoutUrl("http://checkout.example/session"), "http://checkout.example/session");
});

test("validateCheckoutUrl rejects a javascript: scheme (open-redirect / XSS vector)", () => {
  assert.throws(
    () => validateCheckoutUrl("javascript:alert(document.cookie)"),
    (error: unknown) => error instanceof AutumnError && error.retryable === false,
  );
});

test("validateCheckoutUrl rejects a garbage (unparseable) string", () => {
  assert.throws(
    () => validateCheckoutUrl("not a url at all"),
    (error: unknown) => error instanceof AutumnError && error.retryable === false,
  );
});

test("validateCheckoutUrl rejects an empty/absent url", () => {
  assert.throws(() => validateCheckoutUrl(undefined), AutumnError);
  assert.throws(() => validateCheckoutUrl(""), AutumnError);
});
