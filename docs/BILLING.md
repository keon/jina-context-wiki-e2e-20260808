# Billing policy helper

Jina does not convert operational usage into hosted charges. Context persists
tenant quota and model-token accounting for admission and observability, while
the billing helper remains a separate pure calculation in
`packages/policy/src/billing-policy.ts`. The deterministic workflow simulation
tests it, and the local review CLI reports provider usage and a managed-cost
equivalent.

The calculation is:

| Key source | AI credits                              | Infra credits              |
| ---------- | --------------------------------------- | -------------------------- |
| Managed    | `ceil(cost_usd × customer_share × 100)` | 100 included / 150 overage |
| User       | 0                                       | 100 included / 150 overage |

The default included-rate subsidy is 30%; overage has no subsidy. These values are policy defaults, not deployed charges.
