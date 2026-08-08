import { batch, logger, schedules } from "@trigger.dev/sdk";

import { ContextWikiApiClient } from "../shared/api.js";
import { MAX_AUDITS_PER_DUE_PAGE } from "../shared/contracts.js";
import { hashedAuditTags, auditWiki } from "./audit-wiki.js";

const MAX_AUDIT_PAGES_PER_RUN = 10;
const AUDIT_DISPATCH_BATCH_SIZE = 10;

export const scheduledWikiAudit = schedules.task({
  id: "scheduled-wiki-audit",
  cron: "0 3 * * *",
  queue: { concurrencyLimit: 1 },
  ttl: "30m",
  maxDuration: 1_800,
  run: async (payload, { ctx }) => {
    const api = new ContextWikiApiClient();
    const timestamp = payload.timestamp.toISOString();
    let cursor: string | undefined;
    let dispatched = 0;
    let pages = 0;

    do {
      const due = await api.getDueAudits({
        cursor,
        limit: MAX_AUDITS_PER_DUE_PAGE,
        timestamp,
        scheduleId: payload.scheduleId
      });
      pages += 1;
      for (let offset = 0; offset < due.audits.length; offset += AUDIT_DISPATCH_BATCH_SIZE) {
        const auditBatch = due.audits.slice(offset, offset + AUDIT_DISPATCH_BATCH_SIZE);
        await batch.trigger<typeof auditWiki>(
          auditBatch.map((audit) => ({
            id: "audit-wiki" as const,
            payload: audit,
            options: {
              idempotencyKey: `wiki-audit:${audit.request.auditInputDigest}`,
              tags: hashedAuditTags(audit),
              ttl: "2h"
            }
          }))
        );
        dispatched += auditBatch.length;
      }
      cursor = due.nextCursor;
    } while (cursor && pages < MAX_AUDIT_PAGES_PER_RUN);

    logger.info("scheduled_wiki_audit_dispatched", {
      trigger_run_id: ctx.run.id,
      schedule_id: payload.scheduleId,
      pages,
      dispatched,
      truncated: cursor !== undefined
    });
    return {
      status: "completed" as const,
      pages,
      dispatched,
      truncated: cursor !== undefined,
      ...(cursor ? { nextCursor: cursor } : {})
    };
  }
});
