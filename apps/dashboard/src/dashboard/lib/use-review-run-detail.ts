"use client";

import { useEffect, useMemo, useState } from "react";

import { getReviewRun } from "./api";
import { startCompletionPolling } from "./completion-polling";
import { localReviewRun } from "./local-fixture";
import type { ReviewRun } from "./types";
import { useTenant, useTenantFence } from "../providers";

export function useReviewRunDetail(reviewRunId: string, fallback?: ReviewRun) {
  const { selected, ready, legacyReviewMode } = useTenant();
  const isCurrentTenant = useTenantFence();
  const selectedTenantId = selected?.tenantId ?? null;
  const requestReady = ready && (selectedTenantId !== null || legacyReviewMode);
  const [detail, setDetail] = useState<ReviewRun | null | undefined>(undefined);
  const [detailTenantId, setDetailTenantId] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!requestReady) {
      setDetail(undefined);
      setLoading(true);
      return;
    }
    const controller = new AbortController();
    let active = true;
    const requestTenantId = selected?.tenantId ?? null;

    async function load(initial: boolean): Promise<void> {
      const localRun = localReviewRun(reviewRunId);
      if (localRun) {
        setDetail(localRun);
        setDetailTenantId(requestTenantId);
        setError(null);
        setLoading(false);
        return;
      }

      if (initial) {
        setLoading(true);
        setDetail(undefined);
        setDetailTenantId(requestTenantId);
      }
      try {
        const run = await getReviewRun(reviewRunId, requestTenantId, controller.signal);
        if (!active || !isCurrentTenant(requestTenantId)) return;
        setDetail(run);
        setDetailTenantId(requestTenantId);
        setError(null);
      } catch (loadError) {
        if (!active || controller.signal.aborted || !isCurrentTenant(requestTenantId)) return;
        // Do not keep either a prior detail response or the list-page fallback visible when an
        // authenticated tenant read fails (including membership revocation).
        setDetail(null);
        setDetailTenantId(requestTenantId);
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (active && initial) {
          setLoading(false);
        }
      }
    }

    let initial = true;
    const polling = startCompletionPolling(async () => {
      const firstLoad = initial;
      initial = false;
      await load(firstLoad);
    }, 10_000);
    return () => {
      active = false;
      polling.stop();
      controller.abort();
    };
  }, [isCurrentTenant, requestReady, reviewRunId, selectedTenantId]);

  const scopedDetail = detailTenantId === selectedTenantId ? detail : undefined;
  const run = scopedDetail === undefined ? fallback : scopedDetail;
  return useMemo(
    () => ({ run, loading: !requestReady || detailTenantId !== selectedTenantId || loading, error, loaded: scopedDetail !== undefined }),
    [run, requestReady, detailTenantId, selectedTenantId, loading, error, scopedDetail],
  );
}
