"use client";

import Link from "next/link";

/** 頂列:回 Trackly、品牌、麵包屑、目前使用者。 */
export default function PaTopBar({
  me,
  crumb,
  roles,
  children,
}: {
  me?: { name: string; isAdmin: boolean } | null;
  crumb?: React.ReactNode;
  roles?: string[];
  children?: React.ReactNode;
}) {
  return (
    <div className="topbar">
      <div className="topbar-row">
        {/* 放最左邊:離「上一層」的直覺位置最近,也不會跟右邊的操作按鈕擠在一起 */}
        <a className="btn btn-ghost btn-sm backlink" href="/api/trackly-home" title="回 Trackly" aria-label="回 Trackly">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 7.2 8 2.2l6 5" />
            <path d="M3.4 6.6V13.3h9.2V6.6" />
            <path d="M6.6 13.3V9.4h2.8v3.9" />
          </svg>
        </a>
        <Link href="/pa" className="wordmark">
          <span className="mark" />
          <b>PA Tracker</b>
        </Link>
        {crumb && <div className="crumb">/ {crumb}</div>}
        <div className="topbar-tail">
          {children}
          <div className="whoami">
            {me?.isAdmin && <span className="rolebadge">Admin</span>}
            {roles?.map((r) => (
              <span key={r} className="rolebadge">
                {r}
              </span>
            ))}
            <span>{me?.name}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
