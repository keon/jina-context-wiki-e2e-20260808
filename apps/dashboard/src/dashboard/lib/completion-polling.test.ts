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
  assert.equal(calls, 1, "returning to the tab must not start a second request while one is running");
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

test("the browser host wakes on visibility only, so one alt-tab is one refresh", async () => {
  const documentListeners = new Map<string, () => void>();
  const windowListeners = new Map<string, () => void>();
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousDocument = globals.document;
  const previousWindow = globals.window;
  globals.document = {
    visibilityState: "visible",
    addEventListener: (type: string, listener: () => void) => documentListeners.set(type, listener),
    removeEventListener: (type: string) => documentListeners.delete(type),
  };
  globals.window = {
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    addEventListener: (type: string, listener: () => void) => windowListeners.set(type, listener),
    removeEventListener: (type: string) => windowListeners.delete(type),
  };

  try {
    let calls = 0;
    const polling = startCompletionPolling(async () => {
      calls += 1;
    }, 10_000);
    await settle();
    assert.equal(calls, 1);
    assert.deepEqual([...documentListeners.keys()], ["visibilitychange"]);
    assert.deepEqual(
      [...windowListeners.keys()],
      [],
      "a focus listener doubles every alt-tab: focus and visibilitychange both fire for one return",
    );

    documentListeners.get("visibilitychange")?.();
    await settle();
    assert.equal(calls, 2, "returning to the tab refreshes exactly once");

    polling.stop();
    assert.equal(documentListeners.size, 0, "stop must unsubscribe");
  } finally {
    globals.document = previousDocument;
    globals.window = previousWindow;
  }
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
      const next = timers.entries().next().value;
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
