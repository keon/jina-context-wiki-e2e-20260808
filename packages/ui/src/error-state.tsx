import * as React from "react";
import type { ReactNode } from "react";
import styles from "./error-state.module.css";
import { cx } from "./tone.ts";

/**
 * States that a read failed, or was never attempted — the counterpart to
 * `EmptyState`, and deliberately not the same shape.
 *
 * The distinction is the whole point of having two components: "No releases have
 * been published" rendered over a failed API call reports an outage as a fact
 * about the tenant's data. Callers pick by what they know, not by what looks
 * tidier.
 *
 * `flush` is for an alert that sits directly inside a bordered card and should
 * span its full width. `role="alert"` is opt-in: a page-level banner announces
 * itself, while one of several per-section notices should not each interrupt.
 */
export function ErrorState({
  title,
  flush = false,
  role,
  className,
  children
}: {
  title: ReactNode;
  flush?: boolean | undefined;
  role?: "alert" | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className={cx(styles.error, flush && styles.flush, className)} data-ui="error-state" role={role}>
      <p className={styles.title} data-ui="error-state-title">
        {title}
      </p>
      {children}
    </div>
  );
}
