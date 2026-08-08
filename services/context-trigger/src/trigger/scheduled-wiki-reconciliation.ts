import { logger, runs, schedules } from "@trigger.dev/sdk";

import { ContextWikiApiClient } from "../shared/api.js";
import { MAX_RECONCILIATIONS_PER_DUE_PAGE } from "../shared/contracts.js";
import {
  reconcileAuditImprovementCandidates,
  reconcileAuditRunCandidates,
  reconcileWikiRunCandidates
} from "../workflow/reconciliation.js";

const MAX_RECONCILIATION_PAGES_PER_RUN = 10;

export const scheduledWikiReconciliation = schedules.task({
  id: "scheduled-wiki-reconciliation",
  cron: "*/5 * * * *",
  queue: { concurrencyLimit: 1 },
  ttl: "10m",
  maxDuration: 300,
  run: async (payload, { ctx }) => {
    const api = new ContextWikiApiClient();
    const timestamp = payload.timestamp.toISOString();
    let cursor: string | undefined;
    let pages = 0;
    const totals = { completed: 0, failed: 0, active: 0, errors: 0 };

    do {
      const due = await api.getDueBuildReconciliations({
        cursor,
        limit: MAX_RECONCILIATIONS_PER_DUE_PAGE,
        timestamp,
        scheduleId: payload.scheduleId
      });
      const reconciled = await reconcileWikiRunCandidates({
        candidates: due.executions,
        failedAt: timestamp,
        retrieve: async (runId) => runs.retrieve(runId),
        api
      });
      totals.completed += reconciled.completed;
      totals.failed += reconciled.failed;
      totals.active += reconciled.active;
      totals.errors += reconciled.errors;
      pages += 1;
      cursor = due.nextCursor;
    } while (cursor && pages < MAX_RECONCILIATION_PAGES_PER_RUN);

    let auditCursor: string | undefined;
    let auditPages = 0;
    do {
      const due = await api.getDueAuditReconciliations({
        cursor: auditCursor,
        limit: MAX_RECONCILIATIONS_PER_DUE_PAGE,
        timestamp,
        scheduleId: payload.scheduleId
      });
      const reconciled = await reconcileAuditRunCandidates({
        candidates: due.audits,
        failedAt: timestamp,
        retrieve: async (runId) => runs.retrieve(runId),
        api
      });
      totals.completed += reconciled.completed;
      totals.failed += reconciled.failed;
      totals.active += reconciled.active;
      totals.errors += reconciled.errors;
      auditPages += 1;
      auditCursor = due.nextCursor;
    } while (auditCursor && auditPages < MAX_RECONCILIATION_PAGES_PER_RUN);

    let improvementCursor: string | undefined;
    let improvementPages = 0;
    const improvements = { admitted: 0, replayed: 0, closed: 0, errors: 0 };
    do {
      const due = await api.getDueAuditImprovements({
        cursor: improvementCursor,
        limit: MAX_RECONCILIATIONS_PER_DUE_PAGE,
        timestamp,
        scheduleId: payload.scheduleId
      });
      const reconciled = await reconcileAuditImprovementCandidates({ candidates: due.audits, api });
      improvements.admitted += reconciled.admitted;
      improvements.replayed += reconciled.replayed;
      improvements.closed += reconciled.closed;
      improvements.errors += reconciled.errors;
      improvementPages += 1;
      improvementCursor = due.nextCursor;
    } while (improvementCursor && improvementPages < MAX_RECONCILIATION_PAGES_PER_RUN);

    logger.info("scheduled_wiki_reconciliation_completed", {
      trigger_run_id: ctx.run.id,
      schedule_id: payload.scheduleId,
      pages,
      audit_pages: auditPages,
      improvement_pages: improvementPages,
      ...totals,
      improvement_admitted: improvements.admitted,
      improvement_replayed: improvements.replayed,
      improvement_closed: improvements.closed,
      improvement_errors: improvements.errors,
      truncated: cursor !== undefined || auditCursor !== undefined || improvementCursor !== undefined
    });
    return {
      status: "completed" as const,
      pages,
      auditPages,
      improvementPages,
      ...totals,
      improvements,
      truncated: cursor !== undefined || auditCursor !== undefined || improvementCursor !== undefined
    };
  }
});
