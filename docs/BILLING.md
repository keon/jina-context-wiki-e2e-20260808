# Billing design

> **Implementation status:** Jina does not currently enforce hosted billing, persist normalized usage rows, or connect the deployed worker to Autumn, Stripe, or a usage capture proxy. The local workflow can report provider usage and exercise provisional credit math.

## Current helpers

`packages/policy/src/billing-policy.ts` implements the proposed calculation:

| Key source | AI credits                              | Infra credits              |
| ---------- | --------------------------------------- | -------------------------- |
| Managed    | `ceil(cost_usd × customer_share × 100)` | 100 included / 150 overage |
| User       | 0                                       | 100 included / 150 overage |

The default included-rate subsidy is 30%; overage has no subsidy. The deterministic workflow simulation tests the formula, and the local review CLI prints provider usage and a managed-cost equivalent.

## Planned hosted boundary

The retained design direction is:

- OpenRouter returns exact managed-model usage and cost; persisted provider cost, not catalog estimates, is the source for AI credits.
- A user-supplied provider key incurs only Jina infrastructure credits. Key-resolution failure must not fall back to a managed key.
- Entitlement and balance checks happen before dispatch; rate mode is fixed for that run.
- Every model call has a dedupe key and raw provider usage. Persistence fails loudly rather than silently dropping usage.
- Charging is outcome-gated and idempotent. Failed or superseded epochs are waived; completed root tasks charge once.
- A temporarily unavailable billing service leaves durable pending usage for retry without duplicating charges.
- The dashboard eventually derives balances and per-run breakdowns from the same usage rows used for billing.

Planned storage groups are summarized in [DATA_MODELS.md](DATA_MODELS.md). These rules are not deployed controls until their schema, provider integration, and reconciliation checks exist.
