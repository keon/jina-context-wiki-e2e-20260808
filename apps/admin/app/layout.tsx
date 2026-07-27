import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jina Admin — Repository Context",
  description: "Administrative view of context index generations and knowledge health."
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
            <span className="scope-badge">All context</span>
            <span className="spacer" />
            <span className="muted">tenant-admin view</span>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
