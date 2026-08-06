/**
 * Maps a status string onto one of the theme's four tones.
 *
 * The admin tables render statuses as bare text, and CSS cannot match on text
 * content — so a failed build looked exactly like a completed one. The cells
 * carry the result of this as a `data-tone` attribute, which globals.css styles.
 *
 * Unrecognised values deliberately return `undefined` rather than a default
 * tone: on an operations page, colouring an unknown status as healthy is worse
 * than leaving it neutral.
 */
export type StatusTone = "ok" | "warn" | "bad" | "info";

const TONES: ReadonlyMap<string, StatusTone> = new Map([
  ["complete", "ok"],
  ["completed", "ok"],
  ["published", "ok"],
  ["healthy", "ok"],
  ["ready", "ok"],
  ["current", "ok"],
  ["succeeded", "ok"],
  ["active", "info"],
  ["running", "info"],
  ["in_progress", "info"],
  ["building", "info"],
  ["queued", "warn"],
  ["pending", "warn"],
  ["partial", "warn"],
  ["degraded", "warn"],
  ["stale", "warn"],
  ["superseded", "warn"],
  ["failed", "bad"],
  ["error", "bad"],
  ["cancelled", "bad"],
  ["canceled", "bad"],
  ["unknown", "bad"]
]);

export function statusTone(value: string | null | undefined): StatusTone | undefined {
  if (!value) return undefined;
  return TONES.get(value.trim().toLowerCase());
}
