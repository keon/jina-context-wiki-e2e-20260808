# Retired multi-topic Context remediation

Status: migration reference only. Do not use this runbook against the active
page-oriented workflow.

The former Context graph exposed page audit/repair, repository-wide source challenge,
maintenance-task evaluation, gap repair, certification, publication, and PageIndex as
independently claimable Board topics. Its operator API could append another repair and
gate round after bounded exhaustion.

The active workflow no longer creates or claims that graph. One durable page task now
owns writing, audit, and at most one repair/replacement-audit cycle. Its final result is
an explicit page disposition. Publication omits an unsupported new page or retains the
prior validated page for an unsupported revision, then builds PageIndex and publishes in
one durable task.

Although compatibility reducer and route code may remain temporarily for inspecting old
state, the candidate worker cannot execute the retired queue topics. Do not call the old
build-level `page_remediation` or `gate_remediation` retry modes.

## Cutover requirement

Before deployment, the locked `board-verify` preflight must prove both conditions:

- every nonterminal `build-context` root declares
  `metadata.contextWorkflowContract === "page-oriented"`; and
- no retired Context outbox topic is pending or leased.

The production deploy fails closed when either condition is false. Drain or explicitly
resolve the incompatible state with the currently deployed release before attempting the
page-oriented cutover. Do not bypass the check or reinterpret old stage messages as new
page-oriented work.

## Active recovery

For the active workflow, use ordinary single-task retry only when the API reports that a
failed dispatchable task is eligible and the underlying deterministic or infrastructure
defect has been fixed. Completed phase artifacts and sibling pages remain reusable.
There is no active API contract for appending global challenge, evaluation,
certification, or PageIndex tasks.

See [Architecture](ARCHITECTURE.md),
[Agentic Context derivation](AGENTIC_DERIVATION.md), and
[Deployment](DEPLOYMENT.md) for the current contracts.
