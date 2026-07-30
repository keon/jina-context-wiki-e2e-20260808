# Exhausted Context remediation

Context page generation automatically performs at most two citation-quality
repair passes. If the final audit still fails, the Board fails that page and its
build with `context.page_repair_exhausted`. It retains the completed page branch,
the last completed audit, and their immutable artifacts. A tenant administrator
can then schedule one additional repair/audit pass without restarting the build
or discarding successful sibling pages.

The repository-wide source challenge and context-only maintenance-task
evaluation use the same checkpoint-first policy. They receive three automatic
global repair passes. If material gaps remain, certification is canceled with
`context.gate_repair_exhausted`, while the latest candidate draft, source
challenge, task evaluation, and all completed page checkpoints remain durable.
An administrator can schedule one additional
repair/challenge/evaluation round from that retained state.

This path is for a deterministic page-quality failure after an operator has
fixed the underlying prompt, model, validator, or worker defect. It is not an
unbounded model retry.

## Identify an eligible page

Read the failed build's progress using an internal credential or an issued token
with the required read scope:

```bash
curl -fsS \
  "$JINA_API_URL/context/builds/$BUILD_TASK_ID/progress" \
  -H "Authorization: Bearer $CONTEXT_ADMIN_TOKEN" \
  -H "X-Jina-Tenant-Id: $JINA_TENANT_ID" \
  -H "X-Jina-Principal-Id: $JINA_ADMIN_PRINCIPAL_ID" |
  jq '.retryEligibility'
```

For an administrator, an exhausted page that can be resumed appears as:

```json
{
  "eligible": true,
  "recoverableTaskIds": ["task_page_id"],
  "blockers": [],
  "mode": "page_remediation"
}
```

An exhausted global gate appears as:

```json
{
  "eligible": true,
  "recoverableTaskIds": ["task_certification_id"],
  "blockers": [],
  "mode": "gate_remediation"
}
```

The mode distinguishes page-quality and global-gate remediation from ordinary
dispatchable-task retry. Page remediation names a page aggregate rather than
its failed audit/repair child. Gate remediation names the canceled
certification task as its single recovery target. Confirm that the build still
belongs to the intended repository and ref before continuing.

Progress is tenant and repository scoped. Another tenant receives `404` for the
opaque build ID. Repository readers can inspect their own build progress, but
only a tenant administrator receives retry eligibility and can invoke the retry
route.

## Schedule one remediation pass

Submit exactly one recovery target to the build-level batch route:

```bash
curl -fsS -X POST \
  "$JINA_API_URL/context/builds/$BUILD_TASK_ID/retry" \
  -H "Authorization: Bearer $CONTEXT_ADMIN_TOKEN" \
  -H "X-Jina-Tenant-Id: $JINA_TENANT_ID" \
  -H "X-Jina-Principal-Id: $JINA_ADMIN_PRINCIPAL_ID" \
  -H "Content-Type: application/json" \
  -d "{
    \"taskIds\": [\"$PAGE_TASK_ID\"],
    \"requestKey\": \"operator:incident-123:page-remediation:v1\",
    \"reason\": \"citation-audit defect fixed; resume from retained checkpoints\"
  }"
```

The first accepted request returns `202`:

```json
{
  "accepted": true,
  "duplicate": false,
  "buildId": "task_build_id",
  "taskIds": ["task_page_id"],
  "tasks": [
    {
      "taskId": "task_new_repair_id",
      "attempt": 1,
      "outboxMessageId": "outbox_message_id"
    }
  ],
  "reopenedTaskIds": ["task_build_id", "task_page_id"]
}
```

The Board reopens only the failed build/page aggregate branch and adds one new
repair/audit pair. The repair has a required dependency on the retained
completed audit and consumes that audit's immutable findings artifact. The
completed checkpoint is not rewritten. Dispatchable siblings canceled by the
failed build are reopened behind a required dependency on the new audit, so
they do not restart expensive agent work unless the targeted page passes.
Automatic repair ends at pass 2; operator remediation can add one pass at a
time through the hard maximum of pass 12.

For `gate_remediation`, the same route reopens the failed build, canceled
certification and downstream publication work, and whichever final challenger
or evaluator was canceled by terminal reconciliation. It then adds one global
repair pass with fresh successor challenge/evaluation tasks, and makes
certification wait for both. Earlier completed pages and gate checkpoints are
not re-run. Automatic global repair ends at pass 3; explicit operator
continuation can add one pass at a time through the same hard maximum of pass 12.

The API reactivates the build's active-build quota reservation only after the
Board mutation is accepted. If validation or persistence fails, it rolls that
reservation back.

The coordinated production acceptance job consumes this same public contract.
When—and only when—progress exposes an eligible `page_remediation` or
`gate_remediation`, it submits one deterministic operation and resumes polling.
It permits at most four total recoveries in one acceptance run. Ordinary task
failures, infrastructure failures, mixed branches, and ineligible quality
failures still terminate acceptance immediately.

## Idempotent replay

Treat `requestKey` as the durable operation identifier and retain it with the
incident record. Repeating the same build, page, and `requestKey` returns `200`
with `duplicate: true` and the original task, outbox, and reopened-task IDs. It
does not add another repair pass, event, outbox message, or quota reservation.

Do not reuse the key for a different build or page.

## Fail-closed boundaries

The API rejects the request without changing Board or quota state when:

- the caller is not a tenant administrator (`403`);
- the build belongs to another tenant or is not visible through repository
  access (`404`);
- more than one remediation target is supplied in the same request (`409`,
  `operator_retry_rejected`);
- a page aggregate or certification target is mixed with an ordinary
  dispatchable task (`409`,
  `operator_retry_rejected`);
- the build is not failed from bounded page or global-gate exhaustion;
- the retained completed audit or its output artifact is absent;
- the next pass would exceed pass 12; or
- the build has already published Context or completed PageIndex.

For several failed pages, remediate them serially with distinct request keys.
After each pass, watch the same progress endpoint until the new audit either
allows the build to continue or fails the page again. If it fails again and
`mode: "page_remediation"` remains eligible, a new operator request may schedule
the next single pass. Apply the same one-request-per-pass rule when
`mode: "gate_remediation"` remains eligible.
