import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ConnectionIndicator, PageNav } from "../components/chrome.tsx";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jina board"
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main className="shell">
          <header className="app-header">
            <div className="topbar">
              <div className="brand-lockup">
                <span className="brand-mark" aria-hidden="true">
                  J
                </span>
                <span className="brand-name">Jina</span>
              </div>
              <PageNav />
              <ConnectionIndicator apiLabel="Jina API" />
            </div>
          </header>
          {children}
        </main>
      </body>
    </html>
  );
}
