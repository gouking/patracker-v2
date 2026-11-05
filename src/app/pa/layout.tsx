import type { Metadata } from "next";
import "./pa.css";

export const metadata: Metadata = {
  title: "PA Tracker",
  description: "零件承認（Part Approval）追蹤：PM/RD、Sourcer、RD、QA 各自填寫進度，逾期自動提醒。",
};

/** 使用者選的背景(白／黑)與文字大小存在 localStorage;在畫面畫出來之前先套上,免得先閃一下預設的樣子。 */
const APPLY_DISPLAY = `(function(){try{var d=document.documentElement,t=localStorage.getItem("pa-theme");if(t==="light"||t==="dark")d.setAttribute("data-theme",t);var z=parseFloat(localStorage.getItem("pa-zoom"));if(z>=0.8&&z<=1.5)d.style.setProperty("--pa-zoom",String(z))}catch(e){}})()`;

/** PA 的樣式全部掛在 .pa-root 底下,免得跟甘特圖的 .btn/.card/.topbar 撞名。 */
export default function PaLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: APPLY_DISPLAY }} />
      <div className="pa-root">{children}</div>
    </>
  );
}
