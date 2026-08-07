import * as React from "react";
import type { ReactNode } from "react";
import styles from "./stat.module.css";
import { cx } from "./tone.ts";

/**
 * A number the source never reported.
 *
 * It renders as an em dash and never as `0`, because a zero on an operations
 * page is a measurement: a reader who sees "0 backlog" or "0 active builds"
 * takes it as evidence that nothing is wrong. The dash is decorative and the
 * accessible name carries the meaning, so the distinction survives for a screen
 * reader too.
 */
export function Unmeasured({ title }: { title: string }) {
  return (
    <span className={styles.unmeasured} data-ui="unmeasured" title={title}>
      <span aria-hidden="true">—</span>
      <span className={styles.srOnly}>Unavailable</span>
    </span>
  );
}

/** The responsive grid a row of `Stat`s sits in. */
export function StatRow({ children }: { children: ReactNode }) {
  return (
    <div className={styles.row} data-ui="stat-row">
      {children}
    </div>
  );
}

/**
 * One labelled figure.
 *
 * `value` is `number | undefined`, and `undefined` is load-bearing: it means the
 * figure was not measured, and renders as `Unmeasured` rather than as `0`. A
 * caller with a genuine zero passes `0`. This was a shipped review finding —
 * absent quota telemetry rendered as idle capacity — so the sentinel lives here
 * rather than at each of the eight call sites.
 */
export function Stat({
  label,
  value,
  unmeasuredTitle = "Not measured: this value was not reported, and is not zero"
}: {
  label: ReactNode;
  value: number | undefined;
  unmeasuredTitle?: string | undefined;
}) {
  const measured = value !== undefined;
  return (
    <div className={cx(styles.stat, !measured && styles.unknown)} data-ui="stat" data-measured={String(measured)}>
      <div className={styles.value} data-ui="stat-value">
        {measured ? value.toLocaleString("en-US") : <Unmeasured title={unmeasuredTitle} />}
      </div>
      <div className={styles.label} data-ui="stat-label">
        {label}
      </div>
    </div>
  );
}
