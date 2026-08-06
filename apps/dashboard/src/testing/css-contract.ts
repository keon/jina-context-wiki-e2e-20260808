import { readFileSync } from "node:fs";

/**
 * Reads layout contracts out of the real stylesheet.
 *
 * A CSS grid with an explicit track list is a promise about the markup: the
 * component has to emit the items the lanes were cut for. Nothing enforced that,
 * which is how `.codex-step` came to declare `28px minmax(0, 1fr) auto` against a
 * component that emitted a single wrapper div (everything landed in the 28px
 * lane), and `.trail__row` came to declare two tracks against the four children
 * `TrailRow` emits (every simulation step folded into a ~20px ribbon).
 *
 * The track counts are parsed from the stylesheet rather than restated here on
 * purpose: a test that hard-codes "3" only proves the test agrees with itself.
 * Reading the declaration means editing either side — CSS or markup — without
 * the other is what fails.
 *
 * Only top-level rules with a single-class selector are collected. Media-query
 * overrides are reflows of the same content and descendant selectors cannot be
 * matched from a class list alone, so both are out of scope.
 */

export interface GridContract {
  /** Number of explicit column tracks the stylesheet cuts for this class. */
  readonly tracks: number;
  /** The declaration as written, for failure messages. */
  readonly declaration: string;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Splits a value on top-level whitespace, so `minmax(0, 1fr)` stays one track. */
function splitTracks(value: string): string[] {
  const tracks: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0 && /\s/.test(char)) {
      if (current) tracks.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tracks.push(current);
  // `[line-name]` entries name a grid line rather than occupying a track.
  return tracks.filter((track) => !track.startsWith("["));
}

/**
 * The number of tracks a value declares, or null when the count is not fixed —
 * `repeat(auto-fill, …)` and friends size themselves to the content, which is
 * exactly the case where item count is not a contract.
 */
function countTracks(value: string): number | null {
  const normalized = value.trim();
  if (!normalized || /^(none|subgrid|inherit|initial|unset)$/i.test(normalized)) return null;
  if (/repeat\s*\(/i.test(normalized)) return null;
  const tracks = splitTracks(normalized);
  return tracks.length > 0 ? tracks.length : null;
}

interface RuleDeclarations {
  display?: string;
  gridTemplateColumns?: string;
}

function readDeclaration(body: string, property: string): string | undefined {
  const pattern = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i");
  const match = pattern.exec(body);
  return match ? match[1]!.trim() : undefined;
}

const SINGLE_CLASS = /^\.[A-Za-z_][\w-]*$/;

/** Collects `class -> declarations` for every top-level single-class rule. */
function collectClassRules(css: string): Map<string, RuleDeclarations> {
  const source = stripComments(css);
  const byClass = new Map<string, RuleDeclarations>();
  let index = 0;
  let selectorStart = 0;

  while (index < source.length) {
    if (source[index] !== "{") {
      index += 1;
      continue;
    }
    const selector = source.slice(selectorStart, index).trim();
    // Walk to the matching close brace, so nested blocks are skipped whole.
    let depth = 1;
    let cursor = index + 1;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === "{") depth += 1;
      if (source[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    const body = source.slice(index + 1, cursor - 1);
    if (!selector.startsWith("@")) {
      const display = readDeclaration(body, "display");
      const gridTemplateColumns = readDeclaration(body, "grid-template-columns");
      for (const part of selector.split(",")) {
        const trimmed = part.trim();
        if (!SINGLE_CLASS.test(trimmed)) continue;
        const className = trimmed.slice(1);
        const existing = byClass.get(className) ?? {};
        // Later rules win, as the cascade would resolve them at equal specificity.
        if (display !== undefined) existing.display = display;
        if (gridTemplateColumns !== undefined) existing.gridTemplateColumns = gridTemplateColumns;
        byClass.set(className, existing);
      }
    }
    selectorStart = cursor;
    index = cursor;
  }
  return byClass;
}

const cache = new Map<string, ReadonlyMap<string, GridContract>>();

/** `class -> track contract` for every fixed-track grid in a stylesheet. */
export function gridContracts(stylesheetPath: string): ReadonlyMap<string, GridContract> {
  const cached = cache.get(stylesheetPath);
  if (cached) return cached;
  const contracts = new Map<string, GridContract>();
  for (const [className, declarations] of collectClassRules(readFileSync(stylesheetPath, "utf8"))) {
    if (!/^(inline-)?grid$/i.test(declarations.display ?? "")) continue;
    if (declarations.gridTemplateColumns === undefined) continue;
    const tracks = countTracks(declarations.gridTemplateColumns);
    if (tracks === null) continue;
    contracts.set(className, { tracks, declaration: declarations.gridTemplateColumns });
  }
  cache.set(stylesheetPath, contracts);
  return contracts;
}
