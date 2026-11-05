import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PA Tracker",
  description: "零件承認（Part Approval）追蹤：PM/RD、Sourcer、RD、QA 各自填寫進度，逾期自動提醒。",
  applicationName: "PA Tracker",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
