import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jina Admin — Context Graphs",
  description: "Administrative view of every generated context graph across all repositories."
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="masthead">
            <h1>
              <Link href="/">Jina Admin</Link>
            </h1>
            <span className="scope-badge">All graphs</span>
            <span className="spacer" />
            <span className="muted">tenant-admin view</span>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
