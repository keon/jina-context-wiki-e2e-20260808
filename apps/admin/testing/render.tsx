import { afterEach } from "node:test";

/**
 * Admin's component-test harness.
 *
 * The rendering primitives and the shared assertions now live in
 * `@jina/ui/testing` — they were identical here and in the dashboard, and both
 * copies said so. Only what admin genuinely owns is left: the console capture
 * this app's pages need, because they deliberately write every failed section
 * to the server log.
 */

export {
  assertNoLeakedValues,
  attrOf,
  count,
  jsonResponse,
  present,
  renderComponent,
  stubFetch,
  textOf
} from "@jina/ui/testing";

const realConsoleError = console.error;
const realConsoleWarn = console.warn;

// The shared harness registers its own `afterEach` for the render tree and
// `fetch`; this restores what only admin replaces.
afterEach(() => {
  console.error = realConsoleError;
  console.warn = realConsoleWarn;
});

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
