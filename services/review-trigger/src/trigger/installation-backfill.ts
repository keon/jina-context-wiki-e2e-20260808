import { logger, task } from "@trigger.dev/sdk";
import { postInternal } from "../shared/api.js";
import { errorMessage } from "../shared/utils.js";

type InstallationBackfillPayload = {
  delivery_id: string;
  source_event: "installation" | "installation_repositories";
  action: string;
  github_installation_id: number;
  account?: {
    github_account_id?: number;
    login?: string;
    type?: string;
  };
  /** The admin who performed the install (webhook sender) — forwarded so the API can grant them the org
   *  tenant membership even when OAuth App restrictions hide the org from /user/orgs. */
  sender?: {
    github_user_id?: number;
    login?: string;
  };
  repositories?: unknown[];
  repositories_added?: unknown[];
  repositories_removed?: unknown[];
  trigger: "webhook";
};

export function requireBackfillResponse(value: unknown): { ok: true; customer_provisioned: boolean } {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).ok !== true ||
    typeof (value as Record<string, unknown>).customer_provisioned !== "boolean"
  ) {
    throw new Error("installation backfill returned an invalid provisioning result");
  }
  return value as { ok: true; customer_provisioned: boolean };
}

export const githubInstallationBackfill = task({
  id: "github-installation-backfill",
  queue: {
    concurrencyLimit: 5,
  },
  retry: {
    maxAttempts: 5,
    factor: 2,
    minTimeoutInMs: 2_000,
    maxTimeoutInMs: 60_000,
    randomize: true,
  },
  machine: {
    preset: "small-1x",
  },
  maxDuration: 7_200,
  run: async (payload: InstallationBackfillPayload, { ctx }) => {
    const startedAt = Date.now();
    logger.info("github_installation_backfill_started", {
      trigger_run_id: ctx.run.id,
      delivery_id: payload.delivery_id,
      installation_id: payload.github_installation_id,
      action: payload.action,
      source_event: payload.source_event,
      account_login: payload.account?.login,
      repository_count: payload.repositories?.length,
      repositories_added_count: payload.repositories_added?.length,
      repositories_removed_count: payload.repositories_removed?.length,
    });

    try {
      const result = requireBackfillResponse(await postInternal<unknown>("/internal/installations/backfill", {
        trigger_run_id: ctx.run.id,
        payload,
      }));

      logger.info("github_installation_backfill_completed", {
        trigger_run_id: ctx.run.id,
        delivery_id: payload.delivery_id,
        installation_id: payload.github_installation_id,
        customer_provisioned: result.customer_provisioned,
        duration_ms: Date.now() - startedAt,
      });

      return {
        status: "completed",
        github_installation_id: payload.github_installation_id,
        customer_provisioned: result.customer_provisioned,
      };
    } catch (error) {
      logger.warn("github_installation_backfill_failed", {
        trigger_run_id: ctx.run.id,
        delivery_id: payload.delivery_id,
        installation_id: payload.github_installation_id,
        duration_ms: Date.now() - startedAt,
        error: errorMessage(error),
      });
      throw error;
    }
  },
});
