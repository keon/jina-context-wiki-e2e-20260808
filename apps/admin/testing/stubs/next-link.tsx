import type { AnchorHTMLAttributes, ReactNode } from "react";

/**
 * Stands in for `next/link`, which reads the app router context that only a
 * running Next server mounts. A link is an anchor with an href, which is all
 * any assertion here needs and all the surrounding layout sees.
 *
 * NOTE: byte-identical to `apps/dashboard/src/testing/stubs/next-link.tsx`.
 */
export default function Link({
  href,
  children,
  ...rest
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  readonly href: string | { readonly pathname?: string };
  readonly children?: ReactNode;
}) {
  return (
    <a {...rest} href={typeof href === "string" ? href : (href.pathname ?? "#")}>
      {children}
    </a>
  );
}
