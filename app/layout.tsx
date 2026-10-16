import type { ReactNode } from "react";

export const metadata = { title: "SCORM POC" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: 24, background: "#fafafa", color: "#111" }}>
        {children}
      </body>
    </html>
  );
}
