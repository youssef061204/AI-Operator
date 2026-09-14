import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "AI Operator — Local Tasks",
  description:
    "Run local tasks with explicit verification, action approvals, and recorded execution evidence.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
