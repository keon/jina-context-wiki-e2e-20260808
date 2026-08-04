export type CompletionPollingHost = {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(timer: number): void;
  visible(): boolean;
  onAttention(callback: () => void): () => void;
};

export type CompletionPoll = {
  runNow(): void;
  stop(): void;
};

/**
 * Poll only after the previous request settles. Hidden tabs pause completely;
 * returning to or focusing the page refreshes immediately without overlap.
 */
export function startCompletionPolling(
  task: () => Promise<unknown>,
  intervalMs: number,
  options: { immediate?: boolean; host?: CompletionPollingHost } = {},
): CompletionPoll {
  const host = options.host ?? browserPollingHost();
  let stopped = false;
  let running = false;
  let timer: number | undefined;

  const clearTimer = () => {
    if (timer === undefined) return;
    host.clearTimeout(timer);
    timer = undefined;
  };

  const schedule = () => {
    if (stopped || running || timer !== undefined || !host.visible()) return;
    timer = host.setTimeout(() => {
      timer = undefined;
      void run();
    }, intervalMs);
  };

  const run = async () => {
    if (stopped || running || !host.visible()) return;
    clearTimer();
    running = true;
    try {
      await task();
    } catch {
      // Request-specific code owns error presentation. A transient rejection
      // must not stop future refreshes or become an unhandled promise.
    } finally {
      running = false;
      schedule();
    }
  };

  const onAttention = () => {
    if (!host.visible()) {
      clearTimer();
      return;
    }
    void run();
  };
  const unsubscribe = host.onAttention(onAttention);

  if (options.immediate === false) {
    schedule();
  } else {
    void run();
  }

  return {
    runNow: () => void run(),
    stop: () => {
      stopped = true;
      clearTimer();
      unsubscribe();
    },
  };
}

function browserPollingHost(): CompletionPollingHost {
  return {
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (timer) => window.clearTimeout(timer),
    visible: () => document.visibilityState !== "hidden",
    onAttention: (callback) => {
      document.addEventListener("visibilitychange", callback);
      window.addEventListener("focus", callback);
      return () => {
        document.removeEventListener("visibilitychange", callback);
        window.removeEventListener("focus", callback);
      };
    },
  };
}
