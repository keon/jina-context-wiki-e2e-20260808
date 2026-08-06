import { afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import { gridAssertions } from "@jina/ui/testing";
import type { ReactElement, ReactNode } from "react";
import { resetProviderStubs } from "./stubs/dashboard-providers.tsx";

/**
 * The dashboard's component-test harness.
 *
 * The rendering primitives and the shared assertions now live in
 * `@jina/ui/testing` — they were identical here and in admin, and both copies
 * said so. Only what this app genuinely owns is left: the TanStack wrapper, the
 * provider double's reset, and the stylesheet list the grid contracts read.
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

const clients = new Set<QueryClient>();

// The shared harness registers its own `afterEach` for the render tree and
// `fetch`; this tears down what only the dashboard sets up.
afterEach(() => {
  for (const client of clients) {
    client.clear();
    client.unmount();
  }
  clients.clear();
  resetProviderStubs();
});

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

/* ------------------------------------------------------------ grid contract --- */

/**
 * The stylesheets this app's markup is dressed by: `styles.css` dresses the
 * product pages, `globals.css` the operations pages (board, history, task types,
 * context).
 *
 * The shared primitives are not listed. Their grids live in the CSS Modules
 * beside them and are asserted in that package's own suite, where the module and
 * the markup are checked against each other directly.
 */
const STYLESHEETS = ["../dashboard/styles.css", "../app/globals.css"].map((path) =>
  fileURLToPath(new URL(path, import.meta.url))
);

export const { assertGridContracts, assertGridRow } = gridAssertions(STYLESHEETS);
