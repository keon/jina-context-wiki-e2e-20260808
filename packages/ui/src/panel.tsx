import * as React from "react";
import type { ReactNode } from "react";
import styles from "./panel.module.css";

export function Panel({
  title,
  count,
  actions,
  children
}: {
  title: string;
  count?: number | undefined;
  actions?: ReactNode | undefined;
  children: ReactNode;
}) {
  return (
    <section className={styles.panel} data-ui="panel">
      <div className={styles.head} data-ui="panel-head">
        <span className={styles.title} data-ui="panel-title">
          {title}
        </span>
        {count !== undefined ? (
          <span className={styles.count} data-ui="panel-count">
            {count}
          </span>
        ) : null}
        {actions ? (
          <span className={styles.actions} data-ui="panel-actions">
            {actions}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * The panel's count chip, for a heading a caller assembles itself rather than
 * through `Panel` — a `<details>` summary, a section title with its own layout.
 * Exported so those callers do not reach for a raw class to get the same figure.
 */
export function PanelCount({ children }: { children: ReactNode }) {
  return (
    <span className={styles.count} data-ui="panel-count">
      {children}
    </span>
  );
}
