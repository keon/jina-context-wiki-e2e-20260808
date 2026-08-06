import assert from "node:assert/strict";
import { afterEach } from "node:test";
import { cleanup, render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";

/**
 * Rendering primitives and shared assertions for admin component tests. See
 * `setup.ts` for the bootstrap this relies on.
 *
 * NOTE: `stubFetch`, `jsonResponse` and `assertNoLeakedValues` are the same code
 * as `apps/dashboard/src/testing/render.tsx`. They are app-agnostic and should
 * move into a shared testing package rather than being maintained twice.
 */

const realFetch = globalThis.fetch;
const realConsoleError = console.error;
const realConsoleWarn = console.warn;

// The runner gives each test file its own process, so one registration here
// covers every test in the file that imports this module. Without it a rendered
// tree stays in `document.body` and the next test's queries see both.
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
  console.warn = realConsoleWarn;
  document.body.innerHTML = "";
});

export function renderComponent(ui: ReactElement): RenderResult {
  return render(ui);
}

/* ------------------------------------------------------------------ queries --- */

/**
 * Query helpers that answer in primitives.
 *
 * Never let a DOM node become an assertion operand. `node:test` serializes an
 * AssertionError's `actual`/`expected` into its diagnostic, and a happy-dom
 * element's object graph reaches its document, its window, and everything
 * either of those holds: the runner spends half a minute walking it and is then
 * killed by the OS. The test reports "test failed" with no message — precisely
 * when the message is the only thing you wanted. So assertions here take counts,
 * booleans, strings and attribute values.
 */

export function count(root: ParentNode, selector: string): number {
  return root.querySelectorAll(selector).length;
}

/** Whether the render contains `selector` at all. */
export function present(root: ParentNode, selector: string): boolean {
  return root.querySelector(selector) !== null;
}

/** `textContent` of the first match, or "" when there is none. */
export function textOf(root: ParentNode, selector: string): string {
  return root.querySelector(selector)?.textContent ?? "";
}

/** An attribute of the first match; null when the element or attribute is absent. */
export function attrOf(root: ParentNode, selector: string, name: string): string | null {
  return root.querySelector(selector)?.getAttribute(name) ?? null;
}

/* -------------------------------------------------------------------- fetch --- */

/**
 * Answers every request from the test rather than the network, and records what
 * was asked for. Restored after each test. A page that read an endpoint it
 * should not have read shows up as an unexpected entry in `requests`.
 */
export function stubFetch(respond: (url: string) => Response | Promise<Response>): { requests: string[] } {
  const requests: string[] = [];
  globalThis.fetch = (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    return Promise.resolve(respond(url));
  };
  return { requests };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * Collects the server-side log instead of printing it.
 *
 * The page deliberately writes every failed section to `console.error` — that
 * record is the only way an operator tells an API outage from a credential
 * misconfiguration — so a test that exercises a failure would otherwise bury the
 * runner's output in stack traces. Returned so the log can be asserted on rather
 * than merely silenced.
 */
export function captureConsole(): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  return { errors, warnings };
}

/* ------------------------------------------------------------- placeholders --- */

/**
 * Strings that are a formatter's internal state escaping into the page rather
 * than anything a reader asked for.
 */
const LEAKED_VALUES: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\bundefined\b/i, label: "undefined" },
  { pattern: /\bNaN\b/, label: "NaN" },
  { pattern: /Invalid Date/i, label: "Invalid Date" },
  { pattern: /\[object Object\]/, label: "[object Object]" }
];

/** Attributes a reader is exposed to, as text, the same as element content. */
const READABLE_ATTRIBUTES = ["title", "aria-label", "alt"];

/**
 * Fails when the render contains a formatter's fallback string anywhere a
 * reader would see it. The absence sentinels this app uses on purpose ("—",
 * "unresolved", "not recorded", "not sampled") all pass; only the accidental
 * ones do not.
 */
export function assertNoLeakedValues(container: HTMLElement, subject: string): void {
  const offences: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3 /* text */) {
      const text = node.nodeValue ?? "";
      for (const { pattern, label } of LEAKED_VALUES) {
        if (pattern.test(text)) offences.push(`${label} in text ${JSON.stringify(text.trim())}`);
      }
      return;
    }
    if (node.nodeType !== 1 /* element */) return;
    const element = node as Element;
    for (const attribute of READABLE_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      for (const { pattern, label } of LEAKED_VALUES) {
        if (pattern.test(value)) offences.push(`${label} in ${attribute}=${JSON.stringify(value)}`);
      }
    }
    for (const child of Array.from(element.childNodes)) walk(child);
  };
  walk(container);
  assert.deepEqual(
    offences,
    [],
    `${subject} rendered a formatter placeholder to the reader:\n  ${offences.join("\n  ")}`
  );
}
