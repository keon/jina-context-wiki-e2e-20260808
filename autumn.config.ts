/**
 * Autumn plan configuration (https://docs.useautumn.com). Pushed with the Autumn CLI
 * (`npx atmn push`, sandbox by default; `--prod` for live). This repo owns plan/feature
 * definitions while per-tenant subsidy/infra/overage rates live in the Jina-side
 * `tenant_billing_policy` table (see migration 0006). Autumn only holds balances and
 * entitlements; Jina computes how many credits each event costs.
 *
 * Conversion assumption (business spec, 2026-07-08): $1 = 100 Jina Credits. The overage
 * top-up is priced $10 per 1,000 credits to preserve that 1:1 cent-to-credit relationship.
 * If the conversion ever changes, update BOTH this file and api/src/billing-math.ts
 * (the ×100 in creditsForCost).
 *
 * Builder API verified against atmn's installed type definitions (plan/feature/item).
 */
import { feature, item, plan } from "atmn";

/* ------------------------------------------------------------------ features --- */

// The single org-level credit meter. Metered + consumable: monthly included balances
// reset on renewal, and prepaid overage top-ups add to the same balance.
export const jinaCredits = feature({
  id: "jina_credits",
  name: "Jina Credits",
  type: "metered",
  consumable: true
});

// Entitlement flag: whether a plan may run managed-AI reviews at all. Off for BYOH-only tiers.
export const managedAiAccess = feature({
  id: "managed_ai_access",
  name: "Managed AI Access",
  type: "boolean"
});

/* --------------------------------------------------------------------- plans --- */

// Startup — $100/mo, 10,000 included Jina Credits/mo, managed AI on.
export const startup = plan({
  id: "startup",
  name: "Startup",
  description: "Small startups with up to ~5 engineers",
  price: { amount: 100, interval: "month" },
  items: [
    item({ featureId: jinaCredits.id, included: 10_000, reset: { interval: "month" } }),
    item({ featureId: managedAiAccess.id })
  ]
});

// Growth — $500/mo, 50,000 included Jina Credits/mo, managed AI on.
export const growth = plan({
  id: "growth",
  name: "Growth",
  description: "Growing startups with higher PR volume",
  price: { amount: 500, interval: "month" },
  items: [
    item({ featureId: jinaCredits.id, included: 50_000, reset: { interval: "month" } }),
    item({ featureId: managedAiAccess.id })
  ]
});

// Overage credit top-up — a prepaid add-on purchase: $10 buys 1,000 credits ($1 = 100
// credits). addOn so it attaches on top of any active plan without replacing it; no
// reset, so purchased credits persist until spent.
export const overageCredits = plan({
  id: "overage_credits",
  name: "Overage Credits",
  description: "Prepaid credit top-up ($10 per 1,000 credits)",
  addOn: true,
  items: [
    item({
      featureId: jinaCredits.id,
      price: {
        amount: 10,
        interval: "one_off",
        billingUnits: 1_000,
        billingMethod: "prepaid"
      }
    })
  ]
});

// Enterprise stays manual/custom: attach a hand-built Autumn plan with custom included
// credits and hand-created Stripe invoices, plus per-tenant overrides in
// tenant_billing_policy. No repo config.
