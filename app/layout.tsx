import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BillDesk",
  description: "BillDesk — Think before you print.",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: "#eb0a1e",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
