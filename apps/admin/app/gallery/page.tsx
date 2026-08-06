import { notFound } from "next/navigation";

/**
 * The component gallery: every `@jina/ui` primitive, each of its tones and
 * variants, and the four states a data section can be in, rendered against the
 * real stylesheets — `@jina/theme`, this app's `globals.css`, and the CSS
 * Modules each primitive ships.
 *
 * It lives in admin rather than in the dashboard or a workspace of its own for
 * three reasons:
 *
 *   1. It has to render. The dashboard's shell returns nothing but its auth gate
 *      until Clerk reports `isLoaded && isSignedIn`, so with no credentials a
 *      dashboard route is a spinner and a browser cannot see a single component.
 *      Admin renders fully with no credentials, so Playwright can drive it.
 *   2. The styles have to be the real ones. A standalone gallery app would need
 *      its own copy of the reset, the tokens and the app-level rules, which is
 *      the same drift the shared theme package was created to end. Hosting the
 *      gallery inside a real app means it is styled by exactly what ships.
 *   3. One dev server then serves both browser suites.
 *
 * ## How it is kept out of production
 *
 * `NODE_ENV` is the same lever `proxy.ts` uses for the unauthenticated local
 * development path, and for the same reason: Next inlines it at build time, so
 * there is no runtime flag anyone can leave switched on. In a production build
 * the condition below folds to a constant, the route becomes a 404 in every
 * deployed image, and — because the two halves are an `if`/`else` rather than an
 * early return — the bundler can prove the specimens are unreachable and drops
 * them from both the server and the client graph. The route ships as a 404 and
 * the components it would have drawn ship as nothing at all.
 *
 * This is deliberately *not* a second auth bypass. `proxy.ts` guards this route
 * exactly like every other one; in a deployed image it is a 404 behind Basic
 * auth rather than a page behind Basic auth.
 */
export const metadata = { title: "Component gallery — Jina Admin" };

export default async function GalleryPage() {
  if (process.env.NODE_ENV === "production") {
    return notFound();
  } else {
    const { Gallery } = await import("./specimens");
    return <Gallery />;
  }
}
