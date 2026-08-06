import * as React from "react";
import type { ReactNode } from "react";
import styles from "./detail-header.module.css";
import type { LinkComponent } from "./list.tsx";

export function DetailHeader({
  kicker,
  title,
  badges,
  actions
}: {
  kicker?: ReactNode | undefined;
  title: ReactNode;
  badges?: ReactNode | undefined;
  actions?: ReactNode | undefined;
}) {
  return (
    <header className={styles.header} data-ui="detail-header">
      <div className={styles.heading}>
        {kicker !== undefined ? (
          <div className={styles.kicker} data-ui="detail-kicker">
            {kicker}
          </div>
        ) : null}
        <h1 className={styles.title} data-ui="detail-title">
          {title}
        </h1>
        {badges !== undefined ? (
          <div className={styles.badges} data-ui="detail-badges">
            {badges}
          </div>
        ) : null}
      </div>
      {actions !== undefined ? (
        <div className={styles.actions} data-ui="detail-actions">
          {actions}
        </div>
      ) : null}
    </header>
  );
}

/**
 * "← back to somewhere". Takes the app's router-aware `Link` for the same reason
 * `Row` does — see `LinkComponent`.
 */
export function BackLink({
  href,
  linkComponent: Link,
  children
}: {
  href: string;
  linkComponent?: LinkComponent | undefined;
  children: ReactNode;
}) {
  const inner = <>← {children}</>;
  if (Link) {
    return (
      <Link className={styles.back} href={href} data-ui="back-link">
        {inner}
      </Link>
    );
  }
  return (
    <a className={styles.back} href={href} data-ui="back-link">
      {inner}
    </a>
  );
}
