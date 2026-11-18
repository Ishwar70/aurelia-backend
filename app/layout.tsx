import type { ReactNode } from "react";

export const metadata = {
  title: "AURELIA API",
  description: "Commerce API for the AURELIA storefront.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#171717", color: "#FCFAF7", fontFamily: "Georgia, serif" }}>{children}</body>
    </html>
  );
}
