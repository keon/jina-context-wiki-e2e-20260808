import assert from "node:assert/strict";
import { afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { gridContracts, type GridContract } from "./css-contract.ts";
import { resetProviderStubs } from "./stubs/dashboard-providers.tsx";

/**
 * Rendering primitives and the assertions that are worth sharing across
 * component tests. See `setup.ts` for the bootstrap this relies on.
 */

const clients = new Set<QueryClient>();
const realFetch = globalThis.fetch;

// The runner gives each test file its own process, so one registration here
// covers every test in the file that imports this module. Without it a rendered
// tree stays in `document.body` and the next test's queries see both.
afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
    client.unmount();
  }
  clients.clear();
  resetProviderStubs();
  globalThis.fetch = realFetch;
  document.body.innerHTML = "";
});

export function renderComponent(ui: ReactElement): RenderResult {
  return render(ui);
}

/**
 * Renders inside a fresh TanStack client, for components that read through
 * `useQuery` (`usePoll`, the usage reads, the review-run detail read). Retries
 * are off so a failing fetch resolves to its rendered failure state at once
 * instead of after the default backoff schedule.
 */
export function renderWithQueryClient(ui: ReactElement): RenderResult {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false } }
  });
  clients.add(client);
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(ui, { wrapper: Wrapper });
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
 * was asked for. Restored after each test. A component that polls an endpoint it
 * should not have polled shows up as an unexpected entry in `requests`.
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

/* ------------------------------------------------------------- placeholders --- */

/**
 * Strings that are a formatter's internal state escaping into the page rather
 * than anything a reader asked for. Every one of these has shipped: `humanize`
 * of an absent assignee rendered "Undefined"; `new Date(…).toLocaleString()` of
 * an unparseable stamp rendered "Invalid Date".
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
 * reader would see it. The absence sentinels the app uses on purpose ("—", "–",
 * "Not measured", "Unknown date") all pass; only the accidental ones do not.
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

/* ------------------------------------------------------------ grid contract --- */

/**
 * Both of the app's stylesheets: `styles.css` dresses the product pages,
 * `globals.css` the operations pages (board, history, task types, context).
 */
const STYLESHEETS = ["../dashboard/styles.css", "../app/globals.css"].map((path) =>
  fileURLToPath(new URL(path, import.meta.url))
);

function contractFor(className: string): GridContract | undefined {
  for (const stylesheet of STYLESHEETS) {
    const contract = gridContracts(stylesheet).get(className);
    if (contract) return contract;
  }
  return undefined;
}

function elementChildren(element: Element): Element[] {
  return Array.from(element.children);
}

function describe(element: Element): string {
  return `<${element.tagName.toLowerCase()} class="${element.getAttribute("class") ?? ""}">`;
}

/**
 * The general sweep: for every element in the render whose class declares a
 * fixed column track list, the items it emits must fill whole rows.
 *
 * Deliberately the weak form of the contract — a positive multiple, not an exact
 * match — because it is applied blind to every grid a component happens to
 * render, and some of them (a `<dl>` of term/value pairs) legitimately run to
 * several rows. It is still what would have caught `.codex-step`: one child in a
 * three-track grid leaves two lanes empty and squeezes the content into the
 * first. Where the grid really is a single row, pin it with `assertGridRow`.
 *
 * Counts element children only. Generated content (`::before`) is also a grid
 * item, so a class that relies on one has a row of `tracks - 1` children; none of
 * the fixed-track grids here do, and a stylesheet that grows one will say so by
 * failing this rather than by silently drifting.
 */
export function assertGridContracts(container: HTMLElement, subject: string): void {
  const offences: string[] = [];
  const elements = [container, ...Array.from(container.querySelectorAll("*"))];
  for (const element of elements) {
    for (const className of Array.from(element.classList)) {
      const contract = contractFor(className);
      if (!contract) continue;
      const children = elementChildren(element).length;
      if (children > 0 && children % contract.tracks === 0) continue;
      offences.push(
        `.${className} declares ${contract.tracks} tracks (${contract.declaration}) but ${describe(element)} emits ${children} children`
      );
    }
  }
  assert.deepEqual(offences, [], `${subject} broke a grid track contract:\n  ${offences.join("\n  ")}`);
}

/**
 * The exact form, for a class whose layout is one row of named lanes: every
 * element carrying it must emit exactly one child per track. This is the
 * assertion `.trail__row` needed — four children in a two-track grid fills two
 * rows, so the weak sweep above reads it as well-formed while the page shows
 * every step folded in half.
 */
export function assertGridRow(container: HTMLElement, className: string, expected?: number): void {
  const contract = contractFor(className);
  assert.ok(
    contract,
    `.${className} declares no fixed grid-template-columns; the row contract cannot be derived from the stylesheet`
  );
  if (expected !== undefined) {
    assert.equal(
      contract.tracks,
      expected,
      `.${className} is laid out as ${contract.tracks} lanes (${contract.declaration}); the component under test emits ${expected}`
    );
  }
  const elements = Array.from(container.querySelectorAll<HTMLElement>(`.${className}`));
  assert.ok(elements.length > 0, `no .${className} was rendered, so its row contract was not exercised`);
  for (const element of elements) {
    assert.equal(
      elementChildren(element).length,
      contract.tracks,
      `.${className} cuts ${contract.tracks} lanes (${contract.declaration}) but ${describe(element)} emits ${elementChildren(element).length} children`
    );
  }
}
