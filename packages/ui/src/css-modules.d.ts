/**
 * CSS Modules are resolved by the consuming bundler (Next, via
 * `transpilePackages`) and by the test runner's loader hook. TypeScript needs to
 * be told the shape either of them hands back.
 *
 * The map is deliberately open rather than a generated per-file union: with
 * `noUncheckedIndexedAccess` a lookup is `string | undefined`, which is what
 * `cx()` is built to swallow, and a class that a stylesheet does not define
 * therefore drops out of the attribute instead of printing "undefined".
 */
declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
