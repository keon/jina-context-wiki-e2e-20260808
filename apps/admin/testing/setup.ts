/**
 * Test bootstrap for React render tests, loaded with `node --import` so both
 * halves are in place *before* any test file — and therefore before React DOM —
 * is evaluated:
 *
 *   1. A DOM on the globals React DOM binds at import time (`document`,
 *      `window`, `Node`, `HTMLElement`, …).
 *   2. The module-resolution hook that swaps `next/link` for a local double, so
 *      a component can be rendered without a Next server.
 *
 * happy-dom rather than jsdom, matching the dashboard: it is a fraction of the
 * install and boots in single-digit milliseconds, which matters when the runner
 * starts one process per test file on every CI push. It implements everything
 * these tests touch. jsdom's extra fidelity buys nothing here — no assertion in
 * this suite reads computed geometry.
 */

import { register } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });

// React uses this to decide whether `act()` is required around updates; without
// it every state update warns and update batching differs from the browser.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// `adminApiHeaders` throws when a token is configured without a principal, which
// would turn every section into a failed read for reasons that have nothing to
// do with the test. Pin the credential environment so a developer's shell cannot
// change what these tests exercise; every request is answered by `stubFetch`.
process.env.INTERNAL_API_TOKEN = "";
process.env.JINA_TENANT_ID = "";
process.env.JINA_WEB_PRINCIPAL_ID = "";
process.env.JINA_API_URL = "http://jina-api.test";

register("./module-stubs.mjs", import.meta.url, {
  data: {
    specifiers: {
      "next/link": new URL("./stubs/next-link.tsx", import.meta.url).href
    },
    paths: {}
  }
});
