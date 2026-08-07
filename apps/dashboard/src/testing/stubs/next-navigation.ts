/**
 * Stands in for `next/navigation`. The real hooks throw outside a Next render,
 * so tests set the route they want to be on and read back what a component
 * asked the router to do.
 */

export interface RouterCall {
  readonly method: "push" | "replace" | "refresh" | "back" | "forward" | "prefetch";
  readonly href?: string;
}

let pathname = "/";
let searchParams = new URLSearchParams();
const calls: RouterCall[] = [];

/** Sets the route the stubbed hooks report, and clears the recorded calls. */
export function setRoute(nextPathname: string, query = ""): void {
  pathname = nextPathname;
  searchParams = new URLSearchParams(query);
  calls.length = 0;
}

/** Everything a component asked the router to do since the last `setRoute`. */
export function routerCalls(): readonly RouterCall[] {
  return calls;
}

export function usePathname(): string {
  return pathname;
}

export function useSearchParams(): URLSearchParams {
  return searchParams;
}

export function useParams(): Record<string, string> {
  return {};
}

export function useRouter() {
  return {
    push: (href: string) => calls.push({ method: "push", href }),
    replace: (href: string) => calls.push({ method: "replace", href }),
    refresh: () => calls.push({ method: "refresh" }),
    back: () => calls.push({ method: "back" }),
    forward: () => calls.push({ method: "forward" }),
    prefetch: (href: string) => calls.push({ method: "prefetch", href })
  };
}

export function redirect(href: string): never {
  throw new Error(`redirect(${href})`);
}

export function notFound(): never {
  throw new Error("notFound()");
}
