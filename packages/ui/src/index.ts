/*
 * An ambient wildcard module declaration cannot be `import`ed: it is a script,
 * not a module, and a module file may not declare `"*.module.css"`. This package
 * ships source, so there is no emitted `.d.ts` for a consumer to pick the
 * declaration up from either — the reference below is what carries it into each
 * app's program, and without it `tsc` in the dashboard cannot resolve a single
 * stylesheet import in this package.
 */
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./css-modules.d.ts" />

/**
 * The primitives both web apps render, and the styles that draw them.
 *
 * Two rules make this package worth having rather than a second place to look:
 *
 *   1. A component owns its styles. Every one ships a co-located
 *      `*.module.css`, so a shared component's appearance cannot collide with an
 *      app stylesheet or drift away from its own markup — the failure mode that
 *      produced the Codex modal and `.trail__row` bugs, where a stylesheet-only
 *      rewrite desynced CSS from 46 untouched components. Class names are hashed
 *      by the bundler; nothing outside a component's own file can name them.
 *   2. Colours, spacing, radii and type all come from `@jina/theme` tokens. No
 *      module here contains a hex code, an `rgb()`/`rgba()` literal, a px
 *      radius, or a font-size that restates a scale step.
 *
 * The query contract is `data-ui`, not the class list: a test, an end-to-end
 * selector or an app that needs to find a rendered primitive matches on
 * `[data-ui="stat"]`, which survives the hashing.
 *
 * What is deliberately *not* here: anything that would drag an app's internals
 * across the boundary. The dashboard's `Toolbar` reads its dashboard provider,
 * `ExternalLink` validates through the dashboard's `safeHref`, `StatusDot` maps
 * a status with the dashboard's own rules, and `Section`/`SectionFlush` are
 * entangled with `:has()` opt-outs in the reviews pages. Each stays in the app.
 * The one coupling that *was* worth carrying — routed navigation — is passed in
 * as a prop (`LinkComponent`) rather than imported, so this package has no Next
 * dependency and a `Row` still navigates client-side.
 */

export { Badge } from "./badge.tsx";
export { BackLink, DetailHeader } from "./detail-header.tsx";
export { EmptyState } from "./empty-state.tsx";
export { ErrorState } from "./error-state.tsx";
export { List, Row, type LinkComponent } from "./list.tsx";
export { Panel, PanelCount } from "./panel.tsx";
export { Stat, StatRow, Unmeasured } from "./stat.tsx";
export { ToneDot, Tooltip } from "./tone-dot.tsx";
export { cx, type Tone, type ToneInput } from "./tone.ts";
