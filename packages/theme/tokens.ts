/**
 * The palette, as data.
 *
 * `theme.css` is the source every stylesheet reads through `var(--token)`.
 * A few consumers cannot go through CSS — Clerk's `appearance.variables`, for
 * one, performs colour math on the values it is given and so needs literals
 * rather than `var()` references. Those consumers import from here instead of
 * embedding hex codes at the call site, which is what let the two apps drift
 * apart in the first place.
 *
 * `tokens.test.ts` asserts that every value below is the one `theme.css`
 * publishes for the same token, so the two cannot diverge silently.
 */

export const themeTokens = {
  canvas: "#08090a",
  surface: "#101113",
  surfaceRaised: "#16181a",
  surfaceInset: "#050506",
  line: "rgba(255, 255, 255, 0.09)",
  ink: "#e3e4e6",
  inkStrong: "#f7f8f8",
  inkSubtle: "#6f737b",
  accent: "#5e6ad2",
  accentFg: "#ffffff",
  radius: "6px"
} as const;

export type ThemeTokenName = keyof typeof themeTokens;
