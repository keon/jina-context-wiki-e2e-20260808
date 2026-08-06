/**
 * Test bootstrap for React render tests, loaded with `node --import` so both
 * halves are in place *before* any test file — and therefore before React DOM —
 * is evaluated:
 *
 *   1. A DOM on the globals React DOM binds at import time (`document`,
 *      `window`, `Node`, `HTMLElement`, …).
 *   2. The module-resolution hook that swaps `next/link`, `next/navigation`,
 *      `@clerk/nextjs` and the dashboard providers for local doubles, and
 *      answers the `*.module.css` imports the `@jina/ui` primitives make, so a
 *      component can be rendered without a Next server, Clerk credentials or a
 *      bundler.
 *
 * The hook and the `next/link` double are `@jina/ui`'s; the rest of the map is
 * this app's, because only this app knows what its own components import.
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
import { NEXT_LINK_STUB } from "@jina/ui/testing/stubs";

GlobalRegistrator.register({ url: "http://localhost/" });

// React uses this to decide whether `act()` is required around updates; without
// it every state update warns and update batching differs from the browser.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stub = (path: string) => new URL(path, import.meta.url).href;

register("@jina/ui/testing/module-stubs.mjs", import.meta.url, {
  data: {
    specifiers: {
      "next/link": NEXT_LINK_STUB,
      "next/navigation": stub("./stubs/next-navigation.ts"),
      "@clerk/nextjs": stub("./stubs/clerk.tsx"),
      "@clerk/nextjs/errors": stub("./stubs/clerk-errors.ts")
    },
    paths: {
      [new URL("../dashboard/providers.tsx", import.meta.url).href]: stub("./stubs/dashboard-providers.tsx")
    }
  }
});
