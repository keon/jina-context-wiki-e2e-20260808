"use client";

import * as React from "react";
import type { ComponentType, KeyboardEventHandler, MouseEventHandler, ReactNode } from "react";
import styles from "./list.module.css";
import { cx } from "./tone.ts";

/**
 * The router-aware anchor a `Row` or `BackLink` should render for an internal
 * href.
 *
 * Passed in rather than imported: this package has no Next dependency, and
 * hard-coding a plain `<a>` would turn every client-side navigation in the
 * dashboard into a full document load. `next/link`'s props are a superset of
 * this, so an app hands over its own `Link` unchanged.
 */
export type LinkComponent = ComponentType<{
  href: string;
  className?: string | undefined;
  "data-ui"?: string | undefined;
  children: ReactNode;
}>;

export function List({ children }: { children: ReactNode }) {
  return (
    <div className={styles.list} data-ui="list">
      {children}
    </div>
  );
}

export function Row({
  href,
  linkComponent: Link,
  onClick,
  leading,
  title,
  meta,
  trailing
}: {
  href?: string | undefined;
  /** Required alongside `href`; without it the row falls back to a plain anchor. */
  linkComponent?: LinkComponent | undefined;
  onClick?: MouseEventHandler | undefined;
  leading?: ReactNode | undefined;
  title: ReactNode;
  meta?: ReactNode | undefined;
  trailing?: ReactNode | undefined;
}) {
  const interactive = Boolean(href || onClick);
  const className = cx(styles.row, interactive && styles.link);
  const inner = (
    <>
      {leading !== undefined ? (
        <span className={styles.lead} data-ui="row-lead">
          {leading}
        </span>
      ) : null}
      <span className={styles.main} data-ui="row-main">
        <span className={styles.title} data-ui="row-title">
          {title}
        </span>
        {meta !== undefined ? (
          <span className={styles.meta} data-ui="row-meta">
            {meta}
          </span>
        ) : null}
      </span>
      {trailing !== undefined ? (
        <span className={styles.trail} data-ui="row-trail">
          {trailing}
        </span>
      ) : null}
    </>
  );

  if (href) {
    if (Link) {
      return (
        <Link className={className} href={href} data-ui="row">
          {inner}
        </Link>
      );
    }
    return (
      <a className={className} href={href} data-ui="row">
        {inner}
      </a>
    );
  }
  const onKeyDown: KeyboardEventHandler | undefined = onClick
    ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick(event as unknown as Parameters<MouseEventHandler>[0]);
        }
      }
    : undefined;
  return (
    <div
      className={className}
      data-ui="row"
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onKeyDown}
    >
      {inner}
    </div>
  );
}
