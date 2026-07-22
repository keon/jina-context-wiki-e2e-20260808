# Billing policy helper

Jina does not enforce hosted billing or persist usage. The only implemented billing behavior is the pure calculation in `packages/policy/src/billing-policy.ts`; the deterministic workflow simulation tests it, and the local review CLI reports provider usage and a managed-cost equivalent.

The calculation is:

| Key source | AI credits                              | Infra credits              |
| ---------- | --------------------------------------- | -------------------------- |
| Managed    | `ceil(cost_usd × customer_share × 100)` | 100 included / 150 overage |
| User       | 0                                       | 100 included / 150 overage |

The default included-rate subsidy is 30%; overage has no subsidy. These values are policy defaults, not deployed charges.
