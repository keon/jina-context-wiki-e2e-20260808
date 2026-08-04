import { logger, schedules } from "@trigger.dev/sdk";
import { postInternal } from "../shared/api.js";
import { errorMessage } from "../shared/utils.js";

export const scheduledReviewScan = schedules.task({
  id: "scheduled-review-scan",
  cron: "*/30 * * * *",
  queue: {
    concurrencyLimit: 1,
  },
  ttl: "10m",
  maxDuration: 600,
  run: async (payload, { ctx }) => {
    const startedAt = Date.now();
    logger.info("scheduled_review_scan_started", {
      trigger_run_id: ctx.run.id,
      timestamp: payload.timestamp,
      last_timestamp: payload.lastTimestamp,
      timezone: payload.timezone,
      schedule_id: payload.scheduleId,
      external_id: payload.externalId,
    });

    try {
      const response = await postInternal("/internal/scheduled-review-scan", {
        trigger_run_id: ctx.run.id,
        payload: {
          timestamp: payload.timestamp.toISOString(),
          last_timestamp: payload.lastTimestamp?.toISOString(),
          timezone: payload.timezone,
          schedule_id: payload.scheduleId,
          external_id: payload.externalId,
        },
      });

      logger.info("scheduled_review_scan_completed", {
        trigger_run_id: ctx.run.id,
        duration_ms: Date.now() - startedAt,
      });
      return response;
    } catch (error) {
      logger.warn("scheduled_review_scan_failed", {
        trigger_run_id: ctx.run.id,
        duration_ms: Date.now() - startedAt,
        error: errorMessage(error),
      });
      throw error;
    }
  },
});
