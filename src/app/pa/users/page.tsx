"use client";

// 使用者與角色(只有系統管理員):改角色(例如 PM Head 看得到所有專案)、停用帳號。
// 帳號是自行註冊或從舊系統匯入的;匯入的還沒設密碼,要本人用「忘記密碼」收信設定。

import { useEffect, useState } from "react";
import PaPage from "@/components/pa/PaPage";
import PaTopBar from "@/components/pa/PaTopBar";
import { api } from "@/lib/paClient";

interface Row {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: number;
  created_at: string;
  no_password: number;
  last_login: string | null;
}

const ROLE_LABEL: Record<string, string> = {
  admin: "系統管理員",
  pm_head: "PM Head（看所有專案）",
  pm_leader: "PM Leader",
  pm: "PM",
  user: "一般使用者",
  trial: "試用者",
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("zh-TW", { hour12: false }) : "—");

function Users() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = () =>
    api<{ users: Row[]; roles: string[] }>("/api/pa/admin/users").then(
      (r) => {
        setRows(r.users);
        setRoles(r.roles);
      },
      (e) => setError(e instanceof Error ? e.message : String(e))
    );
  useEffect(() => {
    load();
  }, []);

  async function patch(r: Row, change: { role?: string; is_active?: boolean }) {
    setBusyId(r.id);
    setError(null);
    try {
      await api("/api/pa/admin/users", { method: "PATCH", json: { id: r.id, ...change } });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PaTopBar crumb="使用者與角色" />
      <main className="page">
        <h1>使用者與角色</h1>
        <p className="lede">
          新同事自己到登入頁「註冊新帳號」，預設是一般使用者，再由專案 PM 加進專案。
          標「尚未設定密碼」的是從舊系統搬來的帳號，請本人到登入頁按「忘記密碼／第一次登入」收信設定。
        </p>
        {error && <div className="err">{error}</div>}
        {!rows ? (
          <div className="muted">載入中…</div>
        ) : (
          <div className="card userscroll">
            <table className="usertable">
              <thead>
                <tr>
                  <th>姓名</th>
                  <th>電子郵件</th>
                  <th>角色</th>
                  <th>最近登入</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.is_active ? "" : "off"}>
                    <td>
                      {r.name || "—"}
                      {r.no_password ? <div className="nopw">尚未設定密碼</div> : null}
                    </td>
                    <td className="mono">{r.email}</td>
                    <td>
                      <select value={r.role} disabled={busyId === r.id} onChange={(e) => patch(r, { role: e.target.value })}>
                        {roles.map((x) => (
                          <option key={x} value={x}>
                            {ROLE_LABEL[x] ?? x}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="muted">{when(r.last_login)}</td>
                    <td>
                      <button
                        className={`btn btn-sm btn-ghost${r.is_active ? " btn-danger" : ""}`}
                        disabled={busyId === r.id}
                        onClick={() => {
                          if (r.is_active && !confirm(`停用 ${r.name || r.email}？他會立刻被登出、不能再登入。`)) return;
                          patch(r, { is_active: !r.is_active });
                        }}
                      >
                        {r.is_active ? "停用" : "啟用"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}

export default function UsersPage() {
  return (
    <PaPage>
      <Users />
    </PaPage>
  );
}
