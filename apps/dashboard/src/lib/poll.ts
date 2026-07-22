"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { reportConnection } from "./connection.ts";

export const POLL_INTERVAL_MS = 2500;

/**
 * Polls a same-origin JSON endpoint. The API tags these responses with ETags,
 * so the browser HTTP cache turns unchanged polls into 304 revalidations; a
 * state update only happens when the serialized payload actually changed.
 * Polling pauses while the tab is hidden and resumes (with an immediate
 * fetch) when it becomes visible again.
 */
export function usePoll<T>(path: string, intervalMs: number = POLL_INTERVAL_MS) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [online, setOnline] = useState<boolean | undefined>(undefined);
  const lastBody = useRef<string | undefined>(undefined);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const response = await fetch(path, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`request failed with ${response.status}`);
      const body = await response.text();
      if (body !== lastBody.current) {
        lastBody.current = body;
        setData(JSON.parse(body) as T);
      }
      setOnline(true);
      reportConnection(true);
    } catch {
      setOnline(false);
      reportConnection(false);
    } finally {
      inFlight.current = false;
    }
  }, [path]);

  useEffect(() => {
    lastBody.current = undefined;
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, intervalMs);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, intervalMs]);

  return { data, online, refresh };
}
