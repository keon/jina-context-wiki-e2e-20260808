import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AdminShell } from "./admin-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jina Admin — Repository Context",
  description: "Administrative view of immutable context releases and checkpoint health."
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
