import assert from "node:assert/strict";
import { test } from "node:test";

import { startCompletionPolling, type CompletionPollingHost } from "./completion-polling";

test("completion polling never overlaps and schedules from completion", async () => {
  const host = fakeHost();
  let calls = 0;
  let finishFirst: (() => void) | undefined;
  const first = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });

  const polling = startCompletionPolling(async () => {
    calls += 1;
    if (calls === 1) await first;
  }, 10_000, { host });

  assert.equal(calls, 1);
  host.attend();
  assert.equal(calls, 1, "focus must not start a second request while one is running");
  assert.equal(host.timerCount(), 0, "the interval starts only after completion");

  finishFirst?.();
  await settle();
  assert.equal(host.timerCount(), 1);

  host.fireNextTimer();
  assert.equal(calls, 2);
  await settle();
  assert.equal(host.timerCount(), 1);

  polling.stop();
  host.fireNextTimer();
  host.attend();
  assert.equal(calls, 2);
});

test("completion polling pauses while hidden and refreshes when visible", async () => {
  const host = fakeHost(false);
  let calls = 0;
  const polling = startCompletionPolling(async () => {
    calls += 1;
  }, 10_000, { host });

  assert.equal(calls, 0);
  assert.equal(host.timerCount(), 0);

  host.setVisible(true);
  host.attend();
  assert.equal(calls, 1);
  await settle();
  assert.equal(host.timerCount(), 1);

  host.setVisible(false);
  host.attend();
  assert.equal(host.timerCount(), 0);
  polling.stop();
});

function fakeHost(initiallyVisible = true): CompletionPollingHost & {
  attend(): void;
  fireNextTimer(): void;
  setVisible(visible: boolean): void;
  timerCount(): number;
} {
  let visible = initiallyVisible;
  let nextTimer = 1;
  let attention: (() => void) | undefined;
  const timers = new Map<number, () => void>();

  return {
    setTimeout(callback) {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(timer) {
      timers.delete(timer);
    },
    visible: () => visible,
    onAttention(callback) {
      attention = callback;
      return () => {
        if (attention === callback) attention = undefined;
      };
    },
    attend: () => attention?.(),
    fireNextTimer() {
      const next = timers.entries().next().value as [number, () => void] | undefined;
      if (!next) return;
      timers.delete(next[0]);
      next[1]();
    },
    setVisible(next) {
      visible = next;
    },
    timerCount: () => timers.size,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
