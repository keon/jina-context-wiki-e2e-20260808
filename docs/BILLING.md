# Billing and credits

The unified API owns review admission, usage capture, credit calculation, and
settlement. Autumn owns customer balances, plan entitlements, invoices, checkout, and
auto top-up configuration. Stripe payment details remain behind Autumn and are never
handled by the dashboard or review workers.

## Plans

`autumn.config.ts` is the source of truth for hosted plan definitions:

| Plan            |         Price |                 Included credits | Managed AI |
| --------------- | ------------: | -------------------------------: | ---------- |
| Startup         |    $100/month |                     10,000/month | Enabled    |
| Growth          |    $500/month |                     50,000/month | Enabled    |
| Overage Credits | $10 per 1,000 | Purchased balance does not reset | Add-on     |

Enterprise plans are configured manually. Per-tenant subsidy, infrastructure, and
automatic-review limit overrides remain in `tenant_billing_policy`; they are not plan
definitions.

Push plan changes with `npx atmn push` in Autumn sandbox first. Production changes
require the explicit `--prod` flag and an independently reviewed configuration diff.

## Credit math

One US dollar equals 100 Jina Credits. A successfully completed review has two possible
components:

- one infrastructure charge for the run; and
- AI credits for billable managed-model usage, calculated as
  `ceil(model_cost_usd × customer_share × 100)`.

The default included rate uses 100 infrastructure credits and a 30% AI subsidy
(`customer_share = 0.70`). The default overage rate uses 150 infrastructure credits and
no subsidy. Tenant policy can override those values. Failed, superseded, and cancelled
runs are waived. A user's own ChatGPT/Codex harness or organization-owned provider key
does not create managed-AI usage rows, but the completed run still owes infrastructure
credits.

All monetary arithmetic uses decimal strings and `BigInt` in
`apps/api/src/product/billing-math.ts`; never replace it with floating-point math.

## Credential routing

Review credentials resolve in this order:

1. the pull-request author's connected ChatGPT/Codex harness;
2. an organization provider key that covers every selected stage model; or
3. Jina-managed model credentials.

The resolved route is persisted at review preparation and drives both runtime routing
and billing classification. Resolution failures are fail-closed; the worker must not
silently switch a customer-owned route to managed billing.

## Usage capture and settlement

The review sandbox routes model traffic through the capture proxy. It records bounded,
redacted token and exact-cost fields, never prompts or responses. Usage posts are
idempotent per review, stage, sandbox, and request sequence.

Only a clean `completed` review settles. Each infrastructure charge and AI usage row is
claimed before Autumn tracking and marked with a stable event ID. Retry jobs drain
pending or stale claims. If a process stops after Autumn accepts an event but before the
database records completion, the retry reuses the same idempotency key and emits an
operator-visible possible-duplicate diagnostic.

## Enforcement modes

`JINA_BILLING_ENFORCE` has three modes:

- `off`: billing orchestration is inert;
- `shadow`: compute and persist would-be credits, but never call Autumn or back-bill
  those rows later; and
- `on`: enforce balance admission and track completed usage in Autumn.

An Autumn outage does not invent balances or charges. Dashboard responses distinguish
`not_configured` from `unavailable`. Automatic-review spend caps apply only to automatic
triggers; authorized manual reviews bypass the cap. A prepare-time insufficient-credit
decision records a terminal blocked run and publishes a safe progress notice.

## Dashboard surfaces

The Billing page shows plan, current-cycle granted/used/remaining credits, invoices,
checkout, top-up, and auto top-up controls. Usage shows daily credits and per-pull-request
rollups of infrastructure and AI credits. Every request is scoped to the active Clerk
organization and the API's authoritative tenant mapping.

Never expose Autumn keys, model credentials, raw usage responses, or another tenant's
customer ID to the browser.
