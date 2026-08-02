import { logger, schedules } from "@trigger.dev/sdk";
import { postInternal } from "../shared/api.js";
import { errorMessage } from "../shared/utils.js";

type BillingRetryCounts = {
  ok?: boolean;
  usage_billed?: number;
  runs_settled?: number;
  infra_billed?: number;
};

// Drain the API's pending/stale billing events on a fixed cadence. Nothing else
// in the repo invokes POST /internal/billing/retry, so without this schedule
// events only drain on a manual/ops call. A failed tick logs a warning and lets
// the next tick retry -- no task-level retries beyond the schedule cadence.
export const billingRetry = schedules.task({
  id: "billing-retry",
  cron: "*/15 * * * *",
  queue: {
    concurrencyLimit: 1,
  },
  ttl: "10m",
  maxDuration: 600,
  run: async (payload, { ctx }) => {
    const startedAt = Date.now();
    logger.info("billing_retry_started", {
      trigger_run_id: ctx.run.id,
      timestamp: payload.timestamp,
      last_timestamp: payload.lastTimestamp,
      timezone: payload.timezone,
      schedule_id: payload.scheduleId,
      external_id: payload.externalId,
    });

    try {
      const response = await postInternal<BillingRetryCounts>("/internal/billing/retry", {
        trigger_run_id: ctx.run.id,
      });

      logger.info("billing_retry_completed", {
        trigger_run_id: ctx.run.id,
        duration_ms: Date.now() - startedAt,
        usage_billed: response.usage_billed ?? 0,
        runs_settled: response.runs_settled ?? 0,
        infra_billed: response.infra_billed ?? 0,
      });
      return response;
    } catch (error) {
      // Swallow the failure so the schedule stays healthy; the next tick retries.
      logger.warn("billing_retry_failed", {
        trigger_run_id: ctx.run.id,
        duration_ms: Date.now() - startedAt,
        error: errorMessage(error),
      });
      return undefined;
    }
  },
});
