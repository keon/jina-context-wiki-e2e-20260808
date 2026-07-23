import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AdminShell } from "../components/admin-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Jina Admin",
    template: "%s — Jina Admin"
  },
  description: "Global administration for Jina context graphs, generation history, and production health."
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AdminShell>{children}</AdminShell>
      </body>
    </html>
  );
}
