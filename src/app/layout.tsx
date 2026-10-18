import type { Metadata } from "next";
import { connection } from "next/server";

import { ToastProvider } from "@/components/ui/toast";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "A3E Accounting Platform", template: "%s · A3E" },
  description: "Accounting services platform (development build)",
  robots: { index: false, follow: false },
};

// Every page renders per request: the CSP nonce (src/proxy.ts) can only be
// applied to dynamically rendered pages, and every page here is per-user anyway.
export default async function RootLayout({ children }: LayoutProps<"/">) {
  await connection();
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
