/**
 * A Node module-resolution hook that swaps a handful of modules for local test
 * doubles.
 *
 * The components under test import `next/link`, which resolves to something that
 * reads router context only a running Next server mounts. Rewriting the imports
 * for tests, or threading an injection prop through every component, would
 * change the production tree that the tests are supposed to be checking — so the
 * substitution happens at resolution time instead, and the components are
 * imported exactly as they ship.
 *
 * Two forms of substitution:
 *   - `specifiers`: an exact bare specifier (`next/link`) → stub URL.
 *   - `paths`: a fully resolved module URL → stub URL. This is how a first-party
 *     module is doubled regardless of how each importer spells the path.
 *
 * Registered from `setup.ts`; see that file for the map.
 *
 * NOTE: byte-identical to `apps/dashboard/src/testing/module-stubs.mjs`. It is
 * app-agnostic infrastructure and belongs in a shared testing package the moment
 * there is one to put it in.
 */

/** @type {Record<string, string>} */
let specifiers = {};
/** @type {Record<string, string>} */
let paths = {};

export function initialize(data) {
  specifiers = data.specifiers ?? {};
  paths = data.paths ?? {};
}

export async function resolve(specifier, context, nextResolve) {
  const direct = specifiers[specifier];
  // Re-resolve the replacement through the rest of the chain rather than
  // short-circuiting: the stubs are TypeScript, and it is the transpiler's own
  // resolve hook that tags them with a format Node can load.
  if (direct) {
    return nextResolve(direct, context);
  }
  const resolved = await nextResolve(specifier, context);
  const replacement = paths[resolved.url];
  if (replacement) {
    return nextResolve(replacement, context);
  }
  return resolved;
}
