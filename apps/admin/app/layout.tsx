import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { AdminShell } from "./admin-shell";
import "@jina/theme/theme.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jina Admin — Repository Context",
  description: "Administrative view of immutable context releases and checkpoint health."
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    // The same font variables the dashboard sets, so the two apps render in one
    // typeface instead of admin falling back to the system stack.
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <AdminShell>{children}</AdminShell>
      </body>
    </html>
  );
}
