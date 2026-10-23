import type { Metadata } from "next";
import "./pa.css";

export const metadata: Metadata = {
  title: "PA Tracker",
  description: "零件承認（Part Approval）追蹤：PM/RD、Sourcer、RD、QA 各自填寫進度，逾期自動提醒。",
};

/** PA 的樣式全部掛在 .pa-root 底下,免得跟甘特圖的 .btn/.card/.topbar 撞名。 */
export default function PaLayout({ children }: { children: React.ReactNode }) {
  return <div className="pa-root">{children}</div>;
}
