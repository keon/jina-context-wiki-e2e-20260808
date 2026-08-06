import * as React from "react";
import type { ReactNode } from "react";
import styles from "./empty-state.module.css";
import { cx } from "./tone.ts";

/**
 * States that a read succeeded and found nothing.
 *
 * Never render this for a read that failed — that is what `ErrorState` is for,
 * and the two look different on purpose. Reporting an outage as an empty result
 * is how a monitoring page hides one.
 *
 * `className` is the app's own layout hook (margins, grid placement). The
 * component keeps its appearance; the page keeps its composition.
 */
export function EmptyState({
  compact = false,
  className,
  role,
  children
}: {
  compact?: boolean | undefined;
  className?: string | undefined;
  role?: "status" | undefined;
  children: ReactNode;
}) {
  return (
    <div className={cx(styles.empty, compact && styles.compact, className)} data-ui="empty-state" role={role}>
      {children}
    </div>
  );
}
