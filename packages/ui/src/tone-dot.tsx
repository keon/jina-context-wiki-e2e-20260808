"use client";

import * as React from "react";
import { useRef, useState, type ReactNode } from "react";
import styles from "./tone-dot.module.css";
import { cx, type ToneInput } from "./tone.ts";

/**
 * Instant, fixed-positioned tooltip. Positioned with `fixed` so it escapes any
 * ancestor `overflow: hidden` (panels and sections clip their children), and
 * mounted on hover so there is none of the browser's native `title` delay.
 */
export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const show = () => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect) setPos({ x: rect.left + rect.width / 2, y: rect.top });
  };
  const hide = () => setPos(null);

  return (
    <span
      ref={ref}
      className={styles.tooltip}
      data-ui="tooltip"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {pos ? (
        <span className={styles.bubble} data-ui="tooltip-bubble" role="tooltip" style={{ left: pos.x, top: pos.y }}>
          {label}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A bare status indicator: a tone-coloured dot whose label shows on hover.
 *
 * Takes a tone rather than a status — see `tone.ts` for why the status → tone
 * mapping stays in each app.
 */
export function ToneDot({ tone = "", label }: { tone?: ToneInput; label: string }) {
  return (
    <Tooltip label={label}>
      <span
        className={cx(styles.dot, tone && styles[tone])}
        data-ui="tone-dot"
        data-tone={tone || undefined}
        aria-label={label}
        role="img"
      />
    </Tooltip>
  );
}
