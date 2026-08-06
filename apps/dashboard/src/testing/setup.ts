/**
 * Test bootstrap for React render tests, loaded with `node --import` so both
 * halves are in place *before* any test file — and therefore before React DOM —
 * is evaluated:
 *
 *   1. A DOM on the globals React DOM binds at import time (`document`,
 *      `window`, `Node`, `HTMLElement`, …).
 *   2. The module-resolution hook that swaps `next/link`, `next/navigation`,
 *      `@clerk/nextjs` and the dashboard providers for local doubles, so a
 *      component can be rendered without a Next server or Clerk credentials.
 *
 * happy-dom rather than jsdom: it is a fraction of the install and boots in
 * single-digit milliseconds, which matters when the runner starts one process
 * per test file on every CI push. It implements everything these tests touch,
 * `<dialog>.showModal()` included. jsdom's extra fidelity (layout-adjacent APIs,
 * a full CSS cascade) buys nothing here — no assertion in this suite reads
 * computed geometry, and the one CSS fact that is asserted is read from the
 * stylesheet source rather than from the DOM.
 */

import { register } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });

// React uses this to decide whether `act()` is required around updates; without
// it every state update warns and update batching differs from the browser.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stub = (path: string) => new URL(path, import.meta.url).href;

register("./module-stubs.mjs", import.meta.url, {
  data: {
    specifiers: {
      "next/link": stub("./stubs/next-link.tsx"),
      "next/navigation": stub("./stubs/next-navigation.ts"),
      "@clerk/nextjs": stub("./stubs/clerk.tsx"),
      "@clerk/nextjs/errors": stub("./stubs/clerk-errors.ts")
    },
    paths: {
      [new URL("../dashboard/providers.tsx", import.meta.url).href]: stub("./stubs/dashboard-providers.tsx")
    }
  }
});
