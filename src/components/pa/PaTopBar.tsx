"use client";

import Link from "next/link";

async function signOut() {
  await fetch("/api/auth/signout", { method: "POST" }).catch(() => {});
  window.location.href = "/pa/login";
}

/** 頂列:品牌、麵包屑、目前使用者(帳號設定、登出)。 */
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
            <Link href="/pa/account" title="改密碼、登出所有裝置">
              {me?.name ?? "帳號"}
            </Link>
            <button className="btn btn-ghost btn-sm" onClick={signOut}>
              登出
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
