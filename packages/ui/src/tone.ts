/**
 * The four status tones the theme defines, plus the neutral absence of one.
 *
 * Deliberately not a status → tone mapping: the two apps disagree about what a
 * status means. The dashboard reads substrings ("…fail…" is bad), admin reads an
 * exact allowlist and returns `undefined` for anything it has not seen, because
 * on an operations page colouring an unknown status as healthy is worse than
 * leaving it neutral. Both mappings stay in their apps; the shared components
 * take the tone already decided.
 */
export type Tone = "ok" | "warn" | "bad" | "info";

/** What a caller may hand a toned component: a tone, or nothing. */
export type ToneInput = Tone | "" | undefined;

/**
 * Joins class names, dropping anything falsy.
 *
 * A CSS Modules lookup is `string | undefined` — a class the stylesheet does not
 * define is absent, not the text "undefined" — so composition has to filter
 * rather than interpolate.
 */
export function cx(...values: readonly (string | false | null | undefined)[]): string {
  return values.filter((value): value is string => Boolean(value)).join(" ");
}
