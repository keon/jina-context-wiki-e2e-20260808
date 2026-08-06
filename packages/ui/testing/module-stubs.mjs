/**
 * A Node module-resolution hook that swaps a handful of modules for local test
 * doubles, and gives CSS Modules something a Node loader can actually evaluate.
 *
 * The components under test import `next/link`, `next/navigation` and
 * `@clerk/nextjs`, none of which resolve to anything renderable outside a
 * running Next server (they read router/auth context that only the framework
 * mounts). Rewriting the imports for tests, or threading an injection prop
 * through every component, would change the production tree that the tests are
 * supposed to be checking — so the substitution happens at resolution time
 * instead, and the components are imported exactly as they ship.
 *
 * Two forms of substitution:
 *   - `specifiers`: an exact bare specifier (`next/link`) → stub URL.
 *   - `paths`: a fully resolved module URL → stub URL. This is how a first-party
 *     module is doubled regardless of how each importer spells the path
 *     (`../providers` and `../../dashboard/providers.tsx` resolve to one URL).
 *
 * Registered from each app's `setup.ts`; see those files for the maps.
 */

/**
 * A stylesheet import, answered as an identity map: `styles.badge` is the string
 * `"badge"`.
 *
 * The bundler hashes these names in a real build, so a test cannot hard-code
 * one; it reads the same `styles` object the component does. The identity
 * mapping keeps the failure messages legible without pretending to reproduce
 * the hash. `then` is excluded so the namespace is never mistaken for a
 * thenable, and symbol keys fall through so `util.inspect` and friends behave.
 */
const CSS_MODULE_SOURCE = `const classes = new Proxy(
  {},
  {
    get(_target, key) {
      if (typeof key !== "string" || key === "then" || key === "__esModule") return undefined;
      return key;
    }
  }
);
export default classes;
`;

const isStylesheet = (value) => value.endsWith(".css") || value.includes(".css?");

/** @type {Record<string, string>} */
let specifiers = {};
/** @type {Record<string, string>} */
let paths = {};

export function initialize(data) {
  specifiers = data.specifiers ?? {};
  paths = data.paths ?? {};
}

export async function resolve(specifier, context, nextResolve) {
  // Node has no loader for `.css`, and its default resolver would reject the
  // extension before `load` ever runs — so the format is declared here.
  if (isStylesheet(specifier)) {
    const url = specifier.startsWith(".")
      ? new URL(specifier, context.parentURL).href
      : (await nextResolve(specifier, context)).url;
    return { url, format: "module", shortCircuit: true };
  }
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

export async function load(url, context, nextLoad) {
  if (isStylesheet(url)) {
    return { format: "module", source: CSS_MODULE_SOURCE, shortCircuit: true };
  }
  return nextLoad(url, context);
}
