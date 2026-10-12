import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NEON LAB | Trading Control",
  description: "NEON LAB Command Center dengan autentikasi Supabase, kontrol workspace, dan dashboard fixture.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
