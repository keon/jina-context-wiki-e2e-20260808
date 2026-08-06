import * as React from "react";
import type { ReactNode } from "react";
import styles from "./badge.module.css";
import { cx, type ToneInput } from "./tone.ts";

/**
 * A short status or fact chip.
 *
 * `data-ui` and `data-tone` are the query contract. The class names are hashed
 * by the bundler, so a test — or anything else outside this file — cannot target
 * them, and should not: they are this component's private business.
 */
export function Badge({ tone = "", children }: { tone?: ToneInput; children: ReactNode }) {
  return (
    <span className={cx(styles.badge, tone && styles[tone])} data-ui="badge" data-tone={tone || undefined}>
      {children}
    </span>
  );
}
