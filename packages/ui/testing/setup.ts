/**
 * Test bootstrap for this package's own component tests, loaded with
 * `node --import` so both halves are in place *before* any test file — and
 * therefore before React DOM — is evaluated:
 *
 *   1. A DOM on the globals React DOM binds at import time (`document`,
 *      `window`, `Node`, `HTMLElement`, …).
 *   2. The module-resolution hook, which here has one job: answering the
 *      `*.module.css` imports every component in this package makes.
 *
 * Deliberately the thinnest of the three setups. The apps stub `next/link`,
 * `next/navigation` and Clerk because their components import them; nothing
 * here does — routed navigation arrives as a `LinkComponent` prop — so there is
 * nothing to double.
 *
 * happy-dom rather than jsdom: it is a fraction of the install and boots in
 * single-digit milliseconds, which matters when the runner starts one process
 * per test file on every CI push. No assertion in this suite reads computed
 * geometry, so jsdom's extra fidelity buys nothing.
 */

import { register } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });

// React uses this to decide whether `act()` is required around updates; without
// it every state update warns and update batching differs from the browser.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./module-stubs.mjs", import.meta.url, { data: { specifiers: {}, paths: {} } });
