/**
 * URLs of the test doubles this package hosts, for an app's `setup.ts` to hand
 * to the module-resolution hook.
 *
 * They are URLs rather than modules on purpose: the hook substitutes at resolve
 * time, before anything is evaluated, so what it needs is a specifier — and it
 * has to be resolved relative to *this* file, not to whichever app is asking.
 */
export const NEXT_LINK_STUB = new URL("./next-link.tsx", import.meta.url).href;
