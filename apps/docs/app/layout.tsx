import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { docGroups } from "../lib/docs";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Jina Documentation", template: "%s · Jina Documentation" },
  description: "Guides for onboarding, code reviews, Context Wiki, Causal Graph, integrations, and .jina configuration."
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  const dashboardUrl = process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "https://app.usejina.com";
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link className="wordmark" href="/">
            Jina <span>Docs</span>
          </Link>
          <nav aria-label="Documentation utilities">
            <a href={`${dashboardUrl}/reviews`}>Dashboard</a>
            <a href="https://github.com/omxyz/jina" target="_blank" rel="noreferrer">
              GitHub
            </a>
          </nav>
        </header>
        <div className="docs-layout">
          <aside className="docs-sidebar">
            {docGroups.map(({ group, docs }) => (
              <section key={group}>
                <h2>{group}</h2>
                {docs.map((doc) => (
                  <Link key={doc.slug} href={`/${doc.slug}`}>
                    {doc.title}
                  </Link>
                ))}
              </section>
            ))}
          </aside>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
