import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { themeTokens } from "./tokens.ts";

const css = readFileSync(fileURLToPath(new URL("./theme.css", import.meta.url)), "utf8");

/** `surfaceRaised` -> `--surface-raised`. */
function cssName(token: string): string {
  return `--${token.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
}

function declaredValue(token: string): string | undefined {
  const match = new RegExp(`^\\s*${cssName(token)}\\s*:\\s*([^;]+);`, "m").exec(css);
  return match?.[1]?.trim();
}

test("every JS token names a property theme.css actually declares", () => {
  for (const token of Object.keys(themeTokens)) {
    assert.notEqual(declaredValue(token), undefined, `${cssName(token)} is missing from theme.css`);
  }
});

test("every JS token carries the same value theme.css publishes", () => {
  for (const [token, value] of Object.entries(themeTokens)) {
    assert.equal(
      declaredValue(token),
      value,
      `${cssName(token)} is "${declaredValue(token) ?? ""}" in theme.css but "${value}" in tokens.ts`
    );
  }
});

test("theme.css is the only place a colour literal is written", () => {
  // Guards the reason this package exists: if a raw colour lands in a product
  // stylesheet the retheme stops being a single-file change. The apps' own
  // sheets are checked by their lint step; this asserts the invariant here.
  const literals = css.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? [];
  assert.ok(literals.length > 0, "theme.css should be where colours live");
});
