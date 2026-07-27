"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { reportConnection } from "./connection.ts";

const POLL_INTERVAL_MS = 2500;

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

export async function fetchCursorPages<T>(
  path: string,
  collection: string,
  fetchImpl: typeof fetch = fetch
): Promise<T> {
  const values: unknown[] = [];
  const seenCursors = new Set<string>();
  let firstPage: Record<string, unknown> | undefined;
  let cursor: string | undefined;
  for (let page = 0; page < 10_000; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const pagePath = cursor ? `${path}${separator}cursor=${encodeURIComponent(cursor)}` : path;
    const response = await fetchImpl(pagePath, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`request failed with ${response.status}`);
    const payload = (await response.json()) as Record<string, unknown>;
    firstPage ??= payload;
    const items = payload[collection];
    if (!Array.isArray(items)) throw new Error(`response omitted ${collection}`);
    for (const item of items as unknown[]) values.push(item);
    const nextCursor = typeof payload.nextCursor === "string" ? payload.nextCursor.trim() : "";
    if (!nextCursor) {
      return { ...firstPage, [collection]: values, nextCursor: undefined } as T;
    }
    if (seenCursors.has(nextCursor)) throw new Error(`response repeated a pagination cursor for ${path}`);
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error(`pagination exceeded the safety limit for ${path}`);
}

export function useCursorPoll<T>(path: string, collection: string, intervalMs: number = POLL_INTERVAL_MS) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [online, setOnline] = useState<boolean | undefined>(undefined);
  const lastBody = useRef<string | undefined>(undefined);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const body = JSON.stringify(await fetchCursorPages<T>(path, collection));
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
  }, [collection, path]);

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
